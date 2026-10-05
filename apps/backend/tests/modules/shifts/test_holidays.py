from datetime import date
from typing import Any

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.auth.permissions import BRANCHES_MANAGE, EMPLOYEES_MANAGE
from app.modules.shifts.models import Holiday
from tests.factories import headers_with, make_branch
from tests.modules.employees.helpers import API, actor, audit_rows, error_code

HOLIDAYS = f"{API}/admin/holidays"
REPUBLIC_DAY = {"date": "2027-01-26", "name": "Republic Day"}


def url(holiday_id: int) -> str:
    return f"{HOLIDAYS}/{holiday_id}"


async def make_holiday(
    db: AsyncSession, day: date, name: str = "Holiday", branch_id: int | None = None
) -> Holiday:
    holiday = Holiday(date=day, name=name, branch_id=branch_id)
    db.add(holiday)
    await db.flush()
    return holiday


async def listed(client: httpx.AsyncClient, headers: dict[str, str], **params: Any) -> list[int]:
    response = await client.get(HOLIDAYS, params=params, headers=headers)
    assert response.status_code == 200, response.text
    return [item["id"] for item in response.json()["items"]]


# --- create -----------------------------------------------------------------------------------


async def test_create_a_holiday_for_every_branch(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    admin, headers = await actor(client, db)
    response = await client.post(HOLIDAYS, json=REPUBLIC_DAY, headers=headers)
    assert response.status_code == 201, response.text
    body = response.json()
    assert body == {**REPUBLIC_DAY, "id": body["id"], "branch_id": None}

    [row] = await audit_rows(db, "holiday.create")
    assert (row.actor_id, row.entity, row.entity_id) == (admin.id, "holiday", str(body["id"]))
    assert row.after == {**REPUBLIC_DAY, "branch_id": None}


async def test_create_a_holiday_for_one_branch(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    branch = await make_branch(db)
    body = {"date": "2027-06-14", "name": "Raja Parba", "branch_id": branch.id}
    response = await client.post(HOLIDAYS, json=body, headers=headers)
    assert response.status_code == 201
    assert response.json()["branch_id"] == branch.id


async def test_one_holiday_per_date_and_branch(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    first, second = await make_branch(db), await make_branch(db)
    for branch_id in (None, first.id):
        body = {**REPUBLIC_DAY, "branch_id": branch_id}
        assert (await client.post(HOLIDAYS, json=body, headers=headers)).status_code == 201
        again = await client.post(HOLIDAYS, json={**body, "name": "Again"}, headers=headers)
        assert (again.status_code, error_code(again)) == (409, "DUPLICATE")
    # Another branch, or another date, is not a clash.
    other = await client.post(
        HOLIDAYS, json={**REPUBLIC_DAY, "branch_id": second.id}, headers=headers
    )
    assert other.status_code == 201
    next_day = await client.post(
        HOLIDAYS, json={**REPUBLIC_DAY, "date": "2027-01-27"}, headers=headers
    )
    assert next_day.status_code == 201
    assert len(await audit_rows(db, "holiday.create")) == 4


async def test_an_unknown_branch_is_an_invalid_reference(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    response = await client.post(
        HOLIDAYS, json={**REPUBLIC_DAY, "branch_id": 999_999_999}, headers=headers
    )
    assert (response.status_code, error_code(response)) == (422, "INVALID_REFERENCE")
    assert await audit_rows(db, "holiday.create") == []


@pytest.mark.parametrize(
    "change", [{"date": "26-01-2027"}, {"date": None}, {"name": " "}, {"name": "x" * 121}]
)
async def test_create_rejects_bad_input(
    client: httpx.AsyncClient, db: AsyncSession, change: dict[str, Any]
) -> None:
    _, headers = await actor(client, db)
    response = await client.post(HOLIDAYS, json={**REPUBLIC_DAY, **change}, headers=headers)
    assert (response.status_code, error_code(response)) == (422, "VALIDATION_ERROR")


# --- list -------------------------------------------------------------------------------------


async def test_list_is_by_year_and_a_branch_sees_its_own_and_the_shared_ones(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    here, there = await make_branch(db), await make_branch(db)
    shared = await make_holiday(db, date(2027, 1, 26))
    local = await make_holiday(db, date(2027, 6, 14), branch_id=here.id)
    elsewhere = await make_holiday(db, date(2027, 6, 14), branch_id=there.id)
    first_day = await make_holiday(db, date(2027, 1, 1))
    last_day = await make_holiday(db, date(2027, 12, 31))
    await make_holiday(db, date(2026, 12, 31))
    await make_holiday(db, date(2028, 1, 1))

    everything = [shared.id, local.id, elsewhere.id, first_day.id, last_day.id]
    assert await listed(client, headers, year=2027) == everything
    assert await listed(client, headers, year=2027, branch_id=here.id) == [
        shared.id,
        local.id,
        first_day.id,
        last_day.id,
    ]
    assert len(await listed(client, headers, year=2026)) == 1
    assert await listed(client, headers, year=2030) == []

    page = (await client.get(HOLIDAYS, params={"year": 2027, "limit": 2}, headers=headers)).json()
    assert [item["id"] for item in page["items"]] == everything[:2]
    rest = await listed(client, headers, year=2027, cursor=page["next_cursor"])
    assert rest == everything[2:]


@pytest.mark.parametrize("params", [{}, {"year": 1999}, {"year": 2101}, {"year": "next"}])
async def test_list_needs_a_sensible_year(
    client: httpx.AsyncClient, db: AsyncSession, params: dict[str, Any]
) -> None:
    _, headers = await actor(client, db)
    response = await client.get(HOLIDAYS, params=params, headers=headers)
    assert (response.status_code, error_code(response)) == (422, "VALIDATION_ERROR")


# --- update and delete ------------------------------------------------------------------------


async def test_update_changes_only_the_fields_sent(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    admin, headers = await actor(client, db)
    branch = await make_branch(db)
    holiday = await make_holiday(db, date(2027, 1, 26), "Republic Day")
    response = await client.patch(url(holiday.id), json={"branch_id": branch.id}, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json() == {**REPUBLIC_DAY, "id": holiday.id, "branch_id": branch.id}

    moved = await client.patch(
        url(holiday.id), json={"date": "2027-01-27", "branch_id": None}, headers=headers
    )
    assert moved.json() == {
        "id": holiday.id,
        "date": "2027-01-27",
        "name": "Republic Day",
        "branch_id": None,
    }
    first, second = await audit_rows(db, "holiday.update")
    assert (first.actor_id, first.entity_id) == (admin.id, str(holiday.id))
    assert first.before == {**REPUBLIC_DAY, "branch_id": None}
    assert first.after == {**REPUBLIC_DAY, "branch_id": branch.id}
    assert second.after == {"date": "2027-01-27", "name": "Republic Day", "branch_id": None}


async def test_update_cannot_collide_with_another_holiday(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    await make_holiday(db, date(2027, 1, 26))
    other = await make_holiday(db, date(2027, 1, 27))
    response = await client.patch(url(other.id), json={"date": "2027-01-26"}, headers=headers)
    assert (response.status_code, error_code(response)) == (409, "DUPLICATE")
    # Renaming it where it is does not collide with itself.
    renamed = await client.patch(url(other.id), json={"name": "Day after"}, headers=headers)
    assert renamed.status_code == 200
    assert renamed.json()["date"] == "2027-01-27"


async def test_update_validates_the_branch_and_the_body(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    holiday = await make_holiday(db, date(2027, 1, 26))
    unknown = await client.patch(url(holiday.id), json={"branch_id": 999_999_999}, headers=headers)
    assert (unknown.status_code, error_code(unknown)) == (422, "INVALID_REFERENCE")
    for body in ({"date": None}, {"name": None}, {"name": ""}):
        response = await client.patch(url(holiday.id), json=body, headers=headers)
        assert (response.status_code, error_code(response)) == (422, "VALIDATION_ERROR")
    missing = await client.patch(url(999_999_999), json={"name": "x"}, headers=headers)
    assert (missing.status_code, error_code(missing)) == (404, "NOT_FOUND")
    assert await audit_rows(db, "holiday.update") == []


async def test_delete_removes_the_holiday_and_keeps_it_in_the_audit_log(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    admin, headers = await actor(client, db)
    holiday = await make_holiday(db, date(2027, 1, 26), "Republic Day")
    response = await client.delete(url(holiday.id), headers=headers)
    assert response.status_code == 204
    assert await listed(client, headers, year=2027) == []

    [row] = await audit_rows(db, "holiday.delete")
    assert (row.actor_id, row.entity_id) == (admin.id, str(holiday.id))
    assert row.before == {**REPUBLIC_DAY, "branch_id": None}
    assert row.after is None

    again = await client.delete(url(holiday.id), headers=headers)
    assert (again.status_code, error_code(again)) == (404, "NOT_FOUND")
    # The date is free again.
    assert (await client.post(HOLIDAYS, json=REPUBLIC_DAY, headers=headers)).status_code == 201


# --- permissions ------------------------------------------------------------------------------


async def test_holiday_admin_needs_branches_manage(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    holiday = await make_holiday(db, date(2027, 8, 15), "Independence Day")
    allowed = await headers_with(client, db, BRANCHES_MANAGE)
    denied = await headers_with(client, db, EMPLOYEES_MANAGE)

    calls: list[tuple[str, str, dict[str, Any] | None]] = [
        ("GET", f"{HOLIDAYS}?year=2027", None),
        ("POST", HOLIDAYS, REPUBLIC_DAY),
        ("PATCH", url(holiday.id), {"name": "Renamed"}),
        ("DELETE", url(holiday.id), None),
    ]
    for method, path, body in calls:
        response = await client.request(method, path, json=body, headers=denied)
        assert (response.status_code, error_code(response)) == (403, "FORBIDDEN"), (method, path)
    assert await audit_rows(db, "holiday.create") == []
    assert await db.get(Holiday, holiday.id) is not None

    for method, path, body in calls:
        response = await client.request(method, path, json=body, headers=allowed)
        assert response.is_success, (method, path, response.text)
