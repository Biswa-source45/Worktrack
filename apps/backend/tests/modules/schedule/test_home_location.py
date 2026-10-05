"""Home work locations. The coordinates are personal data: most of this file checks where they
do NOT appear."""

import json
from typing import Any

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.audit.models import AuditLog
from app.modules.auth.permissions import EMPLOYEES_MANAGE, WEB_ACCESS
from app.modules.employees.models import User
from app.modules.schedule.models import HomeLocation
from tests.factories import (
    ADMIN,
    FIELD,
    SUPER_ADMIN,
    auth_headers,
    device,
    headers_with,
    make_user,
)
from tests.modules.employees.helpers import API, EMPLOYEES, actor, audit_rows, error_code

REQUESTS = f"{API}/admin/home-location-requests"
MY_REQUESTS = f"{API}/me/home-location-requests"
MY_HOME = f"{API}/me/home-location"
# Distinctive digits, so a leak is easy to search for in any JSON.
LAT, LNG = 19.07654321, 72.87654321
ELSEWHERE = {"lat": 12.97123456, "lng": 77.59123456}
HERE = {"lat": LAT, "lng": LNG}
Headers = dict[str, str]


def home_url(employee_id: int) -> str:
    return f"{EMPLOYEES}/{employee_id}/home-location"


def keys(value: Any) -> set[str]:
    """Every key anywhere inside a JSON value."""
    if isinstance(value, dict):
        return set(value) | {key for item in value.values() for key in keys(item)}
    if isinstance(value, list):
        return {key for item in value for key in keys(item)}
    return set()


def has_no_coordinates(value: Any) -> bool:
    text = json.dumps(value)
    # Seven digits in a row: longer than the microseconds of any timestamp.
    return not keys(value) & {"lat", "lng", "location"} and not any(
        digits in text for digits in ("7654321", "9123456")
    )


async def phone(client: httpx.AsyncClient, db: AsyncSession, n: int = 1) -> tuple[User, Headers]:
    """An employee signed in on their approved phone."""
    user = await make_user(db, FIELD)
    return user, await auth_headers(client, user, kind="mobile", device_info=device(n))


async def ask(client: httpx.AsyncClient, headers: Headers, **overrides: Any) -> httpx.Response:
    body = {**HERE, "accuracy_m": 12.5, **overrides}
    return await client.post(MY_REQUESTS, json=body, headers=headers)


async def statuses(db: AsyncSession, user: User) -> list[str]:
    rows = await db.execute(
        select(HomeLocation.status).where(HomeLocation.user_id == user.id).order_by(HomeLocation.id)
    )
    return list(rows.scalars())


async def pending_id(client: httpx.AsyncClient, admin: Headers) -> int:
    [item] = (await client.get(REQUESTS, headers=admin)).json()["items"]
    request_id: int = item["id"]
    return request_id


# --- admin sets, replaces, removes ------------------------------------------------------------


