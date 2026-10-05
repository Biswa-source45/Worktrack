import datetime as dt
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.modules.auth.deps import (
    AuthContext,
    authenticated,
    require_active_device,
    require_permission,
)
from app.modules.auth.permissions import EMPLOYEES_MANAGE
from app.modules.employees.models import User
from app.modules.employees.service import ensure_can_manage, get_employee
from app.modules.schedule import home, service
from app.modules.schedule.schemas import (
    AdminHomeOut,
    HomeApprove,
    HomeReject,
    HomeRequestDetail,
    HomeRequested,
    HomeRequestIn,
    HomeRequestItem,
    HomeRequestPage,
    HomeSet,
    MyHomeOut,
    ResolvedDay,
    ScheduleOut,
    ScheduleRowOut,
    ScheduleSet,
)

router = APIRouter(tags=["schedule"])

Session = Annotated[AsyncSession, Depends(get_session)]
Manager = Annotated[AuthContext, Depends(require_permission(EMPLOYEES_MANAGE))]
SignedIn = Annotated[AuthContext, Depends(authenticated)]
OnOwnPhone = Annotated[AuthContext, Depends(require_active_device)]


async def _managed(session: AsyncSession, actor: AuthContext, employee_id: int) -> User:
    """The employee, if the actor may manage them."""
    user = await get_employee(session, employee_id)
    ensure_can_manage(actor, user)
    return user


# --- weekly schedule --------------------------------------------------------------------------


@router.get("/admin/employees/{employee_id}/schedule", response_model=ScheduleOut)
async def get_schedule(
    employee_id: int,
    session: Session,
    actor: Manager,
    start: Annotated[dt.date | None, Query(alias="from")] = None,
    end: Annotated[dt.date | None, Query(alias="to")] = None,
) -> ScheduleOut:
    user = await _managed(session, actor, employee_id)
    start, end = service.check_range(start, end)
    rows = await service.schedule_rows(session, user.id)
    resolved = await service.resolve_days(session, user, start, end)
    return ScheduleOut(
        rows=[ScheduleRowOut.model_validate(row) for row in rows],
        resolved=[
            ResolvedDay(date=day, kind=plan.kind, reason=plan.reason) for day, plan in resolved
        ],
    )


@router.put("/admin/employees/{employee_id}/schedule", response_model=ScheduleRowOut)
async def set_schedule(
    employee_id: int, body: ScheduleSet, request: Request, session: Session, actor: Manager
) -> ScheduleRowOut:
    user = await _managed(session, actor, employee_id)
    row = await service.set_schedule(session, actor.audit(request), user, body)
    return ScheduleRowOut.model_validate(row)


# --- home work location: admin ----------------------------------------------------------------


@router.get("/admin/employees/{employee_id}/home-location", response_model=AdminHomeOut)
async def get_home_location(employee_id: int, session: Session, actor: Manager) -> AdminHomeOut:
    user = await _managed(session, actor, employee_id)
    return await home.admin_view(session, user.id)


@router.put("/admin/employees/{employee_id}/home-location", response_model=AdminHomeOut)
async def set_home_location(
    employee_id: int, body: HomeSet, request: Request, session: Session, actor: Manager
) -> AdminHomeOut:
    user = await _managed(session, actor, employee_id)
    await home.set_approved(session, actor.audit(request), user, body)
    return await home.admin_view(session, user.id)


@router.delete("/admin/employees/{employee_id}/home-location", status_code=204)
async def remove_home_location(
    employee_id: int, request: Request, session: Session, actor: Manager
) -> Response:
    user = await _managed(session, actor, employee_id)
    await home.remove_approved(session, actor.audit(request), user)
    return Response(status_code=204)


@router.get("/admin/home-location-requests", response_model=HomeRequestPage)
async def list_home_requests(
    session: Session,
    actor: Manager,
    status: Literal["pending", "approved", "rejected"] = "pending",
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: str | None = None,
) -> HomeRequestPage:
    items, next_cursor = await home.list_requests(
        session, actor, status=status, limit=limit, cursor=cursor
    )
    return HomeRequestPage(items=items, next_cursor=next_cursor)


@router.get("/admin/home-location-requests/{request_id}", response_model=HomeRequestDetail)
async def get_home_request(request_id: int, session: Session, actor: Manager) -> HomeRequestDetail:
    return await home.request_detail(session, actor, request_id)


@router.post("/admin/home-location-requests/{request_id}/approve", response_model=HomeRequestItem)
async def approve_home_request(
    request_id: int,
    request: Request,
    session: Session,
    actor: Manager,
    body: HomeApprove | None = None,
) -> HomeRequestItem:
    return await home.approve(
        session, actor, actor.audit(request), request_id, body or HomeApprove()
    )


@router.post("/admin/home-location-requests/{request_id}/reject", response_model=HomeRequestItem)
async def reject_home_request(
    request_id: int, body: HomeReject, request: Request, session: Session, actor: Manager
) -> HomeRequestItem:
    return await home.reject(session, actor, actor.audit(request), request_id, body.reason)


# --- home work location: the employee ---------------------------------------------------------


@router.post("/me/home-location-requests", response_model=HomeRequested, status_code=201)
async def request_home_location(
    body: HomeRequestIn, request: Request, session: Session, auth: OnOwnPhone
) -> HomeRequested:
    row = await home.request_home(session, auth.audit(request), auth.user, body)
    return HomeRequested(status=row.status, radius_m=row.radius_m, created_at=row.created_at)


@router.get("/me/home-location", response_model=MyHomeOut)
async def my_home_location(session: Session, auth: SignedIn) -> MyHomeOut:
    return await home.my_home(session, auth.user.id)
