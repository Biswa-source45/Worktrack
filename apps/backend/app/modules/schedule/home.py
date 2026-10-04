"""Home work locations: set by an admin, or requested from the employee's phone and approved.

Privacy: coordinates are read only by `admin_view` and `request_detail`. Lists, the employee's
own view, audit rows and logs never carry them.
"""

from typing import Any

from geoalchemy2 import Geometry
from sqlalchemy import Float, cast, func, literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.core.security import utcnow
from app.modules.audit import service as audit
from app.modules.audit.service import AuditCtx
from app.modules.auth.deps import AuthContext
from app.modules.branches.geofence import Candidates, ensure_accuracy
from app.modules.branches.service import point
from app.modules.employees.models import Role, User
from app.modules.employees.service import ensure_can_manage, get_employee, parse_cursor
from app.modules.org_settings.service import get_org_settings
from app.modules.schedule.models import (
    HOME_APPROVED,
    HOME_PENDING,
    HOME_REJECTED,
    HOME_REMOVED,
    HOME_REPLACED,
    HomeLocation,
)
from app.modules.schedule.schemas import (
    AdminHomeOut,
    ApprovedHome,
    EmployeeBrief,
    HomeApprove,
    HomeRequestDetail,
    HomeRequestIn,
    HomeRequestItem,
    HomeSet,
    MyApprovedHome,
    MyHomeOut,
    MyPendingHome,
    MyRejectedHome,
    PendingHome,
)

SOURCE_ADMIN = "admin"
SOURCE_SELF = "self"

_GEOMETRY = Geometry("POINT", srid=4326)
_LAT = func.ST_Y(cast(HomeLocation.location, _GEOMETRY), type_=Float).label("lat")
_LNG = func.ST_X(cast(HomeLocation.location, _GEOMETRY), type_=Float).label("lng")


def _audit_view(row: HomeLocation, replaced: HomeLocation | None = None) -> dict[str, Any]:
    """What an audit row may say about a home location: never where it is."""
    view: dict[str, Any] = {
        "user_id": row.user_id,
        "status": row.status,
        "radius_m": row.radius_m,
        "source": row.source,
        "accuracy_m": row.accuracy_m,
    }
    if replaced is not None:
        view["replaced_id"] = replaced.id
    return view


async def _current(session: AsyncSession, user_id: int, status: str) -> HomeLocation | None:
    return await session.scalar(
        select(HomeLocation).where(HomeLocation.user_id == user_id, HomeLocation.status == status)
    )


async def _retire(session: AsyncSession, user_id: int, status: str) -> HomeLocation | None:
    """Mark the employee's approved (or pending) row as replaced, ahead of its successor."""
    row = await _current(session, user_id, status)
    if row is not None:
        row.status = HOME_REPLACED
        # Flushed now: only one approved and one pending row may exist per employee.
        await session.flush()
    return row


def _item(row: Any) -> dict[str, Any]:
    return {
        "id": row.id,
        "employee": EmployeeBrief(id=row.employee_id, emp_code=row.emp_code, name=row.name),
        "status": row.status,
        "accuracy_m": row.accuracy_m,
        "created_at": row.created_at,
    }


_ITEM_COLUMNS = (
    HomeLocation.id,
    HomeLocation.status,
    HomeLocation.accuracy_m,
    HomeLocation.created_at,
    User.id.label("employee_id"),
    User.emp_code,
    User.name,
)


def home_candidate(user_id: int) -> Candidates:
    """The employee's approved home location as a geofence candidate (kind "home")."""
    return select(
        literal("home").label("kind"),
        HomeLocation.id,
        literal("Home").label("name"),
        HomeLocation.location,
        HomeLocation.radius_m,
    ).where(HomeLocation.user_id == user_id, HomeLocation.status == HOME_APPROVED)


# --- admin ------------------------------------------------------------------------------------


