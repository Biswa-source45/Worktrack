from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.modules.auth import service
from app.modules.auth.deps import AuthContext, current_user
from app.modules.auth.schemas import (
    ChangePasswordRequest,
    LoginRequest,
    MeResponse,
    RefreshRequest,
    TokenResponse,
)

router = APIRouter(tags=["auth"])

Session = Annotated[AsyncSession, Depends(get_session)]


def _ip(request: Request) -> str | None:
    return request.client.host if request.client else None


def _user_agent(request: Request) -> str | None:
    return request.headers.get("user-agent")


@router.post("/auth/login", response_model=TokenResponse)
async def login(body: LoginRequest, request: Request, session: Session) -> TokenResponse:
    state = request.app.state
    return await service.login(
        session, state.redis, state.settings, body, _ip(request), _user_agent(request)
    )


@router.post("/auth/refresh", response_model=TokenResponse)
async def refresh(body: RefreshRequest, request: Request, session: Session) -> TokenResponse:
    return await service.refresh(
        session, request.app.state.settings, body.refresh_token, _ip(request), _user_agent(request)
    )


@router.post("/auth/logout", status_code=204)
async def logout(body: RefreshRequest, request: Request, session: Session) -> Response:
    await service.logout(session, body.refresh_token, _ip(request))
    return Response(status_code=204)


@router.post("/auth/change-password", response_model=TokenResponse)
async def change_password(
    body: ChangePasswordRequest,
    request: Request,
    session: Session,
    auth: Annotated[AuthContext, Depends(current_user)],
) -> TokenResponse:
    return await service.change_password(
        session, request.app.state.settings, auth, body, auth.audit(request), _user_agent(request)
    )


@router.get("/me", response_model=MeResponse)
async def me(session: Session, auth: Annotated[AuthContext, Depends(current_user)]) -> MeResponse:
    return await service.build_me(session, auth)
