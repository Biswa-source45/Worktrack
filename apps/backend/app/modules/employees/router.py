from typing import Annotated, Literal

from fastapi import APIRouter, Depends, File, Query, Request, Response, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.modules.auth.deps import AuthContext, require_permission
from app.modules.auth.permissions import EMPLOYEES_MANAGE, ROLES_MANAGE, TEAM_VIEW
from app.modules.devices import service as devices_service
from app.modules.employees import importing, service
from app.modules.employees.schemas import (
    DashboardOut,
    EmployeeCreate,
    EmployeeCreated,
    EmployeeOut,
    EmployeePage,
    EmployeeUpdate,
    ImportResult,
    MasterIn,
    Ref,
    RoleCreate,
    RoleOut,
    RoleUpdate,
    TeamPage,
    TemporaryPassword,
)

router = APIRouter(tags=["employees"])

Session = Annotated[AsyncSession, Depends(get_session)]
Manager = Annotated[AuthContext, Depends(require_permission(EMPLOYEES_MANAGE))]
RoleAdmin = Annotated[AuthContext, Depends(require_permission(ROLES_MANAGE))]
TeamViewer = Annotated[AuthContext, Depends(require_permission(TEAM_VIEW))]
Limit = Annotated[int, Query(ge=1, le=200)]
Kind = Literal["departments", "designations"]


@router.get("/admin/dashboard", response_model=DashboardOut)
async def dashboard(session: Session, _: Manager) -> DashboardOut:
    active, inactive = await service.employee_status_counts(session)
    pending = (await devices_service.device_counts(session)).pending
    return DashboardOut(
        employees_total=active + inactive,
        employees_active=active,
        employees_inactive=inactive,
        pending_devices=pending,
    )


# --- employees -----------------------------------------------------------------------------


@router.get("/admin/employees", response_model=EmployeePage)
async def list_employees(
    session: Session,
    _: Manager,
    q: Annotated[str | None, Query(max_length=64)] = None,
    status: Literal["active", "inactive"] | None = None,
    role_id: int | None = None,
    department_id: int | None = None,
    limit: Limit = 50,
    cursor: str | None = None,
) -> EmployeePage:
    rows, next_cursor = await service.list_employees(
        session,
        q=q,
        status=status,
        role_id=role_id,
        department_id=department_id,
        limit=limit,
        cursor=cursor,
    )
    return EmployeePage(
        items=[EmployeeOut.model_validate(r) for r in rows], next_cursor=next_cursor
    )


@router.post("/admin/employees", response_model=EmployeeCreated, status_code=201)
async def create_employee(
    body: EmployeeCreate, request: Request, session: Session, actor: Manager
) -> EmployeeCreated:
    user, temp = await service.create_employee(session, actor, actor.audit(request), body)
    return EmployeeCreated(employee=EmployeeOut.model_validate(user), temporary_password=temp)


@router.get("/admin/employees/import/template")
async def import_template(_: Manager) -> Response:
    return Response(
        importing.TEMPLATE_CSV,
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="employees-template.csv"'},
    )


@router.post("/admin/employees/import", response_model=ImportResult)
async def import_employees(
    request: Request,
    session: Session,
    actor: Manager,
    file: Annotated[UploadFile, File()],
    dry_run: bool = True,
) -> ImportResult:
    # Read one byte past the cap so an oversized upload is detected without buffering it all.
    content = await file.read(importing.MAX_BYTES + 1)
    return await importing.import_employees(
        session, actor, actor.audit(request), file.filename or "", content, dry_run
    )


@router.get("/admin/employees/{employee_id}", response_model=EmployeeOut)
async def get_employee(employee_id: int, session: Session, _: Manager) -> EmployeeOut:
    return EmployeeOut.model_validate(await service.get_employee(session, employee_id))


@router.patch("/admin/employees/{employee_id}", response_model=EmployeeOut)
async def update_employee(
    employee_id: int, body: EmployeeUpdate, request: Request, session: Session, actor: Manager
) -> EmployeeOut:
    user = await service.update_employee(session, actor, actor.audit(request), employee_id, body)
    return EmployeeOut.model_validate(user)


@router.post("/admin/employees/{employee_id}/reset-password", response_model=TemporaryPassword)
async def reset_password(
    employee_id: int, request: Request, session: Session, actor: Manager
) -> TemporaryPassword:
    temp = await service.reset_password(session, actor, actor.audit(request), employee_id)
    return TemporaryPassword(temporary_password=temp)


@router.post("/admin/employees/{employee_id}/unlock", response_model=EmployeeOut)
async def unlock(
    employee_id: int, request: Request, session: Session, actor: Manager
) -> EmployeeOut:
    user = await service.unlock(session, actor, actor.audit(request), employee_id)
    return EmployeeOut.model_validate(user)


@router.get("/employees/team", response_model=TeamPage)
async def team(
    session: Session, actor: TeamViewer, limit: Limit = 50, cursor: str | None = None
) -> TeamPage:
    rows, next_cursor = await service.list_team(session, actor.user.id, limit, cursor)
    return TeamPage.model_validate(
        {"items": rows, "next_cursor": next_cursor}, from_attributes=True
    )


# --- departments and designations ----------------------------------------------------------


@router.get("/admin/masters/{kind}", response_model=list[Ref])
async def list_masters(kind: Kind, session: Session, _: Manager) -> list[Ref]:
    return [Ref.model_validate(r) for r in await service.list_masters(session, kind)]


@router.post("/admin/masters/{kind}", response_model=Ref, status_code=201)
async def create_master(
    kind: Kind, body: MasterIn, request: Request, session: Session, actor: Manager
) -> Ref:
    row = await service.create_master(session, actor.audit(request), kind, body.name)
    return Ref.model_validate(row)


@router.patch("/admin/masters/{kind}/{item_id}", response_model=Ref)
async def update_master(
    kind: Kind, item_id: int, body: MasterIn, request: Request, session: Session, actor: Manager
) -> Ref:
    row = await service.update_master(session, actor.audit(request), kind, item_id, body.name)
    return Ref.model_validate(row)


@router.delete("/admin/masters/{kind}/{item_id}", status_code=204)
async def delete_master(
    kind: Kind, item_id: int, request: Request, session: Session, actor: Manager
) -> Response:
    await service.delete_master(session, actor.audit(request), kind, item_id)
    return Response(status_code=204)


# --- roles ---------------------------------------------------------------------------------


@router.get("/admin/roles", response_model=list[RoleOut])
async def list_roles(session: Session, _: Manager) -> list[RoleOut]:
    return [RoleOut.model_validate(r) for r in await service.list_roles(session)]


@router.post("/admin/roles", response_model=RoleOut, status_code=201)
async def create_role(
    body: RoleCreate, request: Request, session: Session, actor: RoleAdmin
) -> RoleOut:
    return RoleOut.model_validate(
        await service.create_role(session, actor, actor.audit(request), body)
    )


@router.patch("/admin/roles/{role_id}", response_model=RoleOut)
async def update_role(
    role_id: int, body: RoleUpdate, request: Request, session: Session, actor: RoleAdmin
) -> RoleOut:
    return RoleOut.model_validate(
        await service.update_role(session, actor, actor.audit(request), role_id, body)
    )


@router.delete("/admin/roles/{role_id}", status_code=204)
async def delete_role(
    role_id: int, request: Request, session: Session, actor: RoleAdmin
) -> Response:
    await service.delete_role(session, actor.audit(request), role_id)
    return Response(status_code=204)
