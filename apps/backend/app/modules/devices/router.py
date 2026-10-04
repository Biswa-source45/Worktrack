from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.modules.auth.deps import AuthContext, require_permission
from app.modules.auth.permissions import DEVICES_MANAGE
from app.modules.devices import service
from app.modules.devices.schemas import DeviceDecision, DeviceOut, DevicePage

router = APIRouter(prefix="/admin/devices", tags=["devices"])

Session = Annotated[AsyncSession, Depends(get_session)]
Admin = Annotated[AuthContext, Depends(require_permission(DEVICES_MANAGE))]


@router.get("", response_model=DevicePage)
async def list_devices(
    session: Session,
    _: Admin,
    status: Literal["active", "pending", "revoked"] | None = None,
    user_id: int | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: str | None = None,
) -> DevicePage:
    return await service.list_devices(
        session, status=status, user_id=user_id, limit=limit, cursor=cursor
    )


@router.patch("/{device_id}", response_model=DeviceOut)
async def decide(
    device_id: int, body: DeviceDecision, request: Request, session: Session, actor: Admin
) -> DeviceOut:
    return await service.decide(session, actor, actor.audit(request), device_id, body.action)
