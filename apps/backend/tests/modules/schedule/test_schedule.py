"""Weekly schedules and the day resolver: holiday, then schedule, then weekly off, then office."""

from datetime import date, timedelta
from typing import Any

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import today_ist
from app.modules.auth.permissions import EMPLOYEES_MANAGE, WEB_ACCESS
from app.modules.employees.models import User
from app.modules.schedule.models import WorkSchedule
from app.modules.schedule.service import DayPlan, plan_day, resolve_day, resolve_days
from app.modules.shifts.models import Holiday
from tests.factories import (
    ADMIN,
    FIELD,
    SUPER_ADMIN,
    headers_with,
    make_branch,
    make_shift,
    make_user,
)
from tests.modules.employees.helpers import EMPLOYEES, actor, audit_rows, error_code
from tests.modules.employees.test_branch_shift import Statements

# March 2027 starts on a Monday: Saturdays are 6, 13, 20, 27 and Sundays 7, 14, 21, 28.
MONDAY = date(2027, 3, 1)
FIRST_SATURDAY, SECOND_SATURDAY = date(2027, 3, 6), date(2027, 3, 13)
SUNDAY = date(2027, 3, 7)
SUNDAY_AND_ALTERNATE_SATURDAYS = [
    {"weekday": 6, "weeks": None},
    {"weekday": 5, "weeks": [2, 4]},
]
OFFICE_WEEK = ["office"] * 7
FOLLOW_SHIFT: list[str | None] = [None] * 7
OFFICE, WEEKLY_OFF = DayPlan("office", "shift"), DayPlan("off", "weekly_off")


def url(employee_id: int) -> str:
    return f"{EMPLOYEES}/{employee_id}/schedule"


def week(**days: str | None) -> list[str | None]:
    """A week that follows the shift except on the named days (mon..sun)."""
    names = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
    return [days.get(name) for name in names]


async def add_schedule(
    db: AsyncSession, user: User, effective_from: date, days: list[Any]
) -> WorkSchedule:
    row = WorkSchedule(user_id=user.id, effective_from=effective_from, days=days)
    db.add(row)
    await db.flush()
    return row


async def add_holiday(db: AsyncSession, day: date, branch_id: int | None = None) -> None:
    db.add(Holiday(date=day, name="Holiday", branch_id=branch_id))
    await db.flush()


async def employee(db: AsyncSession, **fields: Any) -> User:
    shift = await make_shift(db, weekly_offs=SUNDAY_AND_ALTERNATE_SATURDAYS)
    return await make_user(db, FIELD, shift_id=shift.id, **fields)


# --- the rule itself (pure) -------------------------------------------------------------------


def plan(day: date, **given: Any) -> DayPlan:
    return plan_day(
        day,
        holidays=given.get("holidays", set()),
        schedules=given.get("schedules", []),
        weekly_offs=given.get("weekly_offs", SUNDAY_AND_ALTERNATE_SATURDAYS),
    )


def test_a_plain_working_day_is_an_office_day() -> None:
    assert plan(MONDAY) == OFFICE
    assert plan(FIRST_SATURDAY) == OFFICE


def test_the_shifts_weekly_offs_are_off() -> None:
    assert plan(SUNDAY) == WEEKLY_OFF
    assert plan(SECOND_SATURDAY) == WEEKLY_OFF


def test_without_a_shift_or_schedule_every_day_is_an_office_day() -> None:
    assert plan(SUNDAY, weekly_offs=[]) == OFFICE
    assert plan(SECOND_SATURDAY, weekly_offs=[]) == OFFICE


def test_a_holiday_is_off_whatever_else_says() -> None:
    home_all_week = [(MONDAY, ["home"] * 7)]
    assert plan(MONDAY, holidays={MONDAY}) == DayPlan("off", "holiday")
    assert plan(MONDAY, holidays={MONDAY}, schedules=home_all_week) == DayPlan("off", "holiday")
    assert plan(SUNDAY, holidays={SUNDAY}) == DayPlan("off", "holiday")