async def test_admin_sets_replaces_and_removes_a_home_location(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    admin, headers = await actor(client, db)
    user = await make_user(db, FIELD)
    empty = await client.get(home_url(user.id), headers=headers)
    assert empty.json() == {"approved": None, "pending": None}

    first = await client.put(home_url(user.id), json=HERE, headers=headers)
    assert first.status_code == 200, first.text
    approved = first.json()["approved"]
    assert approved == {
        "id": approved["id"],
        "lat": LAT,
        "lng": LNG,
        "radius_m": 100,  # OrgSettings.home_default_radius_m
        "source": "admin",
        "decided_at": approved["decided_at"],
    }
    assert approved["decided_at"] is not None
    assert first.json()["pending"] is None
    assert (await client.get(home_url(user.id), headers=headers)).json() == first.json()

    second = await client.put(
        home_url(user.id), json={**ELSEWHERE, "radius_m": 250}, headers=headers
    )
    replaced = second.json()["approved"]
    assert (replaced["lat"], replaced["lng"], replaced["radius_m"]) == (*ELSEWHERE.values(), 250)
    assert replaced["id"] != approved["id"]
    assert await statuses(db, user) == ["replaced", "approved"]

    removed = await client.delete(home_url(user.id), headers=headers)
    assert removed.status_code == 204
    assert await statuses(db, user) == ["replaced", "removed"]
    assert (await client.get(home_url(user.id), headers=headers)).json()["approved"] is None
    again = await client.delete(home_url(user.id), headers=headers)
    assert (again.status_code, error_code(again)) == (404, "NOT_FOUND")

    set_rows = await audit_rows(db, "home_location.set")
    assert [row.actor_id for row in set_rows] == [admin.id, admin.id]
    assert set_rows[0].after == {
        "user_id": user.id,
        "status": "approved",
        "radius_m": 100,
        "source": "admin",
        "accuracy_m": None,
    }
    assert (set_rows[1].after or {})["replaced_id"] == approved["id"]
    [remove_row] = await audit_rows(db, "home_location.remove")
    assert (remove_row.before or {})["status"] == "approved"
    assert (remove_row.after or {})["status"] == "removed"


async def test_the_default_home_radius_comes_from_settings(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db, SUPER_ADMIN)
    user = await make_user(db, FIELD)
    change = {"home_default_radius_m": 180}
    assert (await client.patch(f"{API}/admin/settings", json=change, headers=headers)).is_success
    response = await client.put(home_url(user.id), json=HERE, headers=headers)
    assert response.json()["approved"]["radius_m"] == 180


@pytest.mark.parametrize(
    "body",
    [
        {**HERE, "radius_m": 29},
        {**HERE, "radius_m": 501},
        {"lat": 91, "lng": 0},
        {"lat": 0, "lng": 181},
        {"lat": LAT},
    ],
)
async def test_admin_set_validates_its_body(
    client: httpx.AsyncClient, db: AsyncSession, body: dict[str, Any]
) -> None:
    _, headers = await actor(client, db)
    user = await make_user(db, FIELD)
    response = await client.put(home_url(user.id), json=body, headers=headers)
    assert (response.status_code, error_code(response)) == (422, "VALIDATION_ERROR")
    assert await statuses(db, user) == []


# --- the employee asks, an admin decides ------------------------------------------------------


async def test_a_request_from_the_phone_is_pending_until_approved(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    admin, admin_headers = await actor(client, db)
    user, headers = await phone(client, db)
    asked = await ask(client, headers)
    assert asked.status_code == 201, asked.text
    assert asked.json() == {
        "status": "pending",
        "radius_m": 100,
        "created_at": asked.json()["created_at"],
    }
    mine = (await client.get(MY_HOME, headers=headers)).json()
    assert mine == {
        "approved": None,
        "pending": {"created_at": asked.json()["created_at"]},
        "last_rejected": None,
    }

    listed = (await client.get(REQUESTS, headers=admin_headers)).json()
    assert listed["next_cursor"] is None
    [item] = listed["items"]
    assert item == {
        "id": item["id"],
        "employee": {"id": user.id, "emp_code": user.emp_code, "name": user.name},
        "status": "pending",
        "accuracy_m": 12.5,
        "created_at": asked.json()["created_at"],
    }
    detail = (await client.get(f"{REQUESTS}/{item['id']}", headers=admin_headers)).json()
    assert detail == {
        **item,
        "lat": LAT,
        "lng": LNG,
        "radius_m": 100,
        "decided_at": None,
        "reject_reason": None,
    }
    view = (await client.get(home_url(user.id), headers=admin_headers)).json()
    assert view["approved"] is None
    assert (view["pending"]["lat"], view["pending"]["lng"]) == (LAT, LNG)
    assert view["pending"]["accuracy_m"] == 12.5

    approved = await client.post(
        f"{REQUESTS}/{item['id']}/approve", json={"radius_m": 150}, headers=admin_headers
    )
    assert approved.status_code == 200, approved.text
    assert approved.json() == {**item, "status": "approved"}
    mine = (await client.get(MY_HOME, headers=headers)).json()
    assert mine["pending"] is None
    assert mine["approved"]["radius_m"] == 150
    assert mine["approved"]["decided_at"] is not None
    view = (await client.get(home_url(user.id), headers=admin_headers)).json()
    assert view["pending"] is None
    assert (view["approved"]["id"], view["approved"]["source"]) == (item["id"], "self")
    assert (await client.get(REQUESTS, headers=admin_headers)).json()["items"] == []
    done = await client.get(REQUESTS, params={"status": "approved"}, headers=admin_headers)
    assert [i["id"] for i in done.json()["items"]] == [item["id"]]

    [request_row] = await audit_rows(db, "home_location.request")
    assert request_row.actor_id == user.id
    assert request_row.after == {
        "user_id": user.id,
        "status": "pending",
        "radius_m": 100,
        "source": "self",
        "accuracy_m": 12.5,
    }
    [approve_row] = await audit_rows(db, "home_location.approve")
    assert approve_row.actor_id == admin.id
    assert (approve_row.before or {})["status"] == "pending"
    assert (approve_row.after or {})["status"] == "approved"
    assert (approve_row.after or {})["radius_m"] == 150


async def test_approval_without_a_body_keeps_the_radius_and_replaces_the_old_home(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, admin_headers = await actor(client, db)
    user, headers = await phone(client, db)
    await client.put(home_url(user.id), json=ELSEWHERE, headers=admin_headers)
    await ask(client, headers)
    request_id = await pending_id(client, admin_headers)
    approved = await client.post(f"{REQUESTS}/{request_id}/approve", headers=admin_headers)
    assert approved.status_code == 200, approved.text
    assert await statuses(db, user) == ["replaced", "approved"]
    view = (await client.get(home_url(user.id), headers=admin_headers)).json()
    assert (view["approved"]["lat"], view["approved"]["radius_m"]) == (LAT, 100)
    [row] = await audit_rows(db, "home_location.approve")
    assert (row.after or {})["replaced_id"] is not None


async def test_a_rejected_request_tells_the_employee_why_and_they_may_ask_again(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    admin, admin_headers = await actor(client, db)
    user, headers = await phone(client, db)
    await ask(client, headers)
    request_id = await pending_id(client, admin_headers)
    rejected = await client.post(
        f"{REQUESTS}/{request_id}/reject",
        json={"reason": " Too far from town "},
        headers=admin_headers,
    )
    assert rejected.status_code == 200, rejected.text
    assert rejected.json()["status"] == "rejected"
    mine = (await client.get(MY_HOME, headers=headers)).json()
    assert mine["approved"] is None and mine["pending"] is None
    assert mine["last_rejected"]["reason"] == "Too far from town"
    assert mine["last_rejected"]["decided_at"] is not None
    detail = (await client.get(f"{REQUESTS}/{request_id}", headers=admin_headers)).json()
    assert (detail["status"], detail["reject_reason"]) == ("rejected", "Too far from town")

    assert (await ask(client, headers)).status_code == 201
    assert await statuses(db, user) == ["rejected", "pending"]
    [row] = await audit_rows(db, "home_location.reject")
    assert row.actor_id == admin.id
    assert (row.after or {})["reason"] == "Too far from town"


async def test_a_new_request_replaces_the_pending_one(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, admin_headers = await actor(client, db)
    user, headers = await phone(client, db)
    await ask(client, headers)
    first = await pending_id(client, admin_headers)
    assert (await ask(client, headers, **ELSEWHERE)).status_code == 201
    assert await statuses(db, user) == ["replaced", "pending"]
    second = await pending_id(client, admin_headers)
    assert second != first
    stale = await client.post(f"{REQUESTS}/{first}/approve", headers=admin_headers)
    assert (stale.status_code, error_code(stale)) == (409, "REQUEST_ALREADY_DECIDED")
    _, replaced = await audit_rows(db, "home_location.request")
    assert (replaced.after or {})["replaced_id"] == first


async def test_a_decided_request_cannot_be_decided_again(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, admin_headers = await actor(client, db)
    _, headers = await phone(client, db)
    await ask(client, headers)
    request_id = await pending_id(client, admin_headers)
    assert (await client.post(f"{REQUESTS}/{request_id}/approve", headers=admin_headers)).is_success
    for action, body in (("approve", {}), ("reject", {"reason": "Changed my mind"})):
        path = f"{REQUESTS}/{request_id}/{action}"
        again = await client.post(path, json=body, headers=admin_headers)
        assert (again.status_code, error_code(again)) == (409, "REQUEST_ALREADY_DECIDED")
    assert len(await audit_rows(db, "home_location.approve")) == 1
    assert await audit_rows(db, "home_location.reject") == []


async def test_deciding_validates_the_body_and_the_request(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, admin_headers = await actor(client, db)
    user, headers = await phone(client, db)
    await ask(client, headers)
    request_id = await pending_id(client, admin_headers)
    bad: list[tuple[str, dict[str, Any]]] = [
        ("approve", {"radius_m": 29}),
        ("approve", {"radius_m": 501}),
        ("reject", {}),
        ("reject", {"reason": "  "}),
        ("reject", {"reason": "x" * 256}),
    ]
    for action, body in bad:
        path = f"{REQUESTS}/{request_id}/{action}"
        response = await client.post(path, json=body, headers=admin_headers)
        assert (response.status_code, error_code(response)) == (422, "VALIDATION_ERROR"), body
    assert await statuses(db, user) == ["pending"]

    # A location an admin set is not a request.
    other = await make_user(db, FIELD)
    placed = await client.put(home_url(other.id), json=HERE, headers=admin_headers)
    for path in (
        f"{REQUESTS}/{placed.json()['approved']['id']}",
        f"{REQUESTS}/999999999",
    ):
        assert (await client.get(path, headers=admin_headers)).status_code == 404
        assert (await client.post(f"{path}/approve", headers=admin_headers)).status_code == 404
    listed = await client.get(REQUESTS, params={"status": "approved"}, headers=admin_headers)
    assert listed.json()["items"] == []
    bad_status = await client.get(REQUESTS, params={"status": "replaced"}, headers=admin_headers)
    assert bad_status.status_code == 422


async def test_requests_are_paged(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, admin_headers = await actor(client, db)
    for n in range(3):
        _, headers = await phone(client, db, n + 1)
        await ask(client, headers)
    first = (await client.get(REQUESTS, params={"limit": 2}, headers=admin_headers)).json()
    assert len(first["items"]) == 2
    params = {"limit": 2, "cursor": first["next_cursor"]}
    rest = (await client.get(REQUESTS, params=params, headers=admin_headers)).json()
    assert len(rest["items"]) == 1 and rest["next_cursor"] is None
    assert rest["items"][0]["id"] > first["items"][-1]["id"]


# --- gates on the employee's request ----------------------------------------------------------


async def test_a_poor_gps_fix_is_refused(client: httpx.AsyncClient, db: AsyncSession) -> None:
    user, headers = await phone(client, db)
    assert (await ask(client, headers, accuracy_m=50)).status_code == 201
    poor = await ask(client, headers, accuracy_m=50.5)
    assert (poor.status_code, error_code(poor)) == (422, "GPS_ACCURACY_POOR")
    assert has_no_coordinates(poor.json())
    assert await statuses(db, user) == ["pending"]


@pytest.mark.parametrize(
    "body",
    [HERE, {**HERE, "accuracy_m": -1}, {"lat": 95, "lng": LNG, "accuracy_m": 5}],
)
async def test_the_request_body_is_validated(
    client: httpx.AsyncClient, db: AsyncSession, body: dict[str, Any]
) -> None:
    _, headers = await phone(client, db)
    response = await client.post(MY_REQUESTS, json=body, headers=headers)
    assert (response.status_code, error_code(response)) == (422, "VALIDATION_ERROR")
    # The validation error names the field, never the value that was sent.
    assert has_no_coordinates(response.json())


async def test_only_the_approved_phone_may_ask(client: httpx.AsyncClient, db: AsyncSession) -> None:
    user = await make_user(db, FIELD)
    await auth_headers(client, user, kind="mobile", device_info=device(1))
    second_phone = await auth_headers(client, user, kind="mobile", device_info=device(2))
    on_the_web = await auth_headers(client, await make_user(db, ADMIN))
    for headers in (second_phone, on_the_web):
        response = await ask(client, headers)
        assert (response.status_code, error_code(response)) == (403, "DEVICE_NOT_APPROVED")
    assert (await client.post(MY_REQUESTS, json=HERE)).status_code == 401
    assert await statuses(db, user) == []
    # Reading the state needs a session, but not the phone.
    assert (await client.get(MY_HOME, headers=on_the_web)).status_code == 200
    assert (await client.get(MY_HOME)).status_code == 401


# --- privacy ----------------------------------------------------------------------------------


async def test_coordinates_appear_only_in_the_admin_detail_views(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, admin_headers = await actor(client, db)
    user, headers = await phone(client, db)
    await client.put(home_url(user.id), json=ELSEWHERE, headers=admin_headers)
    asked = await ask(client, headers)
    request_id = await pending_id(client, admin_headers)

    safe = [
        asked,
        await client.get(MY_HOME, headers=headers),
        await client.get(f"{API}/me", headers=headers),
        await client.get(REQUESTS, headers=admin_headers),
        await client.get(f"{EMPLOYEES}/{user.id}", headers=admin_headers),
        await client.get(EMPLOYEES, headers=admin_headers),
        await client.post(f"{REQUESTS}/{request_id}/approve", headers=admin_headers),
        await client.get(REQUESTS, params={"status": "approved"}, headers=admin_headers),
        await client.get(MY_HOME, headers=headers),
    ]
    for response in safe:
        assert response.is_success, response.text
        assert has_no_coordinates(response.json()), response.request.url

    # The two detail views are the only places that show them.
    detail = await client.get(f"{REQUESTS}/{request_id}", headers=admin_headers)
    view = await client.get(home_url(user.id), headers=admin_headers)
    assert (detail.json()["lat"], detail.json()["lng"]) == (LAT, LNG)
    assert (view.json()["approved"]["lat"], view.json()["approved"]["lng"]) == (LAT, LNG)


async def test_no_audit_row_for_any_home_action_holds_coordinates(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, admin_headers = await actor(client, db)
    user, headers = await phone(client, db)
    await client.put(home_url(user.id), json=ELSEWHERE, headers=admin_headers)
    await ask(client, headers)
    first = await pending_id(client, admin_headers)
    await client.post(f"{REQUESTS}/{first}/reject", json={"reason": "No"}, headers=admin_headers)
    await ask(client, headers)
    await ask(client, headers, **ELSEWHERE)
    second = await pending_id(client, admin_headers)
    await client.post(f"{REQUESTS}/{second}/approve", headers=admin_headers)
    await client.delete(home_url(user.id), headers=admin_headers)

    rows = list(
        (
            await db.execute(select(AuditLog).where(AuditLog.action.like("home_location.%")))
        ).scalars()
    )
    assert {row.action.split(".")[1] for row in rows} == {
        "set",
        "request",
        "reject",
        "approve",
        "remove",
    }
    assert len(rows) == 7
    allowed = {"user_id", "status", "radius_m", "source", "accuracy_m", "replaced_id", "reason"}
    for row in rows:
        for snapshot in (row.before, row.after):
            assert has_no_coordinates(snapshot), row.action
            assert set(snapshot or {}) <= allowed, row.action


# --- permissions ------------------------------------------------------------------------------


async def test_every_admin_endpoint_needs_employees_manage_and_a_manageable_target(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, super_headers = await actor(client, db, SUPER_ADMIN)
    user, headers = await phone(client, db, 1)
    await ask(client, headers)
    request_id = await pending_id(client, super_headers)
    # A Super Admin who asked from their own phone: Admin/HR may not manage them.
    boss = await make_user(db, SUPER_ADMIN)
    boss_phone = await auth_headers(client, boss, kind="mobile", device_info=device(2))
    await ask(client, boss_phone)
    boss_request = next(
        item["id"]
        for item in (await client.get(REQUESTS, headers=super_headers)).json()["items"]
        if item["employee"]["id"] == boss.id
    )

    def calls(employee_id: int, request: int) -> list[tuple[str, str, dict[str, Any] | None]]:
        return [
            ("GET", home_url(employee_id), None),
            ("PUT", home_url(employee_id), HERE),
            ("DELETE", home_url(employee_id), None),
            ("GET", f"{REQUESTS}/{request}", None),
            ("POST", f"{REQUESTS}/{request}/approve", {}),
            ("POST", f"{REQUESTS}/{request}/reject", {"reason": "No"}),
        ]

    no_permission = await headers_with(client, db, WEB_ACCESS)
    for method, path, body in [*calls(user.id, request_id), ("GET", REQUESTS, None)]:
        response = await client.request(method, path, json=body, headers=no_permission)
        assert (response.status_code, error_code(response)) == (403, "FORBIDDEN"), (method, path)

    hr = await headers_with(client, db, EMPLOYEES_MANAGE)
    for method, path, body in calls(boss.id, boss_request):
        response = await client.request(method, path, json=body, headers=hr)
        assert (response.status_code, error_code(response)) == (403, "FORBIDDEN"), (method, path)
        assert has_no_coordinates(response.json())
    # The list shows only the requests of people the actor may manage.
    visible = (await client.get(REQUESTS, headers=hr)).json()["items"]
    assert [item["employee"]["id"] for item in visible] == [user.id]
    everyone = (await client.get(REQUESTS, headers=super_headers)).json()["items"]
    assert {item["employee"]["id"] for item in everyone} == {user.id, boss.id}

    assert await statuses(db, boss) == ["pending"]
    assert await statuses(db, user) == ["pending"]
    assert (await client.post(f"{REQUESTS}/{request_id}/approve", headers=hr)).status_code == 200


# --- coordinates are forgotten once a location is no longer in use ----------------------------


async def kept_locations(db: AsyncSession, user: User) -> list[tuple[str, bool]]:
    """Each row's status and whether it still holds coordinates, oldest first."""
    rows = await db.execute(
        select(HomeLocation.status, HomeLocation.location.is_not(None))
        .where(HomeLocation.user_id == user.id)
        .order_by(HomeLocation.id)
    )
    return [(status, kept) for status, kept in rows]


async def test_a_replaced_and_a_removed_home_location_forget_where_they_were(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, admin_headers = await actor(client, db)
    user = await make_user(db, FIELD)
    url = home_url(user.id)
    assert (await client.put(url, json=HERE, headers=admin_headers)).status_code == 200
    assert (await client.put(url, json=ELSEWHERE, headers=admin_headers)).status_code == 200
    assert await kept_locations(db, user) == [("replaced", False), ("approved", True)]

    assert (await client.delete(url, headers=admin_headers)).status_code == 204
    assert await kept_locations(db, user) == [("replaced", False), ("removed", False)]
    view = (await client.get(url, headers=admin_headers)).json()
    assert view == {"approved": None, "pending": None}


async def test_a_rejected_or_superseded_request_forgets_where_it_was(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, admin_headers = await actor(client, db)
    user, headers = await phone(client, db)
    await ask(client, headers)
    await ask(client, headers, **ELSEWHERE)
    assert await kept_locations(db, user) == [("replaced", False), ("pending", True)]

    request_id = await pending_id(client, admin_headers)
    rejected = await client.post(
        f"{REQUESTS}/{request_id}/reject", json={"reason": "Not your home"}, headers=admin_headers
    )
    assert rejected.status_code == 200, rejected.text
    assert await kept_locations(db, user) == [("replaced", False), ("rejected", False)]
    # The admin can still see that it was rejected and why, but no longer where it was.
    detail = (await client.get(f"{REQUESTS}/{request_id}", headers=admin_headers)).json()
    assert (detail["status"], detail["lat"], detail["lng"]) == ("rejected", None, None)
    assert detail["reject_reason"] == "Not your home"


async def test_approving_a_request_forgets_the_home_it_replaces(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, admin_headers = await actor(client, db)
    user, headers = await phone(client, db)
    assert (
        await client.put(home_url(user.id), json=ELSEWHERE, headers=admin_headers)
    ).status_code == 200
    await ask(client, headers)
    request_id = await pending_id(client, admin_headers)
    approved = await client.post(f"{REQUESTS}/{request_id}/approve", headers=admin_headers)
    assert approved.status_code == 200, approved.text
    assert await kept_locations(db, user) == [("replaced", False), ("approved", True)]
