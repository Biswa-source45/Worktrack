"""Where a punch is accepted: by day kind, home location and the home-branch restriction."""

from datetime import date
from typing import Any

import pytest
from geoalchemy2 import WKTElement
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.modules.branches.models import Branch
from app.modules.employees.models import User
from app.modules.schedule.models import HomeLocation
from app.modules.schedule.punch import PunchPlace, check_punch_location
from tests.factories import FIELD, make_branch, make_shift, make_user
from tests.modules.branches.test_geofence import point_at
from tests.modules.employees.test_branch_shift import Statements
from tests.modules.schedule.test_schedule import (
    MONDAY,
    SUNDAY,
    add_holiday,
    add_schedule,
)

# A few kilometres from the default test branch, well outside any fence.
HOME = {"lat": 20.35, "lng": 85.9}
NOWHERE = {"lat": 21.0, "lng": 86.5}


async def add_home(db: AsyncSession, user: User, status: str = "approved", **at: float) -> None:
    place = {**HOME, **at}
    db.add(
        HomeLocation(
            user_id=user.id,
            # Only a pending or approved row holds a location; the others have forgotten it.
            location=WKTElement(f"POINT({place['lng']} {place['lat']})", srid=4326)
            if status in ("pending", "approved")
            else None,
            radius_m=100,
            source="admin",
            status=status,
        )
    )
    await db.flush()


async def home_worker(db: AsyncSession, **fields: Any) -> User:
    """An employee whose schedule makes every day a home day."""
    user = await make_user(db, FIELD, **fields)
    await add_schedule(db, user, date(2027, 1, 1), ["home"] * 7)
    return user


async def punch(
    db: AsyncSession, user: User, at: dict[str, float], day: date = MONDAY, accuracy_m: float = 5
) -> PunchPlace:
    return await check_punch_location(db, user, day, **at, accuracy_m=accuracy_m)


async def refused(
    db: AsyncSession, user: User, at: dict[str, float], day: date = MONDAY, accuracy_m: float = 5
) -> AppError:
    with pytest.raises(AppError) as failure:
        await punch(db, user, at, day, accuracy_m)
    return failure.value


def is_outside(error: AppError, branch: Branch, metres: int) -> bool:
    assert (error.code, error.status_code) == ("OUTSIDE_GEOFENCE", 422)
    # The nearest branch and nothing else: no word about the home location.
    assert error.details == {"branch": branch.name, "distance_m": metres}
    assert f"{metres} m from {branch.name}" in error.message
    assert "home" not in error.message.lower()
    return True


# --- office day -------------------------------------------------------------------------------


async def test_office_day_at_a_branch_is_accepted(db: AsyncSession) -> None:
    branch = await make_branch(db)
    user = await make_user(db, FIELD)
    place = await punch(db, user, await point_at(db, branch, 40))
    assert place == PunchPlace("branch", branch.id, place.distance_m, "office")
    assert place.distance_m == pytest.approx(40, abs=0.001)


async def test_office_day_picks_the_branch_the_employee_is_at(db: AsyncSession) -> None:
    await make_branch(db)
    far = await make_branch(db, lat=20.31, lng=85.82)
    user = await make_user(db, FIELD)
    place = await punch(db, user, await point_at(db, far, 10))
    assert (place.type, place.branch_id) == ("branch", far.id)


async def test_office_day_at_home_is_refused_even_with_an_approved_home(db: AsyncSession) -> None:
    branch = await make_branch(db)
    user = await make_user(db, FIELD)
    await add_home(db, user)
    error = await refused(db, user, HOME)
    away = await punch_distance(db, branch, HOME)
    assert away > 5000
    assert is_outside(error, branch, away)


async def punch_distance(db: AsyncSession, branch: Branch, at: dict[str, float]) -> int:
    """Whole metres from the branch to a point, measured by PostGIS."""
    metres = await db.scalar(
        text(
            "SELECT ST_Distance(location, ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography)"
            " FROM branches WHERE id = :id"
        ),
        {**at, "id": branch.id},
    )
    return round(metres)


async def test_office_day_outside_every_fence_shows_the_nearest_branch(db: AsyncSession) -> None:
    near = await make_branch(db, radius_m=100)
    await make_branch(db, lat=20.31, lng=85.82)
    user = await make_user(db, FIELD)
    error = await refused(db, user, await point_at(db, near, 180))
    assert is_outside(error, near, 180)


async def test_without_any_branch_the_punch_is_refused_plainly(db: AsyncSession) -> None:
    user = await make_user(db, FIELD)
    error = await refused(db, user, NOWHERE)
    assert (error.code, error.details) == ("OUTSIDE_GEOFENCE", None)


# --- home day ---------------------------------------------------------------------------------


async def test_home_day_at_home_is_accepted_as_home(db: AsyncSession) -> None:
    await make_branch(db)
    user = await home_worker(db)
    await add_home(db, user)
    place = await punch(db, user, HOME)
    assert place == PunchPlace("home", None, 0.0, "home")


async def test_home_day_at_a_branch_is_accepted_as_that_branch(db: AsyncSession) -> None:
    branch = await make_branch(db)
    user = await home_worker(db)
    await add_home(db, user)
    place = await punch(db, user, await point_at(db, branch, 30))
    assert (place.type, place.branch_id, place.day_kind) == ("branch", branch.id, "home")


