from datetime import date, timedelta
from typing import Any

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.auth.permissions import BRANCHES_MANAGE, EMPLOYEES_MANAGE
from app.modules.shifts.service import is_weekly_off
from tests.factories import FIELD, auth_headers, headers_with, make_shift, make_user
from tests.modules.employees.helpers import API, actor, audit_rows, error_code

SHIFTS = f"{API}/admin/shifts"
PICKER = f"{API}/shifts"
SUNDAY = {"weekday": 6, "weeks": None}
SECOND_AND_FOURTH_SATURDAY = {"weekday": 5, "weeks": [2, 4]}
GENERAL: dict[str, Any] = {
    "name": "General",
    "start_time": "09:30:00",
    "end_time": "18:30:00",
    "grace_min": 10,
    "half_day_hours": 4.5,
    "full_day_hours": 8,
    "weekly_offs": [SUNDAY, SECOND_AND_FOURTH_SATURDAY],
}


def url(shift_id: int) -> str:
    return f"{SHIFTS}/{shift_id}"


# --- weekly offs (pure) -----------------------------------------------------------------------


def _days(year: int, month: int, weekday: int) -> list[date]:
    day, found = date(year, month, 1), []
    while day.month == month:
        if day.weekday() == weekday:
            found.append(day)
        day += timedelta(days=1)
    return found


def test_every_sunday_is_off() -> None:
    offs = [SUNDAY, SECOND_AND_FOURTH_SATURDAY]
    sundays = [d for month in range(1, 13) for d in _days(2026, month, 6)]
    assert len(sundays) == 52
    assert all(is_weekly_off(offs, day) for day in sundays)


def test_second_and_fourth_saturdays_are_off_and_the_others_are_working_days() -> None:
    offs = [SUNDAY, SECOND_AND_FOURTH_SATURDAY]
    # October 2026 has five Saturdays: 3, 10, 17, 24, 31.
    saturdays = _days(2026, 10, 5)
    assert [d.day for d in saturdays] == [3, 10, 17, 24, 31]
    assert [is_weekly_off(offs, d) for d in saturdays] == [False, True, False, True, False]
    # A month that starts on a Saturday: 1, 8, 15, 22, 29 (August 2026).
    saturdays = _days(2026, 8, 5)
    assert [d.day for d in saturdays] == [1, 8, 15, 22, 29]
    assert [is_weekly_off(offs, d) for d in saturdays] == [False, True, False, True, False]


def test_weekdays_that_are_not_listed_are_working_days() -> None:
    offs = [SUNDAY, SECOND_AND_FOURTH_SATURDAY]
    week = [date(2026, 10, 5) + timedelta(days=n) for n in range(5)]  # Monday to Friday
    assert not any(is_weekly_off(offs, day) for day in week)
    assert not is_weekly_off([], date(2026, 10, 4))


def test_a_fifth_occurrence_can_be_an_off_day() -> None:
    offs = [{"weekday": 5, "weeks": [5]}]
    assert [is_weekly_off(offs, d) for d in _days(2026, 10, 5)] == [False] * 4 + [True]
    # February 2026 has only four Saturdays, so none of them is off.
    assert not any(is_weekly_off(offs, d) for d in _days(2026, 2, 5))


# --- create -----------------------------------------------------------------------------------


async def test_create_returns_the_shift(client: httpx.AsyncClient, db: AsyncSession) -> None:
    admin, headers = await actor(client, db)
    response = await client.post(SHIFTS, json=GENERAL, headers=headers)
    assert response.status_code == 201, response.text
    body = response.json()
    assert body == {**GENERAL, "id": body["id"], "full_day_hours": 8.0, "is_active": True}

    [row] = await audit_rows(db, "shift.create")
    assert (row.actor_id, row.entity, row.entity_id) == (admin.id, "shift", str(body["id"]))
    assert row.after == {**GENERAL, "full_day_hours": 8.0, "is_active": True}


