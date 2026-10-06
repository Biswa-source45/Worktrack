from typing import Any

from sqlalchemy import CTE, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import Select

from app.core.errors import AppError
from app.core.security import generate_temp_password, hash_password, utcnow
from app.modules.audit import service as audit
from app.modules.audit.service import AuditCtx
from app.modules.auth.deps import AuthContext
from app.modules.auth.permissions import ALL_PERMISSIONS, SUPER_ADMIN_ROLE
from app.modules.auth.service import revoke_tokens
from app.modules.branches.models import Branch
from app.modules.employees.models import (
    STATUS_ACTIVE,
    STATUS_INACTIVE,
    Department,
    Designation,
    Master,
    Role,
    User,
)
from app.modules.employees.schemas import (
    NO_HOME_BRANCH,
    EmployeeCreate,
    EmployeeUpdate,
    RoleCreate,
    RoleUpdate,
)
from app.modules.shifts.models import Shift

MASTERS: dict[str, type[Master]] = {
    "departments": Department,
    "designations": Designation,
}
MASTER_USER_COLUMN = {"departments": User.department_id, "designations": User.designation_id}


def snapshot(user: User) -> dict[str, Any]:
    """Audit-safe view of an employee: no password hash, no lock counters."""
    return {
        "emp_code": user.emp_code,
        "name": user.name,
        "mobile": user.mobile,
        "email": user.email,
        "role_id": user.role_id,
        "designation_id": user.designation_id,
        "department_id": user.department_id,
        "manager_id": user.manager_id,
        "field_eligible": user.field_eligible,
        "field_punch_in_allowed": user.field_punch_in_allowed,
        "home_branch_id": user.home_branch_id,
        "shift_id": user.shift_id,
        "restrict_to_home_branch": user.restrict_to_home_branch,
        "status": user.status,
        "joined_on": user.joined_on.isoformat(),
    }


def parse_cursor(cursor: str | None) -> int:
    if cursor is None:
        return 0
    try:
        return int(cursor)
    except ValueError:
        raise AppError("INVALID_CURSOR", "The page cursor is not valid.", 422) from None


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


async def get_employee(session: AsyncSession, employee_id: int) -> User:
    user = await session.get(User, employee_id)
    if user is None:
        raise AppError("NOT_FOUND", "Employee not found.", 404)
    return user


def ensure_can_manage(actor: AuthContext | None, target: User) -> None:
    """Nobody may touch an account that outranks them (role permissions must be a subset)."""
    if actor is not None and not set(target.role.permissions) <= actor.permissions:
        raise AppError(
            "FORBIDDEN", "You cannot manage an account with more access than yours.", 403
        )


async def _role_for_assignment(
    session: AsyncSession, actor: AuthContext | None, role_id: int
) -> Role:
    role = await session.get(Role, role_id)
    if role is None:
        raise AppError("INVALID_REFERENCE", "The selected role does not exist.", 422)
    if actor is not None and not set(role.permissions) <= actor.permissions:
        raise AppError("FORBIDDEN", "You cannot assign a role with more access than yours.", 403)
    return role


async def _require(session: AsyncSession, model: type[Master], id_: int) -> None:
    if await session.get(model, id_) is None:
        raise AppError(
            "INVALID_REFERENCE", f"The selected {model.__tablename__[:-1]} does not exist.", 422
        )


async def _require_active(
    session: AsyncSession, model: type[Branch] | type[Shift], id_: int
) -> None:
    row: Branch | Shift | None = await session.get(model, id_)
    if row is None or not row.is_active:
        kind = "branch" if model is Branch else "shift"
        raise AppError(
            "INVALID_REFERENCE", f"The selected {kind} does not exist or is inactive.", 422
        )


def _team_cte(manager_id: int) -> CTE:
    """Everyone below a manager (direct and indirect reports). UNION also stops any cycle."""
    team = select(User.id).where(User.manager_id == manager_id).cte("team", recursive=True)
    return team.union(select(User.id).join(team, User.manager_id == team.c.id))


async def team_ids(session: AsyncSession, manager_id: int) -> set[int]:
    team = _team_cte(manager_id)
    return set((await session.execute(select(team.c.id))).scalars())


async def _check_manager(session: AsyncSession, manager_id: int, employee_id: int | None) -> None:
    manager = await session.get(User, manager_id)
    if manager is None or manager.status != STATUS_ACTIVE:
        raise AppError(
            "INVALID_REFERENCE", "The selected manager does not exist or is inactive.", 422
        )
    if employee_id is not None and (
        manager_id == employee_id or manager_id in await team_ids(session, employee_id)
    ):
        raise AppError(
            "MANAGER_CYCLE", "An employee cannot report to themselves or their own team.", 409
        )


