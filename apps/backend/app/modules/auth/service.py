import logging
import uuid
from datetime import timedelta
from typing import cast

from redis.asyncio import Redis
from redis.exceptions import RedisError
from sqlalchemy import or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.errors import AppError
from app.core.security import (
    DUMMY_HASH,
    create_access_token,
    hash_password,
    hash_token,
    new_refresh_token,
    utcnow,
    verify_password,
)
from app.modules.audit import service as audit
from app.modules.audit.service import AuditCtx
from app.modules.auth.deps import AuthContext
from app.modules.auth.models import AuthSession, RefreshToken
from app.modules.auth.permissions import WEB_ACCESS
from app.modules.auth.schemas import (
    ChangePasswordRequest,
    Client,
    DeviceInfo,
    DeviceStatus,
    LoginRequest,
    MeDevice,
    MeResponse,
    TokenResponse,
)
from app.modules.devices.models import (
    DEVICE_ACTIVE,
    DEVICE_PENDING,
    DEVICE_REVOKED,
    UserDevice,
)
from app.modules.employees.models import STATUS_ACTIVE, User
from app.modules.employees.schemas import Ref, normalize_mobile
from app.modules.sessions.user_agent import parse_user_agent

logger = logging.getLogger(__name__)


def _invalid_credentials() -> AppError:
    # One message for unknown user, wrong password, inactive account and no web access.
    return AppError("INVALID_CREDENTIALS", "Invalid employee ID or password.", 401)


def _invalid_refresh() -> AppError:
    return AppError("INVALID_TOKEN", "Your session has expired. Sign in again.", 401)


async def revoke_tokens(
    session: AsyncSession,
    *,
    user_id: int | None = None,
    device_row_id: int | None = None,
    family_id: uuid.UUID | None = None,
    reason: str,
) -> None:
    """Revoke every live refresh token matching the filters and end their sessions.

    `reason` is recorded on the ended sessions. The caller commits.
    """
    now = utcnow()
    tokens = update(RefreshToken).where(RefreshToken.revoked_at.is_(None)).values(revoked_at=now)
    ended = (
        update(AuthSession)
        .where(AuthSession.ended_at.is_(None))
        .values(ended_at=now, end_reason=reason)
    )
    if user_id is not None:
        tokens = tokens.where(RefreshToken.user_id == user_id)
        ended = ended.where(AuthSession.user_id == user_id)
    if device_row_id is not None:
        tokens = tokens.where(RefreshToken.device_row_id == device_row_id)
        ended = ended.where(AuthSession.device_row_id == device_row_id)
    if family_id is not None:
        tokens = tokens.where(RefreshToken.family_id == family_id)
        ended = ended.where(AuthSession.family_id == family_id)
    await session.execute(tokens)
    await session.execute(ended)


async def _check_ip_limit(redis: Redis, settings: Settings, ip: str | None) -> None:
    """Fixed-window limit on login attempts per IP, on top of the per-account lockout."""
    window = settings.login_ip_window_minutes * 60
    key = f"rl:login:{ip or 'unknown'}"
    try:
        async with redis.pipeline(transaction=True) as pipe:
            pipe.incr(key)
            pipe.expire(key, window, nx=True)  # nx: never extend the window of a hot key
            pipe.ttl(key)
            count, _, ttl = await pipe.execute()
    except RedisError:
        # Fail open: an outage must not lock everyone out; the per-account lockout still holds.
        logger.exception("Login rate limiter unavailable")
        return
    if count > settings.login_ip_limit:
        raise AppError(
            "RATE_LIMITED",
            "Too many sign-in attempts. Try again later.",
            429,
            {"retry_after_seconds": max(int(ttl), 1)},
        )


async def _find_user(session: AsyncSession, identifier: str) -> User | None:
    code = identifier.upper()
    try:
        mobile = normalize_mobile(identifier)
    except ValueError:
        mobile = None
    stmt = select(User).where(or_(User.emp_code == code, User.mobile == mobile))
    # An employee code beats a mobile number that happens to look the same.
    stmt = stmt.order_by((User.emp_code == code).desc()).limit(1)
    return (await session.execute(stmt)).scalar_one_or_none()


async def register_failure(
    session: AsyncSession, settings: Settings, user_id: int, ctx: AuditCtx, action: str
) -> None:
    """Count a bad password atomically; lock the account at the configured limit."""
    attempts = (
        await session.execute(
            update(User)
            .where(User.id == user_id)
            .values(failed_attempts=User.failed_attempts + 1)
            .returning(User.failed_attempts)
        )
    ).scalar_one()
    audit.record(session, ctx, action, "user", user_id)
    if attempts >= settings.login_max_failures:
        until = utcnow() + timedelta(minutes=settings.login_lock_minutes)
        await session.execute(
            update(User).where(User.id == user_id).values(failed_attempts=0, locked_until=until)
        )
        audit.record(
            session, ctx, "auth.account_locked", "user", user_id, after={"until": str(until)}
        )
    await session.commit()