async def test_weekly_offs_default_to_none(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    body = {key: value for key, value in GENERAL.items() if key != "weekly_offs"}
    response = await client.post(SHIFTS, json=body, headers=headers)
    assert response.status_code == 201
    assert response.json()["weekly_offs"] == []


@pytest.mark.parametrize(
    ("change", "field"),
    [
        ({"weekly_offs": [SUNDAY, {"weekday": 6, "weeks": [1]}]}, "weekly_offs"),
        ({"weekly_offs": [{"weekday": 7, "weeks": None}]}, "weekly_offs"),
        ({"weekly_offs": [{"weekday": -1, "weeks": None}]}, "weekly_offs"),
        ({"weekly_offs": [{"weekday": 5, "weeks": []}]}, "weekly_offs"),
        ({"weekly_offs": [{"weekday": 5, "weeks": [4, 2]}]}, "weekly_offs"),
        ({"weekly_offs": [{"weekday": 5, "weeks": [2, 2]}]}, "weekly_offs"),
        ({"weekly_offs": [{"weekday": 5, "weeks": [0]}]}, "weekly_offs"),
        ({"weekly_offs": [{"weekday": 5, "weeks": [6]}]}, "weekly_offs"),
        ({"weekly_offs": [{"weeks": [2]}]}, "weekly_offs"),
        ({"grace_min": -1}, "grace_min"),
        ({"grace_min": 121}, "grace_min"),
        ({"half_day_hours": 0}, "half_day_hours"),
        ({"full_day_hours": 24.5}, "full_day_hours"),
        ({"half_day_hours": 4.555}, "half_day_hours"),
        ({"start_time": "25:00"}, "start_time"),
        ({"name": ""}, "name"),
        ({"name": "x" * 65}, "name"),
    ],
)
async def test_create_rejects_bad_fields(
    client: httpx.AsyncClient, db: AsyncSession, change: dict[str, Any], field: str
) -> None:
    _, headers = await actor(client, db)
    response = await client.post(SHIFTS, json={**GENERAL, **change}, headers=headers)
    assert (response.status_code, error_code(response)) == (422, "VALIDATION_ERROR")
    assert response.json()["error"]["details"][0]["loc"][:2] == ["body", field]


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"start_time": "22:00", "end_time": "06:00"}, "overnight shifts are not supported"),
        ({"start_time": "09:00", "end_time": "09:00"}, "must end after it starts"),
        ({"half_day_hours": 9}, "Half-day hours cannot be more than full-day hours"),
        ({"start_time": "09:00+05:30"}, "without a time zone"),
    ],
)
async def test_create_rejects_fields_that_do_not_fit_together(
    client: httpx.AsyncClient, db: AsyncSession, change: dict[str, Any], message: str
) -> None:
    _, headers = await actor(client, db)
    response = await client.post(SHIFTS, json={**GENERAL, **change}, headers=headers)
    assert (response.status_code, error_code(response)) == (422, "VALIDATION_ERROR")
    assert message in response.json()["error"]["details"][0]["message"]
    assert await audit_rows(db, "shift.create") == []