async def _check_unique(
    session: AsyncSession,
    emp_code: str | None,
    mobile: str | None,
    email: str | None,
    exclude_id: int | None = None,
) -> None:
    clauses = []
    if emp_code is not None:
        clauses.append(func.lower(User.emp_code) == emp_code.lower())
    if mobile is not None:
        clauses.append(User.mobile == mobile)
    if email is not None:
        clauses.append(func.lower(User.email) == email.lower())
    if not clauses:
        return
    stmt = select(User.emp_code, User.mobile, User.email).where(or_(*clauses))
    if exclude_id is not None:
        stmt = stmt.where(User.id != exclude_id)
    taken = [
        field
        for row in (await session.execute(stmt)).all()
        for field, value in (("emp_code", emp_code), ("mobile", mobile), ("email", email))
        if value is not None and str(getattr(row, field) or "").lower() == value.lower()
    ]
    if taken:
        raise AppError(
            "DUPLICATE",
            "Employee code, mobile or email is already in use.",
            409,
            {"fields": sorted(set(taken))},
        )


async def employee_status_counts(session: AsyncSession) -> tuple[int, int]:
    """(active, inactive) employees in one grouped query."""
    result = await session.execute(select(User.status, func.count()).group_by(User.status))
    by_status = dict(result.all())
    return by_status.get(STATUS_ACTIVE, 0), by_status.get(STATUS_INACTIVE, 0)


async def _ensure_not_last_super_admin(session: AsyncSession, target: User) -> None:
    if target.role.name != SUPER_ADMIN_ROLE or target.status != STATUS_ACTIVE:
        return
    others = await session.scalar(
        select(func.count())
        .select_from(User)
        .join(Role)
        .where(Role.name == SUPER_ADMIN_ROLE, User.status == STATUS_ACTIVE, User.id != target.id)
    )
    if not others:
        raise AppError("LAST_SUPER_ADMIN", "There must be at least one active Super Admin.", 409)


async def create_employee(
    session: AsyncSession,
    actor: AuthContext | None,
    ctx: AuditCtx,
    data: EmployeeCreate,
) -> tuple[User, str | None]:
    """Create one employee. Returns the user and the generated temporary password, if any."""
    await _role_for_assignment(session, actor, data.role_id)
    await _require(session, Designation, data.designation_id)
    if data.department_id is not None:
        await _require(session, Department, data.department_id)
    if data.manager_id is not None:
        await _check_manager(session, data.manager_id, None)
    if data.home_branch_id is not None:
        await _require_active(session, Branch, data.home_branch_id)
    if data.shift_id is not None:
        await _require_active(session, Shift, data.shift_id)
    await _check_unique(session, data.emp_code, data.mobile, data.email)

    temp_password = None if data.password else generate_temp_password()
    password_hash = await hash_password(data.password or temp_password or "")
    user = User(
        **data.model_dump(exclude={"password"}),
        password_hash=password_hash,
        must_change_password=True,
    )
    session.add(user)
    try:
        await session.flush()
    except IntegrityError:
        raise AppError(
            "DUPLICATE", "Employee code, mobile or email is already in use.", 409
        ) from None
    audit.record(session, ctx, "employee.create", "user", user.id, after=snapshot(user))
    await session.commit()
    await session.refresh(user)
    return user, temp_password


async def update_employee(
    session: AsyncSession,
    actor: AuthContext,
    ctx: AuditCtx,
    employee_id: int,
    data: EmployeeUpdate,
) -> User:
    user = await get_employee(session, employee_id)
    ensure_can_manage(actor, user)
    changes = data.model_dump(exclude_unset=True)
    before = snapshot(user)

    if user.id == actor.user.id and ({"role_id", "status"} & changes.keys()):
        raise AppError("FORBIDDEN", "You cannot change your own role or status.", 403)
    if "role_id" in changes and changes["role_id"] != user.role_id:
        await _role_for_assignment(session, actor, changes["role_id"])
        await _ensure_not_last_super_admin(session, user)
    if "designation_id" in changes:
        await _require(session, Designation, changes["designation_id"])
    if changes.get("department_id") is not None:
        await _require(session, Department, changes["department_id"])
    if changes.get("manager_id") is not None:
        await _check_manager(session, changes["manager_id"], user.id)
    # A branch or shift the employee already has may have been deactivated since; only a new
    # choice must be active.
    if changes.get("home_branch_id") not in (None, user.home_branch_id):
        await _require_active(session, Branch, changes["home_branch_id"])
    if changes.get("shift_id") not in (None, user.shift_id):
        await _require_active(session, Shift, changes["shift_id"])
    if (
        changes.get("restrict_to_home_branch", user.restrict_to_home_branch)
        and changes.get("home_branch_id", user.home_branch_id) is None
    ):
        raise AppError("VALIDATION_ERROR", f"{NO_HOME_BRANCH}.", 422)
    await _check_unique(
        session,
        None,
        changes.get("mobile"),
        changes.get("email"),
        exclude_id=user.id,
    )

    revoke_sessions = False
    if changes.get("status") == STATUS_INACTIVE and user.status == STATUS_ACTIVE:
        await _ensure_not_last_super_admin(session, user)
        reports = await session.scalar(
            select(func.count())
            .select_from(User)
            .where(User.manager_id == user.id, User.status == STATUS_ACTIVE)
        )
        if reports:
            raise AppError(
                "HAS_REPORTS",
                f"Reassign this manager's {reports} active report(s) before deactivating.",
                409,
                {"active_reports": reports},
            )
        revoke_sessions = True

    if changes.get("status") == STATUS_INACTIVE and user.status == STATUS_ACTIVE:
        user.deactivated_at = utcnow()  # starts the clock for deleting the face data (SRS 13)
    elif changes.get("status") == STATUS_ACTIVE and user.status == STATUS_INACTIVE:
        user.deactivated_at = None

    for field, value in changes.items():
        setattr(user, field, value)
    try:
        await session.flush()
    except IntegrityError:
        raise AppError("DUPLICATE", "Mobile or email is already in use.", 409) from None
    if revoke_sessions:
        await revoke_tokens(session, user_id=user.id, reason="account_changed")
    after = snapshot(user)
    audit.record(session, ctx, "employee.update", "user", user.id, before=before, after=after)
    await session.commit()
    await session.refresh(user)
    return user