async def admin_view(session: AsyncSession, user_id: int) -> AdminHomeOut:
    """The employee's approved and pending home locations, with coordinates."""
    rows = (
        await session.execute(
            select(HomeLocation, _LAT, _LNG).where(
                HomeLocation.user_id == user_id,
                HomeLocation.status.in_([HOME_APPROVED, HOME_PENDING]),
            )
        )
    ).all()
    found = {row.HomeLocation.status: row for row in rows}
    approved, pending = found.get(HOME_APPROVED), found.get(HOME_PENDING)
    return AdminHomeOut(
        approved=None
        if approved is None
        else ApprovedHome(
            id=approved.HomeLocation.id,
            lat=approved.lat,
            lng=approved.lng,
            radius_m=approved.HomeLocation.radius_m,
            source=approved.HomeLocation.source,
            decided_at=approved.HomeLocation.decided_at,
        ),
        pending=None
        if pending is None
        else PendingHome(
            id=pending.HomeLocation.id,
            lat=pending.lat,
            lng=pending.lng,
            radius_m=pending.HomeLocation.radius_m,
            accuracy_m=pending.HomeLocation.accuracy_m,
            created_at=pending.HomeLocation.created_at,
        ),
    )


async def set_approved(session: AsyncSession, ctx: AuditCtx, user: User, data: HomeSet) -> None:
    """An admin places the home pin: approved at once, replacing the previous approved one."""
    radius = data.radius_m
    if radius is None:
        radius = (await get_org_settings(session)).home_default_radius_m
    replaced = await _retire(session, user.id, HOME_APPROVED)
    row = HomeLocation(
        user_id=user.id,
        location=point(data.lat, data.lng),
        radius_m=radius,
        source=SOURCE_ADMIN,
        status=HOME_APPROVED,
        requested_by=ctx.actor_id,
        decided_by=ctx.actor_id,
        decided_at=utcnow(),
    )
    session.add(row)
    await session.flush()
    audit.record(
        session, ctx, "home_location.set", "home_location", row.id, after=_audit_view(row, replaced)
    )
    await session.commit()


async def remove_approved(session: AsyncSession, ctx: AuditCtx, user: User) -> None:
    row = await _current(session, user.id, HOME_APPROVED)
    if row is None:
        raise AppError("NOT_FOUND", "This employee has no approved home location.", 404)
    before = _audit_view(row)
    row.status = HOME_REMOVED
    audit.record(
        session,
        ctx,
        "home_location.remove",
        "home_location",
        row.id,
        before=before,
        after=_audit_view(row),
    )
    await session.commit()


async def list_requests(
    session: AsyncSession, actor: AuthContext, *, status: str, limit: int, cursor: str | None
) -> tuple[list[HomeRequestItem], str | None]:
    """Requests employees sent from their phones, without coordinates.

    Only employees the actor may manage are listed (the same rule as ensure_can_manage: the
    employee's role permissions are a subset of the actor's), decided in SQL.
    """
    stmt = (
        select(*_ITEM_COLUMNS)
        .join(User, User.id == HomeLocation.user_id)
        .join(Role, Role.id == User.role_id)
        .where(
            HomeLocation.source == SOURCE_SELF,
            HomeLocation.status == status,
            HomeLocation.id > parse_cursor(cursor),
            Role.__table__.c.permissions.contained_by(sorted(actor.permissions)),
        )
        .order_by(HomeLocation.id)
        .limit(limit + 1)
    )
    rows = (await session.execute(stmt)).all()
    items = [HomeRequestItem(**_item(row)) for row in rows[:limit]]
    return items, str(items[-1].id) if len(rows) > limit else None


async def request_detail(
    session: AsyncSession, actor: AuthContext, request_id: int
) -> HomeRequestDetail:
    """One request, with coordinates, for the admin who decides it."""
    row = (
        await session.execute(
            select(
                *_ITEM_COLUMNS,
                _LAT,
                _LNG,
                HomeLocation.radius_m,
                HomeLocation.decided_at,
                HomeLocation.reject_reason,
            )
            .join(User, User.id == HomeLocation.user_id)
            .where(HomeLocation.id == request_id, HomeLocation.source == SOURCE_SELF)
        )
    ).first()
    if row is None:
        raise AppError("NOT_FOUND", "Request not found.", 404)
    ensure_can_manage(actor, await get_employee(session, row.employee_id))
    return HomeRequestDetail(
        **_item(row),
        lat=row.lat,
        lng=row.lng,
        radius_m=row.radius_m,
        decided_at=row.decided_at,
        reject_reason=row.reject_reason,
    )