async def phone_holder_id(session: AsyncSession, device_id: str, user_id: int) -> int | None:
    """The other employee this phone is active for, if any (at most one: unique index)."""
    return (
        await session.execute(
            select(UserDevice.user_id).where(
                UserDevice.device_id == device_id,
                UserDevice.user_id != user_id,
                UserDevice.status == DEVICE_ACTIVE,
            )
        )
    ).scalar_one_or_none()


async def _bind_device(
    session: AsyncSession, user: User, info: DeviceInfo, ctx: AuditCtx, *, retry: bool = True
) -> UserDevice:
    """First device is active at once; any other phone waits as a pending change request.

    A phone that is active for another employee always waits too: one phone, one employee.
    """
    current = (
        await session.execute(
            select(UserDevice).where(
                UserDevice.user_id == user.id,
                UserDevice.device_id == info.device_id,
                UserDevice.status.in_([DEVICE_ACTIVE, DEVICE_PENDING]),
            )
        )
    ).scalar_one_or_none()
    if current is not None:
        current.model, current.os, current.app_version = info.model, info.os, info.app_version
        current.last_seen_at = utcnow()
        return current

    has_active = (
        await session.execute(
            select(UserDevice.id).where(
                UserDevice.user_id == user.id, UserDevice.status == DEVICE_ACTIVE
            )
        )
    ).first()
    holder_id = await phone_holder_id(session, info.device_id, user.id)
    status = DEVICE_PENDING if has_active or holder_id is not None else DEVICE_ACTIVE
    if status == DEVICE_PENDING:
        # A newer request replaces an older pending one.
        stale = (
            (
                await session.execute(
                    select(UserDevice.id).where(
                        UserDevice.user_id == user.id, UserDevice.status == DEVICE_PENDING
                    )
                )
            )
            .scalars()
            .all()
        )
        for device_id in stale:
            await session.execute(
                update(UserDevice).where(UserDevice.id == device_id).values(status=DEVICE_REVOKED)
            )
            await revoke_tokens(session, device_row_id=device_id, reason="device_replaced")
    device = UserDevice(
        user_id=user.id,
        device_id=info.device_id,
        model=info.model,
        os=info.os,
        app_version=info.app_version,
        status=status,
        last_seen_at=utcnow(),
    )
    try:
        async with session.begin_nested():
            session.add(device)
            await session.flush()
    except IntegrityError:
        # Lost a race for the phone (or for this account's one active/pending slot): the unique
        # indexes held. Decide again on what is stored now.
        if not retry:
            raise
        return await _bind_device(session, user, info, ctx, retry=False)
    action = "device.registered" if status == DEVICE_ACTIVE else "device.change_requested"
    after: dict[str, object] = {"status": status}
    if holder_id is not None:
        after |= {"reason": "phone_in_use", "conflict_user_id": holder_id}
    audit.record(session, ctx, action, "user_device", device.id, after=after)
    return device


async def _issue_tokens(
    session: AsyncSession,
    settings: Settings,
    user: User,
    client: str,
    device: UserDevice | None,
    family_id: uuid.UUID | None = None,
    *,
    ip: str | None,
    user_agent: str | None,
) -> TokenResponse:
    """Issue a token pair. Without `family_id` this is a new sign-in and starts a session."""
    token, token_hash = new_refresh_token()
    now = utcnow()
    expires_at = now + timedelta(days=settings.refresh_token_days)
    device_row_id = None if device is None else device.id
    if family_id is None:
        family_id = uuid.uuid4()
        browser, os = parse_user_agent(user_agent)
        session.add(
            AuthSession(
                family_id=family_id,
                user_id=user.id,
                client=client,
                device_row_id=device_row_id,
                user_agent=None if user_agent is None else user_agent[:512],
                browser=browser,
                os=os,
                ip=ip,
                last_seen_at=now,
                expires_at=expires_at,
            )
        )
    else:
        await session.execute(
            update(AuthSession)
            .where(AuthSession.family_id == family_id)
            .values(last_seen_at=now, expires_at=expires_at, ip=ip)
        )
    session.add(
        RefreshToken(
            user_id=user.id,
            device_row_id=device_row_id,
            family_id=family_id,
            token_hash=token_hash,
            client=client,
            expires_at=expires_at,
        )
    )
    access, lifetime = create_access_token(
        settings,
        user_id=user.id,
        device_row_id=device_row_id,
        client=client,
        session_id=str(family_id),
    )
    return TokenResponse(
        access_token=access,
        refresh_token=token,
        expires_in=lifetime,
        must_change_password=user.must_change_password,
        device_status=None if device is None else cast(DeviceStatus, device.status),
    )