async def reset_password(
    session: AsyncSession, actor: AuthContext, ctx: AuditCtx, employee_id: int
) -> str:
    user = await get_employee(session, employee_id)
    ensure_can_manage(actor, user)
    temp = generate_temp_password()
    user.password_hash = await hash_password(temp)
    user.must_change_password = True
    user.failed_attempts = 0
    user.locked_until = None
    await revoke_tokens(session, user_id=user.id, reason="password_reset")
    audit.record(session, ctx, "employee.reset_password", "user", user.id)
    await session.commit()
    return temp


async def unlock(
    session: AsyncSession, actor: AuthContext, ctx: AuditCtx, employee_id: int
) -> User:
    user = await get_employee(session, employee_id)
    ensure_can_manage(actor, user)
    user.failed_attempts = 0
    user.locked_until = None
    audit.record(session, ctx, "employee.unlock", "user", user.id)
    await session.commit()
    return user


def _page(stmt: Select[User], cursor: int, limit: int) -> Select[User]:
    return stmt.where(User.id > cursor).order_by(User.id).limit(limit + 1)


def _next_cursor(rows: list[User], limit: int) -> tuple[list[User], str | None]:
    if len(rows) > limit:
        rows = rows[:limit]
        return rows, str(rows[-1].id)
    return rows, None


async def list_employees(
    session: AsyncSession,
    *,
    q: str | None,
    status: str | None,
    role_id: int | None,
    department_id: int | None,
    limit: int,
    cursor: str | None,
) -> tuple[list[User], str | None]:
    stmt = select(User)
    if q:
        like = f"%{_escape_like(q.strip())}%"
        stmt = stmt.where(
            or_(
                User.name.ilike(like, escape="\\"),
                User.emp_code.ilike(like, escape="\\"),
                User.mobile.ilike(like, escape="\\"),
            )
        )
    if status:
        stmt = stmt.where(User.status == status)
    if role_id:
        stmt = stmt.where(User.role_id == role_id)
    if department_id:
        stmt = stmt.where(User.department_id == department_id)
    rows = list(
        (await session.execute(_page(stmt, parse_cursor(cursor), limit))).scalars().unique()
    )
    return _next_cursor(rows, limit)


async def list_team(
    session: AsyncSession, manager_id: int, limit: int, cursor: str | None
) -> tuple[list[User], str | None]:
    """Active people below the caller. The scope is part of the query, not a filter after it."""
    team = _team_cte(manager_id)
    stmt = select(User).where(User.id.in_(select(team.c.id)), User.status == STATUS_ACTIVE)
    rows = list(
        (await session.execute(_page(stmt, parse_cursor(cursor), limit))).scalars().unique()
    )
    return _next_cursor(rows, limit)


# --- masters (departments, designations) ---------------------------------------------------


async def _check_master_name_free(
    session: AsyncSession,
    model: type[Master],
    name: str,
    exclude: int | None,
) -> None:
    stmt = select(model.id).where(func.lower(model.name) == name.lower())
    if exclude is not None:
        stmt = stmt.where(model.id != exclude)
    if (await session.execute(stmt)).first():
        raise AppError("DUPLICATE", "That name already exists.", 409)


async def list_masters(session: AsyncSession, kind: str) -> list[Master]:
    model = MASTERS[kind]
    return list((await session.execute(select(model).order_by(model.name))).scalars())