def test_the_schedule_overrides_the_shift_on_the_days_it_names() -> None:
    schedules = [(MONDAY, week(wed="home", sat="home", sun="office", fri="off"))]
    assert plan(date(2027, 3, 3), schedules=schedules) == DayPlan("home", "schedule")
    assert plan(date(2027, 3, 5), schedules=schedules) == DayPlan("off", "schedule")
    # The second Saturday is a weekly off, but the schedule says home; Sunday becomes a work day.
    assert plan(SECOND_SATURDAY, schedules=schedules) == DayPlan("home", "schedule")
    assert plan(SUNDAY, schedules=schedules) == DayPlan("office", "schedule")
    # Days the schedule leaves empty still follow the shift.
    assert plan(MONDAY, schedules=schedules) == OFFICE
    assert plan(SUNDAY, schedules=[(MONDAY, week(wed="home"))]) == WEEKLY_OFF


def test_the_row_in_force_is_the_latest_one_that_has_started() -> None:
    schedules = [
        (date(2027, 3, 15), week(mon="off")),
        (date(2027, 3, 8), week(mon="home")),
    ]
    assert plan(date(2027, 3, 1), schedules=schedules) == OFFICE  # before any row
    assert plan(date(2027, 3, 8), schedules=schedules) == DayPlan("home", "schedule")
    assert plan(date(2027, 3, 15), schedules=schedules) == DayPlan("off", "schedule")
    assert plan(date(2027, 3, 22), schedules=schedules) == DayPlan("off", "schedule")


# --- resolving from the database --------------------------------------------------------------


async def test_effective_from_boundary_and_a_row_that_has_not_started(db: AsyncSession) -> None:
    user = await employee(db)
    await add_schedule(db, user, date(2027, 3, 10), week(tue="home", wed="home", thu="home"))
    await add_schedule(db, user, date(2027, 4, 1), ["off"] * 7)
    resolved = dict(await resolve_days(db, user, date(2027, 3, 9), date(2027, 3, 11)))
    assert resolved == {
        date(2027, 3, 9): OFFICE,  # the day before: the row is not in force yet
        date(2027, 3, 10): DayPlan("home", "schedule"),
        date(2027, 3, 11): DayPlan("home", "schedule"),
    }
    # The April row is in the future on 31 March and in force on 1 April.
    assert await resolve_day(db, user, date(2027, 3, 31)) == DayPlan("home", "schedule")
    assert await resolve_day(db, user, date(2027, 4, 1)) == DayPlan("off", "schedule")


async def test_a_branch_holiday_applies_only_to_that_home_branch(db: AsyncSession) -> None:
    here, there = await make_branch(db), await make_branch(db)
    local = await employee(db, home_branch_id=here.id)
    elsewhere = await employee(db, home_branch_id=there.id)
    nowhere = await employee(db)
    await add_holiday(db, MONDAY, here.id)
    await add_holiday(db, MONDAY + timedelta(days=1))
    holiday = DayPlan("off", "holiday")
    assert await resolve_day(db, local, MONDAY) == holiday
    assert await resolve_day(db, elsewhere, MONDAY) == OFFICE
    assert await resolve_day(db, nowhere, MONDAY) == OFFICE
    for user in (local, elsewhere, nowhere):
        assert await resolve_day(db, user, MONDAY + timedelta(days=1)) == holiday


async def test_a_holiday_beats_a_home_day_and_a_home_day_beats_a_weekly_off(
    db: AsyncSession,
) -> None:
    user = await employee(db)
    await add_schedule(db, user, MONDAY, week(mon="home", sat="home"))
    await add_holiday(db, date(2027, 3, 8))
    assert await resolve_day(db, user, MONDAY) == DayPlan("home", "schedule")
    assert await resolve_day(db, user, date(2027, 3, 8)) == DayPlan("off", "holiday")
    assert await resolve_day(db, user, SECOND_SATURDAY) == DayPlan("home", "schedule")
    assert await resolve_day(db, user, SUNDAY) == WEEKLY_OFF


async def test_an_employee_without_a_shift_or_schedule_works_every_non_holiday(
    db: AsyncSession,
) -> None:
    user = await make_user(db, FIELD)
    await add_holiday(db, date(2027, 3, 4))
    resolved = await resolve_days(db, user, MONDAY, SUNDAY)
    assert [p.kind for _, p in resolved] == ["office"] * 3 + ["off"] + ["office"] * 3
    assert [d for d, _ in resolved] == [MONDAY + timedelta(days=n) for n in range(7)]


