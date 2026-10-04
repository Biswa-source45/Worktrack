"""Geofence check (BR-05). It always runs here, on the server, in PostGIS (invariant 2)."""

from collections.abc import Sequence

from geoalchemy2 import Geography, WKBElement, WKTElement
from sqlalchemy import Float, Row, Select, cast, func, literal, select, union_all
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.modules.branches.models import Branch
from app.modules.org_settings.schemas import OrgSettings


def ensure_accuracy(settings: OrgSettings, accuracy_m: float) -> None:
    """A fix worse than the configured threshold is not accepted, wherever it claims to be."""
    if accuracy_m > settings.gps_max_accuracy_m:
        raise AppError(
            "GPS_ACCURACY_POOR",
            "Your location is not accurate enough. Move to an open area and try again.",
            422,
            {"accuracy_m": accuracy_m, "max_accuracy_m": settings.gps_max_accuracy_m},
        )


# A source of candidate fences: kind, id, name, location, radius_m.
Candidates = Select[str, int, str, WKBElement | WKTElement, int]


def branch_candidates(branch_id: int | None = None) -> Candidates:
    """Active branches as geofence candidates (kind "branch"), or just the one given."""
    stmt = select(
        literal("branch").label("kind"), Branch.id, Branch.name, Branch.location, Branch.radius_m
    ).where(Branch.is_active)
    if branch_id is not None:
        stmt = stmt.where(Branch.id == branch_id)
    return stmt


async def nearest_geofences(
    session: AsyncSession,
    settings: OrgSettings,
    *,
    lat: float,
    lng: float,
    accuracy_m: float,
    branch_id: int | None = None,
    extra: Candidates | None = None,
) -> Sequence[Row[str, int, str, int, float, bool]]:
    """Every candidate fence with its `distance_m` and whether the point is `inside`, nearest first.

    Inside means distance(centre, point) <= radius + min(accuracy, buffer cap). The candidates
    are the active branches (or only `branch_id`) plus those of `extra`, all in one query.
    """
    branches = branch_candidates(branch_id)
    fence = (branches if extra is None else union_all(branches, extra)).subquery("fence")
    point = cast(func.ST_SetSRID(func.ST_MakePoint(lng, lat), 4326), Geography)
    reach = fence.c.radius_m + func.least(accuracy_m, settings.geofence_accuracy_buffer_cap_m)
    # The verdict uses the very distance that is reported, so the two can never disagree.
    # ST_Distance rounds to 10 nm; ST_DWithin does not, and calls a point that is exactly on the
    # edge outside as often as inside. Every fence is measured anyway, so no index is given up.
    distance = func.ST_Distance(fence.c.location, point, type_=Float)
    stmt = select(
        fence.c.kind,
        fence.c.id,
        fence.c.name,
        fence.c.radius_m,
        distance.label("distance_m"),
        (distance <= reach).label("inside"),
    ).order_by(distance, fence.c.id)
    return (await session.execute(stmt)).all()
