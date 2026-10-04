from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.core.errors import AppError
from app.core.security import decode_access_token
from app.modules.audit.service import AuditCtx
from app.modules.devices.models import DEVICE_ACTIVE, UserDevice
from app.modules.employees.models import STATUS_ACTIVE, User

_bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class AuthContext:
    user: User
    permissions: frozenset[str]
    device_row_id: int | None
    client: str
    # The sign-in this token belongs to; None only for tokens issued before sessions existed.
    session_id: str | None = None

    def audit(self, request: Request) -> AuditCtx:
        device = None if self.device_row_id is None else str(self.device_row_id)
        return AuditCtx.from_request(request, self.user.id, device)


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
        raise AppError("INVALID_TOKEN", "Your session has expired. Sign in again.", 401)
    user = await session.get(User, int(claims["sub"]))
    if user is None or user.status != STATUS_ACTIVE:
        raise AppError("INVALID_TOKEN", "Your session has expired. Sign in again.", 401)
    return AuthContext(
        user=user,
        permissions=frozenset(user.role.permissions),
        device_row_id=claims.get("dev"),
        client=claims["cli"],
        session_id=claims.get("sid"),
    )


async def authenticated(
    ctx: Annotated[AuthContext, Depends(current_user)],
) -> AuthContext:
    """Like current_user, but blocks everything until the temporary password is changed."""
    if ctx.user.must_change_password:
        raise AppError("PASSWORD_CHANGE_REQUIRED", "Change your password to continue.", 403)
    return ctx


def require_permission(*permissions: str) -> Callable[..., Awaitable[AuthContext]]:
    async def dependency(ctx: Annotated[AuthContext, Depends(authenticated)]) -> AuthContext:
        if not set(permissions) <= ctx.permissions:
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
