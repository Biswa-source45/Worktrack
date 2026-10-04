from typing import Any

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.auth.permissions import BRANCHES_MANAGE, EMPLOYEES_MANAGE
from app.modules.branches.models import Branch
from tests.factories import (
    FIELD,
    SUPER_ADMIN,
    auth_headers,
    headers_with,
    make_branch,
    make_user,
)
from tests.modules.employees.helpers import API, actor, audit_rows, error_code

BRANCHES = f"{API}/admin/branches"
PICKER = f"{API}/branches"
HQ = {"name": "Head Office", "address": "Plot 12, Saheed Nagar", "lat": 20.2961, "lng": 85.8245}


def url(branch_id: int) -> str:
    return f"{BRANCHES}/{branch_id}"


# --- create -----------------------------------------------------------------------------------


async def test_create_returns_the_branch_with_its_coordinates(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    admin, headers = await actor(client, db)
    response = await client.post(BRANCHES, json={**HQ, "radius_m": 150}, headers=headers)
    assert response.status_code == 201, response.text
    body = response.json()
    assert body == {**HQ, "id": body["id"], "radius_m": 150, "is_active": True}

    assert (await client.get(url(body["id"]), headers=headers)).json() == body
    [row] = await audit_rows(db, "branch.create")
    assert (row.actor_id, row.entity, row.entity_id) == (admin.id, "branch", str(body["id"]))
    assert row.before is None
    assert row.after == {**HQ, "radius_m": 150, "is_active": True}


async def test_radius_defaults_to_the_organisation_setting(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db, SUPER_ADMIN)
    first = await client.post(BRANCHES, json=HQ, headers=headers)
    assert first.json()["radius_m"] == 100

    settings = {"geofence_default_radius_m": 250}
    assert (await client.patch(f"{API}/admin/settings", json=settings, headers=headers)).is_success
    second = await client.post(BRANCHES, json={**HQ, "name": "Depot"}, headers=headers)
    assert second.json()["radius_m"] == 250


@pytest.mark.parametrize(
    "change",
    [
        {"radius_m": 29},
        {"radius_m": 501},
        {"lat": 90.1},
        {"lat": -90.1},
        {"lng": 180.1},
        {"lng": -180.1},
        {"lat": None},
        {"name": "  "},
        {"name": "x" * 121},
        {"address": "x" * 256},
    ],
)
async def test_create_rejects_bad_input(
    client: httpx.AsyncClient, db: AsyncSession, change: dict[str, Any]
) -> None:
    _, headers = await actor(client, db)
    response = await client.post(BRANCHES, json={**HQ, **change}, headers=headers)
    assert response.status_code == 422
    assert error_code(response) == "VALIDATION_ERROR"
    assert response.json()["error"]["details"][0]["loc"] == ["body", next(iter(change))]
    assert await audit_rows(db, "branch.create") == []


@pytest.mark.parametrize("radius", [30, 500])
async def test_radius_bounds_are_inclusive(
    client: httpx.AsyncClient, db: AsyncSession, radius: int
) -> None:
    _, headers = await actor(client, db)
    response = await client.post(BRANCHES, json={**HQ, "radius_m": radius}, headers=headers)
    assert response.status_code == 201
    assert response.json()["radius_m"] == radius


async def test_duplicate_name_is_refused_whatever_the_case(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    await make_branch(db, "Head Office")
    response = await client.post(BRANCHES, json={**HQ, "name": " head office "}, headers=headers)
    assert response.status_code == 409
    assert error_code(response) == "DUPLICATE"


# --- read -------------------------------------------------------------------------------------


async def test_get_an_unknown_branch_is_404(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    response = await client.get(url(999_999_999), headers=headers)
    assert (response.status_code, error_code(response)) == (404, "NOT_FOUND")


async def test_list_pages_through_every_branch_and_filters_by_status(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    open_ids = [(await make_branch(db)).id for _ in range(3)]
    closed = await make_branch(db, is_active=False)

    seen: list[int] = []
    sizes: list[int] = []
    cursor: str | None = None
    while True:
        params: dict[str, Any] = {"limit": 2, **({"cursor": cursor} if cursor else {})}
        page = (await client.get(BRANCHES, params=params, headers=headers)).json()
        sizes.append(len(page["items"]))
        seen += [item["id"] for item in page["items"]]
        cursor = page["next_cursor"]
        if cursor is None:
            break
    assert sizes == [2, 2]
    assert seen == [*open_ids, closed.id]

    active = await client.get(BRANCHES, params={"is_active": "true"}, headers=headers)
    assert [item["id"] for item in active.json()["items"]] == open_ids
    inactive = await client.get(BRANCHES, params={"is_active": "false"}, headers=headers)
    assert [item["id"] for item in inactive.json()["items"]] == [closed.id]
    assert inactive.json()["items"][0]["lat"] == pytest.approx(20.2961)


async def test_list_rejects_a_bad_cursor_or_limit(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    bad_cursor = await client.get(BRANCHES, params={"cursor": "abc"}, headers=headers)
    assert (bad_cursor.status_code, error_code(bad_cursor)) == (422, "INVALID_CURSOR")
    for limit in (0, 201):
        response = await client.get(BRANCHES, params={"limit": limit}, headers=headers)
        assert (response.status_code, error_code(response)) == (422, "VALIDATION_ERROR")


# --- update -----------------------------------------------------------------------------------


async def test_update_changes_only_the_fields_sent(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    admin, headers = await actor(client, db)
    created = (await client.post(BRANCHES, json=HQ, headers=headers)).json()
    change = {"name": "HQ", "radius_m": 200, "lat": 20.3}
    response = await client.patch(url(created["id"]), json=change, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json() == {**created, **change}
    assert (await client.get(url(created["id"]), headers=headers)).json() == {**created, **change}

    [row] = await audit_rows(db, "branch.update")
    assert (row.actor_id, row.entity_id) == (admin.id, str(created["id"]))
    assert row.before == {**HQ, "radius_m": 100, "is_active": True}
    assert row.after == {**HQ, **change, "is_active": True}


async def test_update_can_clear_the_address_and_move_the_pin(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    created = (await client.post(BRANCHES, json=HQ, headers=headers)).json()
    change = {"address": None, "lat": -33.8688, "lng": 151.2093}
    response = await client.patch(url(created["id"]), json=change, headers=headers)
    assert response.json() == {**created, **change}


@pytest.mark.parametrize(
    "change",
    [
        {"radius_m": 29},
        {"radius_m": 501},
        {"radius_m": None},
        {"lat": 91},
        {"lng": None},
        {"name": None},
        {"is_active": None},
    ],
)
async def test_update_rejects_bad_input(
    client: httpx.AsyncClient, db: AsyncSession, change: dict[str, Any]
) -> None:
    _, headers = await actor(client, db)
    branch = await make_branch(db)
    response = await client.patch(url(branch.id), json=change, headers=headers)
    assert (response.status_code, error_code(response)) == (422, "VALIDATION_ERROR")
    assert await audit_rows(db, "branch.update") == []


async def test_update_refuses_a_name_another_branch_has(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    await make_branch(db, "Depot")
    branch = await make_branch(db, "Head Office")
    response = await client.patch(url(branch.id), json={"name": "DEPOT"}, headers=headers)
    assert (response.status_code, error_code(response)) == (409, "DUPLICATE")
    # Its own name, in another case, is not a clash.
    same = await client.patch(url(branch.id), json={"name": "HEAD OFFICE"}, headers=headers)
    assert same.status_code == 200


async def test_update_an_unknown_branch_is_404(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    response = await client.patch(url(999_999_999), json={"name": "x"}, headers=headers)
    assert (response.status_code, error_code(response)) == (404, "NOT_FOUND")


async def test_a_home_branch_can_be_deactivated_and_reactivated(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    branch = await make_branch(db)
    employee = await make_user(db, FIELD, home_branch_id=branch.id)
    response = await client.patch(url(branch.id), json={"is_active": False}, headers=headers)
    assert response.status_code == 200
    assert response.json()["is_active"] is False
    await db.refresh(employee)
    assert employee.home_branch_id == branch.id

    [row] = await audit_rows(db, "branch.update")
    assert (row.before or {})["is_active"] is True
    assert (row.after or {})["is_active"] is False
    again = await client.patch(url(branch.id), json={"is_active": True}, headers=headers)
    assert again.json()["is_active"] is True


async def test_there_is_no_delete(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    branch = await make_branch(db)
    response = await client.delete(url(branch.id), headers=headers)
    assert response.status_code == 405
    assert await db.get(Branch, branch.id) is not None


# --- picker and permissions -------------------------------------------------------------------


async def test_the_picker_lists_active_branches_by_name_for_any_employee(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    zeta = await make_branch(db, "Zeta Yard")
    alpha = await make_branch(db, "Alpha Office")
    await make_branch(db, "Closed Depot", is_active=False)
    headers = await auth_headers(client, await make_user(db, FIELD), kind="mobile")
    response = await client.get(PICKER, headers=headers)
    assert response.status_code == 200
    assert response.json() == [
        {"id": alpha.id, "name": "Alpha Office"},
        {"id": zeta.id, "name": "Zeta Yard"},
    ]


async def test_branch_admin_needs_branches_manage(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    branch = await make_branch(db)
    allowed = await headers_with(client, db, BRANCHES_MANAGE)
    denied = await headers_with(client, db, EMPLOYEES_MANAGE)

    assert (await client.get(BRANCHES, headers=allowed)).status_code == 200
    assert (await client.get(url(branch.id), headers=allowed)).status_code == 200
    assert (await client.post(BRANCHES, json=HQ, headers=allowed)).status_code == 201
    renamed = await client.patch(url(branch.id), json={"name": "Renamed"}, headers=allowed)
    assert renamed.status_code == 200

    calls = [
        ("GET", BRANCHES, None),
        ("GET", url(branch.id), None),
        ("POST", BRANCHES, {**HQ, "name": "Another"}),
        ("PATCH", url(branch.id), {"name": "Nope"}),
    ]
    for method, path, body in calls:
        response = await client.request(method, path, json=body, headers=denied)
        assert (response.status_code, error_code(response)) == (403, "FORBIDDEN"), (method, path)
    assert len(await audit_rows(db, "branch.create")) == 1
    assert len(await audit_rows(db, "branch.update")) == 1
