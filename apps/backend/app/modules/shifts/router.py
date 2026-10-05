from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.modules.auth.deps import AuthContext, authenticated, require_permission
from app.modules.auth.permissions import BRANCHES_MANAGE
from app.modules.employees.schemas import Ref
from app.modules.shifts import service
from app.modules.shifts.schemas import (
    HolidayCreate,
    HolidayOut,
    HolidayPage,
    HolidayUpdate,
    ShiftCreate,
    ShiftOut,
    ShiftPage,
    ShiftUpdate,
)

router = APIRouter(tags=["shifts"])

Session = Annotated[AsyncSession, Depends(get_session)]
Manager = Annotated[AuthContext, Depends(require_permission(BRANCHES_MANAGE))]
SignedIn = Annotated[AuthContext, Depends(authenticated)]
Limit = Annotated[int, Query(ge=1, le=200)]


@router.get("/admin/shifts", response_model=ShiftPage)
async def list_shifts(
    session: Session, _: Manager, limit: Limit = 50, cursor: str | None = None
) -> ShiftPage:
    rows, next_cursor = await service.list_shifts(session, limit, cursor)
    return ShiftPage(items=[ShiftOut.model_validate(r) for r in rows], next_cursor=next_cursor)


@router.post("/admin/shifts", response_model=ShiftOut, status_code=201)
async def create_shift(
    body: ShiftCreate, request: Request, session: Session, actor: Manager
) -> ShiftOut:
    return ShiftOut.model_validate(await service.create_shift(session, actor.audit(request), body))


@router.patch("/admin/shifts/{shift_id}", response_model=ShiftOut)
async def update_shift(
    shift_id: int, body: ShiftUpdate, request: Request, session: Session, actor: Manager
) -> ShiftOut:
    return ShiftOut.model_validate(
        await service.update_shift(session, actor.audit(request), shift_id, body)
    )


@router.get("/shifts", response_model=list[Ref])
async def shift_names(session: Session, _: SignedIn) -> list[Ref]:
    # Employee forms run under employees.manage, not branches.manage, and still need a picker.
    return [Ref.model_validate(r) for r in await service.active_shift_names(session)]


@router.get("/admin/holidays", response_model=HolidayPage)
async def list_holidays(
    session: Session,
    _: Manager,
    year: Annotated[int, Query(ge=2000, le=2100)],
    branch_id: int | None = None,
    limit: Limit = 50,
    cursor: str | None = None,
) -> HolidayPage:
    rows, next_cursor = await service.list_holidays(
        session, year=year, branch_id=branch_id, limit=limit, cursor=cursor
    )
    return HolidayPage(items=[HolidayOut.model_validate(r) for r in rows], next_cursor=next_cursor)


@router.post("/admin/holidays", response_model=HolidayOut, status_code=201)
async def create_holiday(
    body: HolidayCreate, request: Request, session: Session, actor: Manager
) -> HolidayOut:
    return HolidayOut.model_validate(
        await service.create_holiday(session, actor.audit(request), body)
    )


@router.patch("/admin/holidays/{holiday_id}", response_model=HolidayOut)
async def update_holiday(
    holiday_id: int, body: HolidayUpdate, request: Request, session: Session, actor: Manager
) -> HolidayOut:
    return HolidayOut.model_validate(
        await service.update_holiday(session, actor.audit(request), holiday_id, body)
    )


@router.delete("/admin/holidays/{holiday_id}", status_code=204)
async def delete_holiday(
    holiday_id: int, request: Request, session: Session, actor: Manager
) -> Response:
    await service.delete_holiday(session, actor.audit(request), holiday_id)
    return Response(status_code=204)
