"""Geofence check (BR-05). It always runs here, on the server, in PostGIS (invariant 2)."""

from collections.abc import Sequence

from geoalchemy2 import Geography, WKBElement, WKTElement
from sqlalchemy import Float, Row, Select, cast, func, select
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


def branch_candidates(
    branch_id: int | None = None,
) -> Select[int, str, WKBElement | WKTElement, int]:
    """Active branches as geofence candidates: id, name, location, radius_m.

    Another source of fences with the same four columns can be UNIONed with this one.
    """
    stmt = select(Branch.id, Branch.name, Branch.location, Branch.radius_m).where(Branch.is_active)
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
) -> Sequence[Row[int, str, int, float, bool]]:
    """Every candidate fence with its `distance_m` and whether the point is `inside`, nearest first.

    Inside means distance(centre, point) <= radius + min(accuracy, buffer cap). One query.
    """
    fence = branch_candidates(branch_id).subquery("fence")
    point = cast(func.ST_SetSRID(func.ST_MakePoint(lng, lat), 4326), Geography)
    reach = fence.c.radius_m + func.least(accuracy_m, settings.geofence_accuracy_buffer_cap_m)
    # The verdict uses the very distance that is reported, so the two can never disagree.
    # ST_Distance rounds to 10 nm; ST_DWithin does not, and calls a point that is exactly on the
    # edge outside as often as inside. Every fence is measured anyway, so no index is given up.
    distance = func.ST_Distance(fence.c.location, point, type_=Float)
    stmt = select(
        fence.c.id,
        fence.c.name,
        fence.c.radius_m,
        distance.label("distance_m"),
        (distance <= reach).label("inside"),
    ).order_by(distance, fence.c.id)
    return (await session.execute(stmt)).all()