async def login(
    session: AsyncSession,
    redis: Redis,
    settings: Settings,
    body: LoginRequest,
    ip: str | None,
    user_agent: str | None = None,
) -> TokenResponse:
    await _check_ip_limit(redis, settings, ip)
    user = await _find_user(session, body.identifier)
    if user is None or user.status != STATUS_ACTIVE:
        await verify_password(DUMMY_HASH, body.password)
        raise _invalid_credentials()

    ctx = AuditCtx(user.id, ip)
    now = utcnow()
    if user.locked_until is not None and user.locked_until > now:
        raise AppError(
            "ACCOUNT_LOCKED",
            "Too many failed attempts. Try again later or ask your admin to unlock the account.",
            429,
            {"retry_after_seconds": int((user.locked_until - now).total_seconds()) + 1},
        )
    if not await verify_password(user.password_hash, body.password):
        await register_failure(session, settings, user.id, ctx, "auth.login_failed")
        raise _invalid_credentials()
    if body.client == "web" and WEB_ACCESS not in user.role.permissions:
        audit.record(session, ctx, "auth.login_denied", "user", user.id, after={"reason": "web"})
        await session.commit()
        raise _invalid_credentials()

    user.failed_attempts = 0
    user.locked_until = None
    device = None if body.device is None else await _bind_device(session, user, body.device, ctx)
    tokens = await _issue_tokens(
        session, settings, user, body.client, device, ip=ip, user_agent=user_agent
    )
    audit.record(session, ctx, "auth.login", "user", user.id, after={"client": body.client})
    await session.commit()
    return tokens


async def refresh(
    session: AsyncSession,
    settings: Settings,
    refresh_token: str,
    ip: str | None,
    user_agent: str | None = None,
) -> TokenResponse:
    row = (
        await session.execute(
            select(RefreshToken)
            .where(RefreshToken.token_hash == hash_token(refresh_token))
            .with_for_update()
        )
    ).scalar_one_or_none()
    if row is None:
        raise _invalid_refresh()
    ctx = AuditCtx(row.user_id, ip)
    if row.revoked_at is not None:
        # A rotated token came back: someone holds a stolen copy. Kill the whole login.
        await revoke_tokens(session, family_id=row.family_id, reason="token_reuse")
        audit.record(session, ctx, "auth.refresh_reuse", "user", row.user_id)
        await session.commit()
        raise _invalid_refresh()
    user = await session.get(User, row.user_id)
    device = None if row.device_row_id is None else await session.get(UserDevice, row.device_row_id)
    if (
        row.expires_at <= utcnow()
        or user is None
        or user.status != STATUS_ACTIVE
        or (device is not None and device.status == DEVICE_REVOKED)
    ):
        raise _invalid_refresh()
    row.revoked_at = utcnow()
    if device is not None:
        device.last_seen_at = row.revoked_at
    tokens = await _issue_tokens(
        session, settings, user, row.client, device, row.family_id, ip=ip, user_agent=user_agent
    )
    await session.commit()
    return tokens


async def logout(session: AsyncSession, refresh_token: str, ip: str | None) -> None:
    row = (
        await session.execute(
            select(RefreshToken).where(RefreshToken.token_hash == hash_token(refresh_token))
        )
    ).scalar_one_or_none()
    if row is None:
        return
    await revoke_tokens(session, family_id=row.family_id, reason="signed_out")
    audit.record(session, AuditCtx(row.user_id, ip), "auth.logout", "user", row.user_id)
    await session.commit()


async def change_password(
    session: AsyncSession,
    settings: Settings,
    auth: AuthContext,
    body: ChangePasswordRequest,
    audit_ctx: AuditCtx,
    user_agent: str | None = None,
) -> TokenResponse:
    user = auth.user
    if not await verify_password(user.password_hash, body.current_password):
        # A stolen access token must not allow unlimited guessing of the current password.
        await register_failure(session, settings, user.id, audit_ctx, "auth.password_change_failed")
        raise AppError("INVALID_CURRENT_PASSWORD", "The current password is incorrect.", 400)
    if body.new_password == body.current_password:
        raise AppError(
            "PASSWORD_UNCHANGED", "Choose a password different from the current one.", 400
        )
    user.password_hash = await hash_password(body.new_password)
    user.must_change_password = False
    await revoke_tokens(session, user_id=user.id, reason="password_changed")
    device = (
        None if auth.device_row_id is None else await session.get(UserDevice, auth.device_row_id)
    )
    tokens = await _issue_tokens(
        session, settings, user, auth.client, device, ip=audit_ctx.ip, user_agent=user_agent
    )
    audit.record(session, audit_ctx, "auth.password_changed", "user", user.id)
    await session.commit()
    return tokens


async def build_me(session: AsyncSession, auth: AuthContext) -> MeResponse:
    user = auth.user
    device = (
        None if auth.device_row_id is None else await session.get(UserDevice, auth.device_row_id)
    )
    return MeResponse(
        id=user.id,
        emp_code=user.emp_code,
        name=user.name,
        mobile=user.mobile,
        email=user.email,
        role=Ref.model_validate(user.role),
        permissions=sorted(auth.permissions),
        designation=Ref.model_validate(user.designation),
        department=None if user.department is None else Ref.model_validate(user.department),
        manager_id=user.manager_id,
        field_eligible=user.field_eligible,
        must_change_password=user.must_change_password,
        client=cast(Client, auth.client),
        device=None
        if device is None
        else MeDevice(
            id=device.id,
            status=cast(DeviceStatus, device.status),
            pending_reason="phone_in_use"
            if device.status == DEVICE_PENDING
            and await phone_holder_id(session, device.device_id, user.id) is not None
            else None,
        ),
    )