async def test_home_day_inside_both_fences_records_the_branch(db: AsyncSession) -> None:
    branch = await make_branch(db)
    user = await home_worker(db)
    # Home is 20 m from the branch centre; the punch is at home, so the home fence is nearer.
    home = await point_at(db, branch, 20)
    await add_home(db, user, **home)
    place = await punch(db, user, home)
    assert (place.type, place.branch_id) == ("branch", branch.id)
    assert place.distance_m == pytest.approx(20, abs=0.001)


async def test_home_day_at_neither_is_refused_and_only_the_branch_is_mentioned(
    db: AsyncSession,
) -> None:
    branch = await make_branch(db)
    user = await home_worker(db)
    await add_home(db, user)
    # 300 m from home, kilometres from the branch.
    near_home = {"lat": HOME["lat"] + 0.0027, "lng": HOME["lng"]}
    error = await refused(db, user, near_home)
    assert is_outside(error, branch, await punch_distance(db, branch, near_home))


@pytest.mark.parametrize("status", ["pending", "rejected", "replaced", "removed"])
async def test_only_an_approved_home_location_counts(db: AsyncSession, status: str) -> None:
    branch = await make_branch(db)
    user = await home_worker(db)
    await add_home(db, user, status)
    error = await refused(db, user, HOME)
    assert is_outside(error, branch, await punch_distance(db, branch, HOME))


async def test_another_employees_home_is_not_a_candidate(db: AsyncSession) -> None:
    await make_branch(db)
    user, neighbour = await home_worker(db), await home_worker(db)
    await add_home(db, neighbour)
    assert (await refused(db, user, HOME)).code == "OUTSIDE_GEOFENCE"
    assert (await punch(db, neighbour, HOME)).type == "home"


# --- off days ---------------------------------------------------------------------------------


async def test_a_holiday_blocks_the_punch(db: AsyncSession) -> None:
    branch = await make_branch(db)
    user = await make_user(db, FIELD)
    await add_holiday(db, MONDAY)
    error = await refused(db, user, await point_at(db, branch, 10))
    assert (error.code, error.status_code, error.details) == ("OFF_DAY", 409, {"reason": "holiday"})
    assert "holiday" in error.message


async def test_a_weekly_off_blocks_the_punch(db: AsyncSession) -> None:
    branch = await make_branch(db)
    shift = await make_shift(db)  # Sundays off
    user = await make_user(db, FIELD, shift_id=shift.id)
    error = await refused(db, user, await point_at(db, branch, 10), day=SUNDAY)
    assert (error.code, error.status_code) == ("OFF_DAY", 409)
    assert error.details == {"reason": "weekly_off"}
    assert "day off" in error.message


async def test_a_scheduled_off_day_blocks_the_punch_before_anything_else(db: AsyncSession) -> None:
    branch = await make_branch(db)
    user = await make_user(db, FIELD)
    await add_schedule(db, user, date(2027, 1, 1), ["off"] * 7)
    # Even a fix too poor to accept is answered with the off day, not with the accuracy.
    error = await refused(db, user, await point_at(db, branch, 10), accuracy_m=500)
    assert (error.code, error.details) == ("OFF_DAY", {"reason": "schedule"})


# --- restriction, accuracy, cost --------------------------------------------------------------


async def test_an_employee_restricted_to_the_home_branch_cannot_punch_at_another(
    db: AsyncSession,
) -> None:
    own = await make_branch(db)
    other = await make_branch(db, lat=20.31, lng=85.82)
    tied = await make_user(db, FIELD, home_branch_id=own.id, restrict_to_home_branch=True)
    free = await make_user(db, FIELD, home_branch_id=own.id)
    at_other = await point_at(db, other, 10)

    assert (await punch(db, free, at_other)).branch_id == other.id
    assert (await punch(db, tied, await point_at(db, own, 10))).branch_id == own.id
    error = await refused(db, tied, at_other)
    # They are told how far their own branch is, not the one they are standing in.
    assert is_outside(error, own, await punch_distance(db, own, at_other))


async def test_a_poor_fix_is_refused_on_a_working_day(db: AsyncSession) -> None:
    branch = await make_branch(db)
    user = await make_user(db, FIELD)
    at_branch = await point_at(db, branch, 10)
    error = await refused(db, user, at_branch, accuracy_m=50.5)
    assert (error.code, error.status_code) == ("GPS_ACCURACY_POOR", 422)
    assert (await punch(db, user, at_branch, accuracy_m=50)).type == "branch"


async def test_the_accuracy_buffer_applies_to_the_home_fence_too(db: AsyncSession) -> None:
    await make_branch(db)
    user = await home_worker(db)
    await add_home(db, user)
    # About 111 m north of home: outside the 100 m fence, inside it with a 20 m fix.
    near_home = {"lat": HOME["lat"] + 0.001, "lng": HOME["lng"]}
    assert (await refused(db, user, near_home, accuracy_m=5)).code == "OUTSIDE_GEOFENCE"
    assert (await punch(db, user, near_home, accuracy_m=20)).type == "home"


async def test_every_candidate_fence_is_measured_in_one_query(db: AsyncSession) -> None:
    for n in range(3):
        await make_branch(db, lat=20.29 + n / 100, lng=85.82)
    user = await home_worker(db)
    await add_home(db, user)
    with Statements() as statements:
        place = await punch(db, user, HOME)
    assert place.type == "home"
    measuring = [sql for sql in statements.sql if "ST_Distance" in sql]
    assert len(measuring) == 1
    assert "UNION ALL" in measuring[0]
    # Schedule rows, holidays, settings, fences.
    assert len(statements.sql) == 4
