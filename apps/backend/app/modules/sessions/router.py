from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.modules.auth.deps import AuthContext, authenticated, require_permission
from app.modules.auth.permissions import DEVICES_MANAGE
from app.modules.sessions import service
from app.modules.sessions.schemas import RevokedOthers, SessionOut, SessionPage

router = APIRouter(tags=["sessions"])

Session = Annotated[AsyncSession, Depends(get_session)]
# Whoever may approve and revoke phones may also see and end sign-ins (D31).
Admin = Annotated[AuthContext, Depends(require_permission(DEVICES_MANAGE))]
Me = Annotated[AuthContext, Depends(authenticated)]


@router.get("/admin/sessions", response_model=SessionPage)
async def list_sessions(
    session: Session,
    actor: Admin,
    status: Literal["active", "ended"] | None = None,
    client: Literal["web", "mobile"] | None = None,
    user_id: int | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: str | None = None,
) -> SessionPage:
    return await service.list_sessions(
        session, actor, status=status, client=client, user_id=user_id, limit=limit, cursor=cursor
    )


@router.post("/admin/sessions/{session_id}/revoke", response_model=SessionOut)
async def revoke(session_id: int, request: Request, session: Session, actor: Admin) -> SessionOut:
    return await service.revoke(session, actor, actor.audit(request), session_id)


@router.get("/me/sessions", response_model=list[SessionOut])
async def my_sessions(session: Session, auth: Me) -> list[SessionOut]:
    return await service.list_own(session, auth)


@router.post("/me/sessions/revoke-others", response_model=RevokedOthers)
async def revoke_my_other_sessions(request: Request, session: Session, auth: Me) -> RevokedOthers:
    return RevokedOthers(revoked=await service.revoke_others(session, auth, auth.audit(request)))
