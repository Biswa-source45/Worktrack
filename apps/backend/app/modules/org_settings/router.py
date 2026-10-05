from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.modules.auth.deps import AuthContext, require_permission
from app.modules.auth.permissions import SETTINGS_MANAGE, SETTINGS_VIEW
from app.modules.org_settings import service
from app.modules.org_settings.schemas import OrgSettings

router = APIRouter(tags=["settings"])

Session = Annotated[AsyncSession, Depends(get_session)]


@router.get("/admin/settings", response_model=OrgSettings)
async def get_settings(
    session: Session, _: Annotated[AuthContext, Depends(require_permission(SETTINGS_VIEW))]
) -> OrgSettings:
    return await service.get_org_settings(session)


@router.patch("/admin/settings", response_model=OrgSettings)
async def update_settings(
    body: OrgSettings,
    request: Request,
    session: Session,
    actor: Annotated[AuthContext, Depends(require_permission(SETTINGS_MANAGE))],
) -> OrgSettings:
    return await service.update(session, actor.audit(request), body)