async def test_half_day_may_equal_full_day_and_grace_bounds_are_inclusive(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    body = {**GENERAL, "half_day_hours": 8, "full_day_hours": 8, "grace_min": 120}
    assert (await client.post(SHIFTS, json=body, headers=headers)).status_code == 201
    body = {**GENERAL, "name": "Long", "full_day_hours": 24, "grace_min": 0}
    assert (await client.post(SHIFTS, json=body, headers=headers)).status_code == 201


async def test_duplicate_name_is_refused_whatever_the_case(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    await make_shift(db, "General")
    response = await client.post(SHIFTS, json={**GENERAL, "name": "GENERAL"}, headers=headers)
    assert (response.status_code, error_code(response)) == (409, "DUPLICATE")


# --- list -------------------------------------------------------------------------------------


async def test_list_pages_through_every_shift(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    ids = [(await make_shift(db)).id for _ in range(2)]
    ids.append((await make_shift(db, is_active=False)).id)

    first = (await client.get(SHIFTS, params={"limit": 2}, headers=headers)).json()
    assert [item["id"] for item in first["items"]] == ids[:2]
    second = (
        await client.get(
            SHIFTS, params={"limit": 2, "cursor": first["next_cursor"]}, headers=headers
        )
    ).json()
    assert [item["id"] for item in second["items"]] == ids[2:]
    assert second["next_cursor"] is None
    assert second["items"][0]["is_active"] is False
    assert first["items"][0]["weekly_offs"] == [SUNDAY]

    bad = await client.get(SHIFTS, params={"cursor": "abc"}, headers=headers)
    assert (bad.status_code, error_code(bad)) == (422, "INVALID_CURSOR")


# --- update -----------------------------------------------------------------------------------


async def test_update_changes_only_the_fields_sent(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    admin, headers = await actor(client, db)
    created = (await client.post(SHIFTS, json=GENERAL, headers=headers)).json()
    change = {"grace_min": 15, "weekly_offs": [SUNDAY], "is_active": False}
    response = await client.patch(url(created["id"]), json=change, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json() == {**created, **change}

    [row] = await audit_rows(db, "shift.update")
    assert (row.actor_id, row.entity_id) == (admin.id, str(created["id"]))
    assert row.before == {**GENERAL, "full_day_hours": 8.0, "is_active": True}
    assert row.after == {**GENERAL, **change, "full_day_hours": 8.0}


@pytest.mark.parametrize(
    ("change", "message"),
    [
        # Each is fine on its own, but not next to what the shift already has.
        ({"end_time": "09:00"}, "must end after it starts"),
        ({"start_time": "19:00"}, "must end after it starts"),
        ({"half_day_hours": 8.5}, "Half-day hours cannot be more than full-day hours"),
        ({"full_day_hours": 4}, "Half-day hours cannot be more than full-day hours"),
    ],
)
async def test_update_checks_the_change_against_the_stored_values(
    client: httpx.AsyncClient, db: AsyncSession, change: dict[str, Any], message: str
) -> None:
    _, headers = await actor(client, db)
    created = (await client.post(SHIFTS, json=GENERAL, headers=headers)).json()
    response = await client.patch(url(created["id"]), json=change, headers=headers)
    assert (response.status_code, error_code(response)) == (422, "VALIDATION_ERROR")
    assert message in response.json()["error"]["message"]
    assert await audit_rows(db, "shift.update") == []
    listed = (await client.get(SHIFTS, headers=headers)).json()["items"]
    assert created in listed


@pytest.mark.parametrize(
    "change",
    [
        {"name": None},
        {"start_time": None},
        {"weekly_offs": None},
        {"is_active": None},
        {"grace_min": 121},
        {"weekly_offs": [SUNDAY, SUNDAY]},
        {"weekly_offs": [{"weekday": 5, "weeks": [3, 1]}]},
    ],
)
async def test_update_rejects_bad_input(
    client: httpx.AsyncClient, db: AsyncSession, change: dict[str, Any]
) -> None:
    _, headers = await actor(client, db)
    shift = await make_shift(db)
    response = await client.patch(url(shift.id), json=change, headers=headers)
    assert (response.status_code, error_code(response)) == (422, "VALIDATION_ERROR")


async def test_update_refuses_a_name_another_shift_has(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    await make_shift(db, "Night")
    shift = await make_shift(db, "General")
    response = await client.patch(url(shift.id), json={"name": "night"}, headers=headers)
    assert (response.status_code, error_code(response)) == (409, "DUPLICATE")
    same = await client.patch(url(shift.id), json={"name": "GENERAL"}, headers=headers)
    assert same.status_code == 200


async def test_update_an_unknown_shift_is_404(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    response = await client.patch(url(999_999_999), json={"grace_min": 5}, headers=headers)
    assert (response.status_code, error_code(response)) == (404, "NOT_FOUND")


# --- picker and permissions -------------------------------------------------------------------


async def test_the_picker_lists_active_shifts_by_name_for_any_employee(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    night = await make_shift(db, "Night")
    general = await make_shift(db, "General")
    await make_shift(db, "Retired", is_active=False)
    headers = await auth_headers(client, await make_user(db, FIELD), kind="mobile")
    response = await client.get(PICKER, headers=headers)
    assert response.status_code == 200
    assert response.json() == [
        {"id": general.id, "name": "General"},
        {"id": night.id, "name": "Night"},
    ]


async def test_shift_admin_needs_branches_manage(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    shift = await make_shift(db)
    allowed = await headers_with(client, db, BRANCHES_MANAGE)
    denied = await headers_with(client, db, EMPLOYEES_MANAGE)

    assert (await client.get(SHIFTS, headers=allowed)).status_code == 200
    assert (await client.post(SHIFTS, json=GENERAL, headers=allowed)).status_code == 201
    changed = await client.patch(url(shift.id), json={"grace_min": 5}, headers=allowed)
    assert changed.status_code == 200

    calls = [
        ("GET", SHIFTS, None),
        ("POST", SHIFTS, {**GENERAL, "name": "Another"}),
        ("PATCH", url(shift.id), {"grace_min": 20}),
    ]
    for method, path, body in calls:
        response = await client.request(method, path, json=body, headers=denied)
        assert (response.status_code, error_code(response)) == (403, "FORBIDDEN"), (method, path)
    assert len(await audit_rows(db, "shift.create")) == 1
    assert len(await audit_rows(db, "shift.update")) == 1
