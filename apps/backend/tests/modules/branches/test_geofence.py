"""BR-05: inside when distance(centre, point) <= radius + min(accuracy, buffer cap)."""

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.modules.audit.service import AuditCtx
from app.modules.branches.geofence import ensure_accuracy, nearest_geofences
from app.modules.branches.models import Branch
from app.modules.org_settings import service as settings_service
from app.modules.org_settings.schemas import OrgSettings
from tests.factories import make_branch

DEFAULTS = OrgSettings()


async def point_at(
    db: AsyncSession, branch: Branch, metres: float, bearing: float = 90.0
) -> dict[str, float]:
    """The point exactly `metres` from the branch centre (PostGIS projects it on the spheroid)."""
    row = (
        await db.execute(
            text(
                "SELECT ST_Y(p::geometry) AS lat, ST_X(p::geometry) AS lng FROM (SELECT"
                " ST_Project(location, CAST(:metres AS float8),"
                " radians(CAST(:bearing AS float8))) AS p"
                " FROM branches WHERE id = :id) AS projected"
            ),
            {"metres": metres, "bearing": bearing, "id": branch.id},
        )
    ).one()
    return {"lat": row.lat, "lng": row.lng}


async def inside(
    db: AsyncSession,
    branch: Branch,
    metres: float,
    accuracy_m: float = 0,
    settings: OrgSettings = DEFAULTS,
) -> bool:
    [fence] = await nearest_geofences(
        db,
        settings,
        **await point_at(db, branch, metres),
        accuracy_m=accuracy_m,
        branch_id=branch.id,
    )
    assert fence.distance_m == pytest.approx(metres, abs=0.001)
    return bool(fence.inside)


async def test_a_point_inside_the_radius_passes(db: AsyncSession) -> None:
    branch = await make_branch(db, radius_m=100)
    assert await inside(db, branch, 50)
    assert await inside(db, branch, 0)


@pytest.mark.parametrize("bearing", [0.0, 45.0, 90.0, 135.0, 180.0, 225.0, 270.0, 315.0])
async def test_a_point_exactly_on_the_edge_passes_and_one_metre_further_fails(
    db: AsyncSession, bearing: float
) -> None:
    branch = await make_branch(db, radius_m=100)
    on_edge = await point_at(db, branch, 100, bearing)
    beyond = await point_at(db, branch, 101, bearing)
    [fence] = await nearest_geofences(db, DEFAULTS, **on_edge, accuracy_m=0, branch_id=branch.id)
    assert fence.inside is True
    [fence] = await nearest_geofences(db, DEFAULTS, **beyond, accuracy_m=0, branch_id=branch.id)
    assert fence.inside is False


async def test_a_point_outside_the_radius_fails(db: AsyncSession) -> None:
    branch = await make_branch(db, radius_m=100)
    assert not await inside(db, branch, 150)


async def test_gps_accuracy_widens_the_fence(db: AsyncSession) -> None:
    branch = await make_branch(db, radius_m=100)
    assert not await inside(db, branch, 120, accuracy_m=0)
    assert not await inside(db, branch, 120, accuracy_m=19)
    assert await inside(db, branch, 120, accuracy_m=25)


async def test_the_accuracy_buffer_is_capped(db: AsyncSession) -> None:
    branch = await make_branch(db, radius_m=100)
    # An accuracy of 45 m is acceptable once the threshold is raised, but it only buys 30 m.
    lenient = OrgSettings(gps_max_accuracy_m=100)
    ensure_accuracy(lenient, 45)
    assert not await inside(db, branch, 140, accuracy_m=45, settings=lenient)
    assert await inside(db, branch, 130, accuracy_m=45, settings=lenient)
    assert not await inside(db, branch, 131, accuracy_m=45, settings=lenient)


async def test_the_buffer_cap_comes_from_the_stored_settings(db: AsyncSession) -> None:
    branch = await make_branch(db, radius_m=100)
    await settings_service.update(
        db, AuditCtx(None, None), OrgSettings(geofence_accuracy_buffer_cap_m=0)
    )
    stored = await settings_service.get_org_settings(db)
    assert not await inside(db, branch, 101, accuracy_m=25, settings=stored)
    assert await inside(db, branch, 100, accuracy_m=25, settings=stored)


@pytest.mark.parametrize("accuracy", [0, 12.5, 50])
def test_accuracy_within_the_threshold_is_accepted(accuracy: float) -> None:
    ensure_accuracy(DEFAULTS, accuracy)


@pytest.mark.parametrize("accuracy", [50.1, 200])
def test_poor_accuracy_is_rejected(accuracy: float) -> None:
    with pytest.raises(AppError) as failure:
        ensure_accuracy(DEFAULTS, accuracy)
    assert failure.value.code == "GPS_ACCURACY_POOR"
    assert failure.value.status_code == 422
    assert failure.value.details == {"accuracy_m": accuracy, "max_accuracy_m": 50}


def test_the_accuracy_threshold_comes_from_settings() -> None:
    ensure_accuracy(OrgSettings(gps_max_accuracy_m=200), 200)
    with pytest.raises(AppError):
        ensure_accuracy(OrgSettings(gps_max_accuracy_m=10), 11)


async def test_an_inactive_branch_is_ignored(db: AsyncSession) -> None:
    active = await make_branch(db)
    closed = await make_branch(db, is_active=False)
    point = await point_at(db, closed, 10)
    fences = await nearest_geofences(db, DEFAULTS, **point, accuracy_m=0)
    assert [f.id for f in fences] == [active.id]
    assert await nearest_geofences(db, DEFAULTS, **point, accuracy_m=0, branch_id=closed.id) == []


async def test_fences_come_back_nearest_first_with_their_distance(db: AsyncSession) -> None:
    # About 1.1 km apart, north to south.
    north = await make_branch(db, lat=20.31, lng=85.82, radius_m=100)
    south = await make_branch(db, lat=20.30, lng=85.82, radius_m=500)
    point = await point_at(db, south, 300, bearing=0)
    fences = await nearest_geofences(db, DEFAULTS, **point, accuracy_m=10)
    assert [(f.id, f.name, f.radius_m, f.inside) for f in fences] == [
        (south.id, south.name, 500, True),
        (north.id, north.name, 100, False),
    ]
    assert fences[0].distance_m == pytest.approx(300, abs=0.001)
    assert 700 < fences[1].distance_m < 900

    [only] = await nearest_geofences(db, DEFAULTS, **point, accuracy_m=10, branch_id=north.id)
    assert (only.id, only.inside) == (north.id, False)
