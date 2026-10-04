from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.core.errors import AppError
from app.core.security import decode_access_token
from app.modules.audit.service import AuditCtx
from app.modules.auth.models import AuthSession
from app.modules.devices.models import DEVICE_ACTIVE, UserDevice
from app.modules.employees.models import STATUS_ACTIVE, User

_bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class AuthContext:
    user: User
    permissions: frozenset[str]
    device_row_id: int | None
    client: str
    # The sign-in (refresh-token family) this token belongs to.
    session_id: str
    # False only for a phone whose approval was revoked: it may still read /me to learn why.
    session_live: bool = True

    def audit(self, request: Request) -> AuditCtx:
        device = None if self.device_row_id is None else str(self.device_row_id)
        return AuditCtx.from_request(request, self.user.id, device)


# A phone whose approval was revoked keeps reading /me, which is how it learns that it was revoked
# (the app then shows "no longer approved"); every other endpoint refuses it like any ended session.
_PHONE_REVOKED = frozenset({"device_revoked", "device_replaced"})


def _expired() -> AppError:
    return AppError("INVALID_TOKEN", "Your session has expired. Sign in again.", 401)


async def current_user(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AuthContext:
    """Valid token for an active user. Does not require the first-login password change."""
    if credentials is None:
        raise AppError("UNAUTHENTICATED", "Sign in to continue.", 401)
    claims = decode_access_token(request.app.state.settings, credentials.credentials)
    if claims is None:
        raise _expired()
    # A signed-out session must stop working at once, not when its access token runs out. The
    # session is read in the same statement as the user, so this costs no extra round trip.
    row = (
        await session.execute(
            select(User, AuthSession.ended_at, AuthSession.end_reason)
            .join(AuthSession, AuthSession.user_id == User.id)
            .where(User.id == int(claims["sub"]), AuthSession.family_id == claims.get("sid"))
        )
    ).first()
    if row is None or row.User.status != STATUS_ACTIVE:
        raise _expired()
    live = row.ended_at is None
    if not live and row.end_reason not in _PHONE_REVOKED:
        raise _expired()
    return AuthContext(
        user=row.User,
        permissions=frozenset(row.User.role.permissions),
        device_row_id=claims.get("dev"),
        client=claims["cli"],
        session_id=claims["sid"],
        session_live=live,
    )


async def authenticated(
    ctx: Annotated[AuthContext, Depends(current_user)],
) -> AuthContext:
    """Like current_user, but blocks everything until the temporary password is changed."""
    if not ctx.session_live:
        raise _expired()
    if ctx.user.must_change_password:
        raise AppError("PASSWORD_CHANGE_REQUIRED", "Change your password to continue.", 403)
    return ctx


def require_permission(*permissions: str) -> Callable[..., Awaitable[AuthContext]]:
    async def dependency(ctx: Annotated[AuthContext, Depends(authenticated)]) -> AuthContext:
        if not set(permissions) <= ctx.permissions:
            raise AppError("FORBIDDEN", "You do not have permission to do this.", 403)
        return ctx

    return dependency


def require_any_permission(*permissions: str) -> Callable[..., Awaitable[AuthContext]]:
    """For helpers shared by several admin screens: holding one of the permissions is enough."""

    async def dependency(ctx: Annotated[AuthContext, Depends(authenticated)]) -> AuthContext:
        if not set(permissions) & ctx.permissions:
            raise AppError("FORBIDDEN", "You do not have permission to do this.", 403)
        return ctx

    return dependency


async def require_active_device(
    ctx: Annotated[AuthContext, Depends(authenticated)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AuthContext:
    """For actions that must come from the approved phone (punches from M4 on)."""
    device = None if ctx.device_row_id is None else await session.get(UserDevice, ctx.device_row_id)
    if device is None or device.user_id != ctx.user.id or device.status != DEVICE_ACTIVE:
        raise AppError(
            "DEVICE_NOT_APPROVED",
            "This phone is not approved yet. Ask your admin to approve it.",
            403,
        )
    return ctx