async def test_a_month_is_resolved_in_two_queries(db: AsyncSession) -> None:
    branch = await make_branch(db)
    user = await employee(db, home_branch_id=branch.id)
    for n in range(4):
        await add_schedule(db, user, MONDAY + timedelta(days=7 * n), week(wed="home"))
    for day in (2, 9, 16):
        await add_holiday(db, date(2027, 3, day), branch.id)
    with Statements() as statements:
        resolved = await resolve_days(db, user, MONDAY, date(2027, 3, 31))
    assert len(resolved) == 31
    assert len(statements.sql) == 2
    assert len(statements.reading("work_schedules")) == 1
    assert len(statements.reading("holidays")) == 1
    kinds = [p.kind for _, p in resolved]
    assert (kinds.count("home"), kinds.count("off")) == (5, 3 + 4 + 2)


# --- GET --------------------------------------------------------------------------------------


async def test_get_returns_the_rows_newest_first_and_the_resolved_days(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    user = await employee(db)
    old = await add_schedule(db, user, date(2027, 2, 1), OFFICE_WEEK)
    new = await add_schedule(db, user, MONDAY, week(wed="home"))
    params = {"from": "2027-03-01", "to": "2027-03-07"}
    response = await client.get(url(user.id), params=params, headers=headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert [row["id"] for row in body["rows"]] == [new.id, old.id]
    assert body["rows"][0]["effective_from"] == "2027-03-01"
    assert body["rows"][0]["days"] == week(wed="home")
    assert set(body["rows"][0]) == {"id", "effective_from", "days", "created_at"}
    assert body["resolved"] == [
        {"date": "2027-03-01", "kind": "office", "reason": "shift"},
        {"date": "2027-03-02", "kind": "office", "reason": "shift"},
        {"date": "2027-03-03", "kind": "home", "reason": "schedule"},
        {"date": "2027-03-04", "kind": "office", "reason": "shift"},
        {"date": "2027-03-05", "kind": "office", "reason": "shift"},
        {"date": "2027-03-06", "kind": "office", "reason": "shift"},
        {"date": "2027-03-07", "kind": "off", "reason": "weekly_off"},
    ]


async def test_get_defaults_to_the_next_two_weeks(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    user = await make_user(db, FIELD)
    body = (await client.get(url(user.id), headers=headers)).json()
    today = today_ist()
    assert body["rows"] == []
    assert [day["date"] for day in body["resolved"]] == [
        (today + timedelta(days=n)).isoformat() for n in range(14)
    ]


@pytest.mark.parametrize(
    ("params", "days"),
    [
        ({"from": "2027-03-01", "to": "2027-05-01"}, 62),
        ({"from": "2027-03-01", "to": "2027-03-01"}, 1),
        ({"from": "2027-03-01"}, 14),
    ],
)
async def test_get_accepts_up_to_62_days(
    client: httpx.AsyncClient, db: AsyncSession, params: dict[str, str], days: int
) -> None:
    _, headers = await actor(client, db)
    user = await make_user(db, FIELD)
    response = await client.get(url(user.id), params=params, headers=headers)
    assert response.status_code == 200
    assert len(response.json()["resolved"]) == days


@pytest.mark.parametrize(
    "params",
    [
        {"from": "2027-03-01", "to": "2027-05-02"},
        {"from": "2027-03-02", "to": "2027-03-01"},
        {"from": "soon"},
    ],
)
async def test_get_rejects_a_range_that_is_too_long_or_backwards(
    client: httpx.AsyncClient, db: AsyncSession, params: dict[str, str]
) -> None:
    _, headers = await actor(client, db)
    user = await make_user(db, FIELD)
    response = await client.get(url(user.id), params=params, headers=headers)
    assert (response.status_code, error_code(response)) == (422, "VALIDATION_ERROR")


# --- PUT --------------------------------------------------------------------------------------


async def test_put_creates_a_row_and_keeps_history(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    admin, headers = await actor(client, db)
    user = await employee(db)
    past = await add_schedule(db, user, today_ist() - timedelta(days=30), OFFICE_WEEK)
    body = {"effective_from": today_ist().isoformat(), "days": week(tue="home", thu="home")}
    response = await client.put(url(user.id), json=body, headers=headers)
    assert response.status_code == 200, response.text
    created = response.json()
    assert (created["effective_from"], created["days"]) == (body["effective_from"], body["days"])

    rows = (await client.get(url(user.id), headers=headers)).json()["rows"]
    assert [row["id"] for row in rows] == [created["id"], past.id]
    await db.refresh(past)
    assert past.days == OFFICE_WEEK

    [row] = await audit_rows(db, "schedule.set")
    assert (row.actor_id, row.entity, row.entity_id) == (
        admin.id,
        "work_schedule",
        str(created["id"]),
    )
    assert row.before is None
    assert row.after == {"user_id": user.id, **body}
    stored = await db.get(WorkSchedule, created["id"])
    assert stored is not None and stored.created_by == admin.id


async def test_put_on_the_same_date_replaces_that_row(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    user = await employee(db)
    start = (today_ist() + timedelta(days=3)).isoformat()
    first = await client.put(
        url(user.id), json={"effective_from": start, "days": week(mon="home")}, headers=headers
    )
    second = await client.put(
        url(user.id), json={"effective_from": start, "days": week(fri="off")}, headers=headers
    )
    assert second.status_code == 200
    assert second.json()["id"] == first.json()["id"]
    assert second.json()["days"] == week(fri="off")
    stored = (await db.execute(select(WorkSchedule).where(WorkSchedule.user_id == user.id))).all()
    assert len(stored) == 1

    _, replaced = await audit_rows(db, "schedule.set")
    assert (replaced.before or {})["days"] == week(mon="home")
    assert (replaced.after or {})["days"] == week(fri="off")


async def test_put_refuses_a_date_in_the_past(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    user = await employee(db)
    body = {"effective_from": (today_ist() - timedelta(days=1)).isoformat(), "days": OFFICE_WEEK}
    response = await client.put(url(user.id), json=body, headers=headers)
    assert (response.status_code, error_code(response)) == (422, "SCHEDULE_BACKDATED")
    assert await audit_rows(db, "schedule.set") == []
    assert (await client.get(url(user.id), headers=headers)).json()["rows"] == []


@pytest.mark.parametrize(
    "days",
    [
        ["office"] * 6,
        ["office"] * 8,
        [*["office"] * 6, "remote"],
        [*["office"] * 6, 1],
        None,
        "office",
    ],
)
async def test_put_needs_exactly_seven_valid_days(
    client: httpx.AsyncClient, db: AsyncSession, days: Any
) -> None:
    _, headers = await actor(client, db)
    user = await employee(db)
    body = {"effective_from": today_ist().isoformat(), "days": days}
    response = await client.put(url(user.id), json=body, headers=headers)
    assert (response.status_code, error_code(response)) == (422, "VALIDATION_ERROR")


async def test_a_week_that_follows_the_shift_everywhere_is_valid(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    user = await employee(db)
    body = {"effective_from": today_ist().isoformat(), "days": FOLLOW_SHIFT}
    assert (await client.put(url(user.id), json=body, headers=headers)).status_code == 200


# --- permissions ------------------------------------------------------------------------------


async def test_schedule_permissions(client: httpx.AsyncClient, db: AsyncSession) -> None:
    user = await employee(db)
    boss = await make_user(db, SUPER_ADMIN)
    body = {"effective_from": today_ist().isoformat(), "days": OFFICE_WEEK}
    allowed = await headers_with(client, db, EMPLOYEES_MANAGE)
    denied = await headers_with(client, db, WEB_ACCESS)

    assert (await client.get(url(user.id), headers=allowed)).status_code == 200
    assert (await client.put(url(user.id), json=body, headers=allowed)).status_code == 200
    for response in (
        await client.get(url(user.id), headers=denied),
        await client.put(url(user.id), json=body, headers=denied),
        # employees.manage is not enough for an account that outranks the actor.
        await client.get(url(boss.id), headers=allowed),
        await client.put(url(boss.id), json=body, headers=allowed),
    ):
        assert (response.status_code, error_code(response)) == (403, "FORBIDDEN")
    assert len(await audit_rows(db, "schedule.set")) == 1

    _, admin_headers = await actor(client, db, ADMIN)
    assert (await client.get(url(boss.id), headers=admin_headers)).status_code == 403
    missing = await client.get(url(999_999_999), headers=admin_headers)
    assert (missing.status_code, error_code(missing)) == (404, "NOT_FOUND")
