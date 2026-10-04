from collections.abc import Sequence
from typing import Any

from geoalchemy2 import WKTElement
from sqlalchemy import Row, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.modules.audit import service as audit
from app.modules.audit.service import AuditCtx
from app.modules.branches.models import Branch
from app.modules.branches.schemas import BranchCreate, BranchUpdate
from app.modules.employees.service import parse_cursor
from app.modules.org_settings.service import get_org_settings


def snapshot(branch: Branch) -> dict[str, Any]:
    return {
        "name": branch.name,
        "address": branch.address,
        "lat": branch.lat,
        "lng": branch.lng,
        "radius_m": branch.radius_m,
        "is_active": branch.is_active,
    }


def _point(lat: float, lng: float) -> WKTElement:
    return WKTElement(f"POINT({lng} {lat})", srid=4326)


def _duplicate() -> AppError:
    return AppError("DUPLICATE", "A branch with that name already exists.", 409)


async def _check_name_free(session: AsyncSession, name: str, exclude: int | None) -> None:
    stmt = select(Branch.id).where(func.lower(Branch.name) == name.lower())
    if exclude is not None:
        stmt = stmt.where(Branch.id != exclude)
    if (await session.execute(stmt)).first():
        raise _duplicate()


async def get_branch(session: AsyncSession, branch_id: int) -> Branch:
    branch = await session.get(Branch, branch_id)
    if branch is None:
        raise AppError("NOT_FOUND", "Branch not found.", 404)
    return branch


async def list_branches(
    session: AsyncSession, *, is_active: bool | None, limit: int, cursor: str | None
) -> tuple[list[Branch], str | None]:
    stmt = select(Branch).where(Branch.id > parse_cursor(cursor)).order_by(Branch.id)
    if is_active is not None:
        stmt = stmt.where(Branch.is_active == is_active)
    rows = list((await session.execute(stmt.limit(limit + 1))).scalars())
    if len(rows) > limit:
        return rows[:limit], str(rows[limit - 1].id)
    return rows, None


async def active_branch_names(session: AsyncSession) -> Sequence[Row[int, str]]:
    """Id and name of the active branches, for pickers."""
    stmt = select(Branch.id, Branch.name).where(Branch.is_active).order_by(Branch.name)
    return (await session.execute(stmt)).all()


async def _save(session: AsyncSession, branch: Branch) -> None:
    try:
        await session.flush()
    except IntegrityError:
        raise _duplicate() from None
    # lat and lng are computed by PostGIS from the stored point.
    await session.refresh(branch)


async def create_branch(session: AsyncSession, ctx: AuditCtx, data: BranchCreate) -> Branch:
    await _check_name_free(session, data.name, None)
    radius = data.radius_m
    if radius is None:
        radius = (await get_org_settings(session)).geofence_default_radius_m
    branch = Branch(
        name=data.name,
        address=data.address or None,
        location=_point(data.lat, data.lng),
        radius_m=radius,
    )
    session.add(branch)
    await _save(session, branch)
    audit.record(session, ctx, "branch.create", "branch", branch.id, after=snapshot(branch))
    await session.commit()
    return branch


async def update_branch(
    session: AsyncSession, ctx: AuditCtx, branch_id: int, data: BranchUpdate
) -> Branch:
    branch = await get_branch(session, branch_id)
    changes = data.model_dump(exclude_unset=True)
    before = snapshot(branch)
    if "name" in changes:
        await _check_name_free(session, changes["name"], branch.id)
    if "address" in changes:
        changes["address"] = changes["address"] or None
    if "lat" in changes or "lng" in changes:
        branch.location = _point(changes.pop("lat", branch.lat), changes.pop("lng", branch.lng))
    for field, value in changes.items():
        setattr(branch, field, value)
    await _save(session, branch)
    audit.record(
        session, ctx, "branch.update", "branch", branch.id, before=before, after=snapshot(branch)
    )
    await session.commit()
    return branch