async def _pending_request(
    session: AsyncSession, actor: AuthContext, request_id: int
) -> tuple[HomeLocation, User]:
    # Locked, so two admins deciding at once cannot both succeed.
    row = await session.get(HomeLocation, request_id, with_for_update=True)
    if row is None or row.source != SOURCE_SELF:
        raise AppError("NOT_FOUND", "Request not found.", 404)
    user = await get_employee(session, row.user_id)
    ensure_can_manage(actor, user)
    if row.status != HOME_PENDING:
        raise AppError("REQUEST_ALREADY_DECIDED", "This request has already been decided.", 409)
    return row, user


def _decided(row: HomeLocation, user: User) -> HomeRequestItem:
    return HomeRequestItem(
        id=row.id,
        employee=EmployeeBrief.model_validate(user),
        status=row.status,
        accuracy_m=row.accuracy_m,
        created_at=row.created_at,
    )


async def approve(
    session: AsyncSession, actor: AuthContext, ctx: AuditCtx, request_id: int, data: HomeApprove
) -> HomeRequestItem:
    row, user = await _pending_request(session, actor, request_id)
    before = _audit_view(row)
    replaced = await _retire(session, user.id, HOME_APPROVED)
    row.status = HOME_APPROVED
    if data.radius_m is not None:
        row.radius_m = data.radius_m
    row.decided_by, row.decided_at = actor.user.id, utcnow()
    await session.flush()
    audit.record(
        session,
        ctx,
        "home_location.approve",
        "home_location",
        row.id,
        before=before,
        after=_audit_view(row, replaced),
    )
    await session.commit()
    return _decided(row, user)


async def reject(
    session: AsyncSession, actor: AuthContext, ctx: AuditCtx, request_id: int, reason: str
) -> HomeRequestItem:
    row, user = await _pending_request(session, actor, request_id)
    before = _audit_view(row)
    row.status, row.reject_reason = HOME_REJECTED, reason
    row.decided_by, row.decided_at = actor.user.id, utcnow()
    audit.record(
        session,
        ctx,
        "home_location.reject",
        "home_location",
        row.id,
        before=before,
        after={**_audit_view(row), "reason": reason},
    )
    await session.commit()
    return _decided(row, user)


# --- the employee -----------------------------------------------------------------------------


async def request_home(
    session: AsyncSession, ctx: AuditCtx, user: User, data: HomeRequestIn
) -> HomeLocation:
    """The employee asks, from their approved phone, to use where they stand as their home."""
    settings = await get_org_settings(session)
    ensure_accuracy(settings, data.accuracy_m)
    replaced = await _retire(session, user.id, HOME_PENDING)
    row = HomeLocation(
        user_id=user.id,
        location=point(data.lat, data.lng),
        radius_m=settings.home_default_radius_m,
        accuracy_m=data.accuracy_m,
        source=SOURCE_SELF,
        status=HOME_PENDING,
        requested_by=user.id,
    )
    session.add(row)
    await session.flush()
    audit.record(
        session,
        ctx,
        "home_location.request",
        "home_location",
        row.id,
        after=_audit_view(row, replaced),
    )
    await session.commit()
    await session.refresh(row, ["created_at"])
    return row


async def my_home(session: AsyncSession, user_id: int) -> MyHomeOut:
    """What the employee may know about their own home location: its state, not its place."""
    rows = (
        await session.execute(
            select(
                HomeLocation.status,
                HomeLocation.radius_m,
                HomeLocation.created_at,
                HomeLocation.decided_at,
                HomeLocation.reject_reason,
            )
            .where(
                HomeLocation.user_id == user_id,
                HomeLocation.status.in_([HOME_APPROVED, HOME_PENDING, HOME_REJECTED]),
            )
            .order_by(HomeLocation.id.desc())
        )
    ).all()
    # Newest first, so the first rejected row is the latest rejection.
    latest = {row.status: row for row in reversed(rows)}
    approved, pending = latest.get(HOME_APPROVED), latest.get(HOME_PENDING)
    rejected = latest.get(HOME_REJECTED)
    return MyHomeOut(
        approved=approved
        and MyApprovedHome(radius_m=approved.radius_m, decided_at=approved.decided_at),
        pending=pending and MyPendingHome(created_at=pending.created_at),
        last_rejected=rejected
        and MyRejectedHome(reason=rejected.reject_reason, decided_at=rejected.decided_at),
    )