async def create_master(session: AsyncSession, ctx: AuditCtx, kind: str, name: str) -> Master:
    model = MASTERS[kind]
    await _check_master_name_free(session, model, name, None)
    row = model(name=name)
    session.add(row)
    await session.flush()
    audit.record(session, ctx, f"{kind}.create", kind, row.id, after={"name": name})
    await session.commit()
    return row


async def update_master(
    session: AsyncSession, ctx: AuditCtx, kind: str, id_: int, name: str
) -> Master:
    model = MASTERS[kind]
    row = await session.get(model, id_)
    if row is None:
        raise AppError("NOT_FOUND", "Not found.", 404)
    await _check_master_name_free(session, model, name, id_)
    before = {"name": row.name}
    row.name = name
    audit.record(session, ctx, f"{kind}.update", kind, id_, before=before, after={"name": name})
    await session.commit()
    return row


async def delete_master(session: AsyncSession, ctx: AuditCtx, kind: str, id_: int) -> None:
    model = MASTERS[kind]
    row = await session.get(model, id_)
    if row is None:
        raise AppError("NOT_FOUND", "Not found.", 404)
    in_use = await session.scalar(
        select(func.count()).select_from(User).where(MASTER_USER_COLUMN[kind] == id_)
    )
    if in_use:
        raise AppError("IN_USE", f"Still assigned to {in_use} employee(s).", 409)
    audit.record(session, ctx, f"{kind}.delete", kind, id_, before={"name": row.name})
    await session.delete(row)
    await session.commit()


# --- roles --------------------------------------------------------------------------------


def _validate_permissions(actor: AuthContext, permissions: list[str]) -> list[str]:
    unknown = set(permissions) - ALL_PERMISSIONS
    if unknown:
        raise AppError("VALIDATION_ERROR", f"Unknown permission(s): {sorted(unknown)}", 422)
    if not set(permissions) <= actor.permissions:
        raise AppError("FORBIDDEN", "You cannot grant permissions you do not have.", 403)
    return sorted(set(permissions))


async def list_roles(session: AsyncSession) -> list[Role]:
    return list((await session.execute(select(Role).order_by(Role.id))).scalars())


async def _check_role_name_free(session: AsyncSession, name: str, exclude: int | None) -> None:
    stmt = select(Role.id).where(func.lower(Role.name) == name.lower())
    if exclude is not None:
        stmt = stmt.where(Role.id != exclude)
    if (await session.execute(stmt)).first():
        raise AppError("DUPLICATE", "That name already exists.", 409)


async def create_role(
    session: AsyncSession, actor: AuthContext, ctx: AuditCtx, data: RoleCreate
) -> Role:
    permissions = _validate_permissions(actor, data.permissions)
    await _check_role_name_free(session, data.name, None)
    role = Role(name=data.name, permissions=permissions)
    session.add(role)
    await session.flush()
    audit.record(
        session,
        ctx,
        "role.create",
        "role",
        role.id,
        after={"name": role.name, "permissions": permissions},
    )
    await session.commit()
    return role


async def update_role(
    session: AsyncSession, actor: AuthContext, ctx: AuditCtx, role_id: int, data: RoleUpdate
) -> Role:
    role = await session.get(Role, role_id)
    if role is None:
        raise AppError("NOT_FOUND", "Role not found.", 404)
    if role.name == SUPER_ADMIN_ROLE:
        raise AppError("PROTECTED_ROLE", "The Super Admin role cannot be changed.", 409)
    before = {"name": role.name, "permissions": role.permissions}
    if data.name is not None and data.name != role.name:
        if role.is_system:
            raise AppError("PROTECTED_ROLE", "System roles cannot be renamed.", 409)
        await _check_role_name_free(session, data.name, role.id)
        role.name = data.name
    if data.permissions is not None:
        role.permissions = _validate_permissions(actor, data.permissions)
        # Holders of the role pick up the new permissions on their next request; no token reissue.
    audit.record(
        session,
        ctx,
        "role.update",
        "role",
        role.id,
        before=before,
        after={"name": role.name, "permissions": role.permissions},
    )
    await session.commit()
    return role


async def delete_role(session: AsyncSession, ctx: AuditCtx, role_id: int) -> None:
    role = await session.get(Role, role_id)
    if role is None:
        raise AppError("NOT_FOUND", "Role not found.", 404)
    if role.is_system:
        raise AppError("PROTECTED_ROLE", "System roles cannot be deleted.", 409)
    in_use = await session.scalar(
        select(func.count()).select_from(User).where(User.role_id == role_id)
    )
    if in_use:
        raise AppError("IN_USE", f"Still assigned to {in_use} employee(s).", 409)
    audit.record(session, ctx, "role.delete", "role", role_id, before={"name": role.name})
    await session.delete(role)
    await session.commit()
