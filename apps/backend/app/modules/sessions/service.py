from datetime import datetime, timedelta
from typing import cast

from sqlalchemy import ColumnElement, Select, and_, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.core.os_name import format_os
from app.core.security import utcnow
from app.modules.audit import service as audit
from app.modules.audit.service import AuditCtx
from app.modules.auth.deps import AuthContext
from app.modules.auth.models import AuthSession, RefreshToken
from app.modules.auth.schemas import Client
from app.modules.auth.service import revoke_tokens
from app.modules.devices.models import UserDevice
from app.modules.employees.models import User
from app.modules.employees.service import ensure_can_manage, parse_cursor
from app.modules.sessions.schemas import SessionCounts, SessionOut, SessionPage, SessionStatus

END_EXPIRED = "expired"


def _is_active(now: datetime) -> ColumnElement[bool]:
    return and_(AuthSession.ended_at.is_(None), AuthSession.expires_at > now)


def _out(
    row: AuthSession, user: User, device: UserDevice | None, now: datetime, current: str | None
) -> SessionOut:
    expired = row.ended_at is None and row.expires_at <= now
    return SessionOut(
        id=row.id,
        user_id=user.id,
        emp_code=user.emp_code,
        user_name=user.name,
        client=cast(Client, row.client),
        browser=row.browser,
        os=row.os if device is None else format_os(device.os),
        device_model=None if device is None else device.model,
        ip=row.ip,
        created_at=row.created_at,
        last_seen_at=row.last_seen_at,
        status="ended" if row.ended_at is not None or expired else "active",
        ended_at=row.expires_at if expired else row.ended_at,
        end_reason=END_EXPIRED if expired else row.end_reason,
        current=current is not None and str(row.family_id) == current,
    )


def _select() -> Select[AuthSession, User, UserDevice]:
    return (
        select(AuthSession, User, UserDevice)
        .join(User, User.id == AuthSession.user_id)
        .outerjoin(UserDevice, UserDevice.id == AuthSession.device_row_id)
        .order_by(AuthSession.id.desc())  # newest first
    )


async def list_sessions(
    session: AsyncSession,
    auth: AuthContext,
    *,
    status: SessionStatus | None,
    client: str | None,
    user_id: int | None,
    limit: int,
    cursor: str | None,
) -> SessionPage:
    now = utcnow()
    stmt = _select().limit(limit + 1)
    if cursor is not None:
        stmt = stmt.where(AuthSession.id < parse_cursor(cursor))
    if status == "active":
        stmt = stmt.where(_is_active(now))
    elif status == "ended":
        stmt = stmt.where(~_is_active(now))
    if client:
        stmt = stmt.where(AuthSession.client == client)
    if user_id:
        stmt = stmt.where(AuthSession.user_id == user_id)
    rows = (await session.execute(stmt)).all()
    active, total = (
        await session.execute(select(func.count().filter(_is_active(now)), func.count()))
    ).one()
    return SessionPage(
        items=[_out(s, u, d, now, auth.session_id) for s, u, d in rows[:limit]],
        counts=SessionCounts(active=active, ended=total - active),
        next_cursor=str(rows[limit - 1][0].id) if len(rows) > limit else None,
    )


async def revoke(
    session: AsyncSession, actor: AuthContext, ctx: AuditCtx, session_id: int
) -> SessionOut:
    """Sign one session out: its refresh tokens stop working at once."""
    found = (await session.execute(_select().where(AuthSession.id == session_id))).first()
    if found is None:
        raise AppError("NOT_FOUND", "Session not found.", 404)
    row, user, device = found
    ensure_can_manage(actor, user)
    now = utcnow()
    if row.ended_at is not None or row.expires_at <= now:
        raise AppError("CONFLICT", "The session has already ended.", 409)
    await revoke_tokens(session, family_id=row.family_id, reason="revoked_by_admin")
    audit.record(
        session,
        ctx,
        "session.revoked",
        "auth_session",
        row.id,
        after={"user_id": user.id, "client": row.client},
    )
    await session.commit()
    await session.refresh(row)
    return _out(row, user, device, now, actor.session_id)


async def list_own(session: AsyncSession, auth: AuthContext) -> list[SessionOut]:
    """The signed-in user's live sessions, newest first."""
    now = utcnow()
    rows = (
        await session.execute(
            _select().where(AuthSession.user_id == auth.user.id, _is_active(now)).limit(50)
        )
    ).all()
    return [_out(s, u, d, now, auth.session_id) for s, u, d in rows]


async def revoke_others(session: AsyncSession, auth: AuthContext, ctx: AuditCtx) -> int:
    """Sign the user out everywhere except the session making this request."""
    if auth.session_id is None:
        # A token from before sessions existed cannot say which session to keep.
        raise AppError("CONFLICT", "Sign in again to manage your sessions.", 409)
    families = (
        (
            await session.execute(
                select(AuthSession.family_id).where(
                    AuthSession.user_id == auth.user.id,
                    AuthSession.ended_at.is_(None),
                    AuthSession.family_id != auth.session_id,
                )
            )
        )
        .scalars()
        .all()
    )
    for family_id in families:
        await revoke_tokens(session, family_id=family_id, reason="signed_out_elsewhere")
    if families:
        audit.record(
            session,
            ctx,
            "session.revoked_others",
            "user",
            auth.user.id,
            after={"count": len(families)},
        )
    await session.commit()
    return len(families)


async def purge_ended(session: AsyncSession, retention_days: int) -> int:
    """Delete sessions (and their refresh tokens) that ended more than `retention_days` ago."""
    cutoff = utcnow() - timedelta(days=retention_days)
    old = or_(
        AuthSession.ended_at < cutoff,
        and_(AuthSession.ended_at.is_(None), AuthSession.expires_at < cutoff),
    )
    await session.execute(
        delete(RefreshToken).where(
            RefreshToken.family_id.in_(select(AuthSession.family_id).where(old))
        )
    )
    deleted = (
        await session.execute(delete(AuthSession).where(old).returning(AuthSession.id))
    ).all()
    await session.commit()
    return len(deleted)
