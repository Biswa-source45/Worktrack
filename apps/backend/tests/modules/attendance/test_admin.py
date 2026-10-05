"""The register, a day's detail, manual overrides, the exceptions feed, the employee's own month
and the notifications list."""

import datetime as dt
import json

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.attendance.models import AttendanceDay
from app.modules.notifications.models import Notification
from tests.factories import ADMIN, ASSIGNER, SUPER_ADMIN, make_branch, make_user
from tests.modules.attendance.conftest import MONDAY, SUNDAY, Clock, Scene, employee, ist
from tests.modules.attendance.test_punch import A, at_branch, send
from tests.modules.branches.test_geofence import point_at
from tests.modules.employees.helpers import API, actor, audit_rows, error_code
from tests.modules.face import images
from tests.modules.schedule.test_punch import HOME, add_home
from tests.modules.schedule.test_schedule import add_schedule

REGISTER = f"{API}/admin/attendance"
OVERRIDES = f"{REGISTER}/overrides"
FEED = f"{API}/admin/attendance-exceptions"


def names(body: dict) -> list[str]:  # type: ignore[type-arg]
    return [row["employee"]["name"] for row in body["items"]]


# --- register ----------------------------------------------------------------------------------


async def test_the_register_lists_everyone_with_their_day(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    other, _ = await employee(client, db, scene, 2)
    where = await at_branch(db, scene)
    await send(client, scene.headers, "punch-in", where)
    clock.at(18, 0)
    await send(client, scene.headers, "punch-out", where)
    response = await client.get(
        REGISTER, params={"date": MONDAY.isoformat(), "limit": 200}, headers=scene.admin
    )
    assert response.status_code == 200, response.text
    rows = {r["employee"]["id"]: r for r in response.json()["items"]}
    mine, theirs = rows[scene.user.id], rows[other.id]
    assert (mine["status"], mine["branch"], mine["worked_minutes"]) == (
        "present",
        scene.branch.name,
        475,
    )
    assert dt.datetime.fromisoformat(mine["first_in_at"]) == ist(10, 5)
    assert (theirs["status"], theirs["day_id"], theirs["first_in_at"]) == ("no_record", None, None)


async def test_register_filters_by_branch_status_and_search(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    other, other_headers = await employee(client, db, scene, 2)
    elsewhere = await make_branch(db, "Second Office", lat=20.4, lng=85.9)
    await send(client, scene.headers, "punch-in", await at_branch(db, scene))
    await send(
        client,
        other_headers,
        "punch-in",
        await point_at(db, elsewhere, 5),
        selfie=images.same_person("b", 1),
    )

    def get(**params: str | int):  # type: ignore[no-untyped-def]
        return client.get(
            REGISTER,
            params={"date": MONDAY.isoformat(), "limit": 200, **params},
            headers=scene.admin,
        )

    by_branch = (await get(branch_id=elsewhere.id)).json()
    assert [r["employee"]["id"] for r in by_branch["items"]] == [other.id]
    working = (await get(status="working")).json()
    assert {r["employee"]["id"] for r in working["items"]} == {scene.user.id, other.id}
    assert (await get(status="present")).json()["items"] == []
    assert (await get(q=scene.user.emp_code)).json()["items"][0]["employee"]["id"] == scene.user.id
    assert (await get(q="%")).json()["items"] == []  # LIKE wildcards are plain characters
    assert (await get(status="bogus")).status_code == 422


async def test_register_pages_with_a_cursor(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    for n in (2, 3):
        await employee(client, db, scene, n)
    everyone = (
        await client.get(
            REGISTER, params={"date": MONDAY.isoformat(), "limit": 200}, headers=scene.admin
        )
    ).json()
    seen: list[int] = []
    cursor: str | None = None
    while True:
        page = (
            await client.get(
                REGISTER,
                params={
                    "date": MONDAY.isoformat(),
                    "limit": 2,
                    **({"cursor": cursor} if cursor else {}),
                },
                headers=scene.admin,
            )
        ).json()
        seen += [r["employee"]["id"] for r in page["items"]]
        cursor = page["next_cursor"]
        if cursor is None:
            break
    assert seen == [r["employee"]["id"] for r in everyone["items"]]


async def test_a_manager_sees_only_their_own_subtree(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    manager, manager_headers = await employee(client, db, scene, 2, role=ASSIGNER)
    scene.user.manager_id = manager.id
    deep, _ = await employee(client, db, scene, 3)
    deep.manager_id = scene.user.id  # reports to a report: still in the subtree
    stranger, _ = await employee(client, db, scene, 4)
    await db.flush()
    params = {"date": MONDAY.isoformat(), "limit": 200}
    mine = (await client.get(REGISTER, params=params, headers=manager_headers)).json()
    assert {r["employee"]["id"] for r in mine["items"]} == {scene.user.id, deep.id}
    everyone = (await client.get(REGISTER, params=params, headers=scene.admin)).json()
    assert stranger.id in {r["employee"]["id"] for r in everyone["items"]}
    # Not their own row, and an employee with no team permission is refused.
    assert manager.id not in {r["employee"]["id"] for r in mine["items"]}
    assert (await client.get(REGISTER, params=params, headers=scene.headers)).status_code == 403


async def test_register_excludes_people_who_had_not_joined_and_inactive_people_without_a_day(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    future = await make_user(db)
    future.joined_on = dt.date(2027, 6, 1)
    await db.flush()
    gone = await make_user(db, status="inactive")
    rows = (
        await client.get(
            REGISTER, params={"date": MONDAY.isoformat(), "limit": 200}, headers=scene.admin
        )
    ).json()["items"]
    ids = {r["employee"]["id"] for r in rows}
    assert future.id not in ids and gone.id not in ids and scene.user.id in ids


# --- detail ----------------------------------------------------------------------------------


async def test_the_day_detail_shows_every_punch_with_a_working_selfie_link(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    where = await at_branch(db, scene)
    await send(client, scene.headers, "punch-in", where)
    clock.at(18, 0)
    await send(client, scene.headers, "punch-out", where)
    day_id = (
        await client.get(
            REGISTER, params={"date": MONDAY.isoformat(), "limit": 200}, headers=scene.admin
        )
    ).json()
    day_id = next(r["day_id"] for r in day_id["items"] if r["employee"]["id"] == scene.user.id)
    detail = (await client.get(f"{REGISTER}/{day_id}", headers=scene.admin)).json()
    assert [p["type"] for p in detail["punches"]] == ["in", "out"]
    punch = detail["punches"][0]
    assert punch["place"] == {"type": "branch", "branch": scene.branch.name, "distance_m": 5}
    assert (await client.get(punch["selfie_url"])).status_code == 200
    assert len(await audit_rows(db, "attendance_day.view")) == 1


async def test_a_manager_cannot_open_a_day_outside_their_team(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    await send(client, scene.headers, "punch-in", await at_branch(db, scene))
    day = (
        await db.execute(select(AttendanceDay.id).where(AttendanceDay.user_id == scene.user.id))
    ).scalar_one()
    _, stranger = await employee(client, db, scene, 2, role=ASSIGNER)
    response = await client.get(f"{REGISTER}/{day}", headers=stranger)
    assert (response.status_code, error_code(response)) == (404, "NOT_FOUND")


async def test_a_home_location_never_appears_in_the_register_or_a_day(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    await add_schedule(db, scene.user, dt.date(2027, 1, 1), ["home"] * 7)
    await add_home(db, scene.user)
    assert (await send(client, scene.headers, "punch-in", HOME)).status_code == 201
    listed = await client.get(
        REGISTER, params={"date": MONDAY.isoformat(), "limit": 200}, headers=scene.admin
    )
    day = next(r["day_id"] for r in listed.json()["items"] if r["employee"]["id"] == scene.user.id)
    detail = await client.get(f"{REGISTER}/{day}", headers=scene.admin)
    assert json.loads(detail.text)["punches"][0]["place"] == {
        "type": "home",
        "branch": None,
        "distance_m": None,
    }
    for response in (listed, detail):
        assert str(HOME["lat"]) not in response.text and str(HOME["lng"]) not in response.text
        assert '"lat"' not in response.text and '"lng"' not in response.text


# --- manual override (FR-SET-05) ---------------------------------------------------------------


async def test_an_override_marks_the_day_and_both_records_are_kept(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    where = await at_branch(db, scene)
    await send(client, scene.headers, "punch-in", where)
    clock.at(12, 0)
    await send(client, scene.headers, "punch-out", where)
    body = {
        "user_id": scene.user.id,
        "date": MONDAY.isoformat(),
        "kind": "on_duty",
        "reason": "Visited a client",
    }
    response = await client.post(OVERRIDES, json=body, headers=scene.admin)
    assert response.status_code == 201, response.text
    day = response.json()["day"]
    # The status is the admin's; the punches and their hours are untouched.
    assert (day["status"], day["worked_minutes"]) == ("on_duty", 115)
    again = await client.post(
        OVERRIDES,
        json={**body, "kind": "leave", "reason": "Corrected to leave"},
        headers=scene.admin,
    )
    assert again.json()["day"]["status"] == "leave"
    detail = (await client.get(f"{REGISTER}/{day['id']}", headers=scene.admin)).json()
    assert [o["kind"] for o in detail["overrides"]] == ["on_duty", "leave"]
    assert len(detail["punches"]) == 2
    audit = (await audit_rows(db, "attendance.override"))[-1]
    assert audit.before == {"status": "on_duty"} and audit.after is not None
    assert audit.after["reason"] == "Corrected to leave" and audit.after["status"] == "leave"


async def test_an_override_on_a_day_without_punches_creates_the_day(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    body = {
        "user_id": scene.user.id,
        "date": MONDAY.isoformat(),
        "kind": "work_from_home",
        "reason": "Approved by the MD",
    }
    response = await client.post(OVERRIDES, json=body, headers=scene.admin)
    assert response.json()["day"]["status"] == "work_from_home"
    register = (
        await client.get(
            REGISTER,
            params={"date": MONDAY.isoformat(), "status": "work_from_home"},
            headers=scene.admin,
        )
    ).json()
    assert names(register) == [scene.user.name]


async def test_an_override_needs_a_reason_a_valid_date_and_the_permission(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    ok = {
        "user_id": scene.user.id,
        "date": MONDAY.isoformat(),
        "kind": "leave",
        "reason": "Medical leave",
    }
    for change in (
        {"reason": ""},
        {"reason": "abc"},
        {"kind": "present"},
        {"date": (MONDAY + dt.timedelta(days=1)).isoformat()},  # tomorrow
        {"date": "2025-01-01"},  # before joining
        {"user_id": 999_999},
    ):
        response = await client.post(OVERRIDES, json={**ok, **change}, headers=scene.admin)
        assert response.status_code in (404, 422), change
    _, manager = await employee(client, db, scene, 2, role=ASSIGNER)
    assert (await client.post(OVERRIDES, json=ok, headers=manager)).status_code == 403
    assert (await client.post(OVERRIDES, json=ok, headers=scene.headers)).status_code == 403


async def test_an_admin_cannot_override_someone_with_more_access(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    top, _ = await employee(client, db, scene, 2, role=SUPER_ADMIN)
    body = {
        "user_id": top.id,
        "date": MONDAY.isoformat(),
        "kind": "leave",
        "reason": "Medical leave",
    }
    response = await client.post(OVERRIDES, json=body, headers=scene.admin)
    assert (response.status_code, error_code(response)) == (403, "FORBIDDEN")


# --- exceptions --------------------------------------------------------------------------------


async def test_the_exceptions_feed_lists_failed_attempts_without_coordinates(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    await send(client, scene.headers, "punch-in", await point_at(db, scene.branch, 500))  # outside
    await send(client, scene.headers, "punch-in", await at_branch(db, scene), mocked=True)
    await send(
        client,
        scene.headers,
        "punch-in",
        await at_branch(db, scene),
        selfie=images.same_person("b", 1),
    )
    feed = (await client.get(FEED, headers=scene.admin)).json()
    assert [i["kind"] for i in feed["items"]] == [
        "FACE_MISMATCH",
        "MOCK_LOCATION",
        "OUTSIDE_GEOFENCE",
    ]
    assert (
        feed["items"][2]["nearest_branch"] == scene.branch.name
        and feed["items"][2]["distance_m"] == 500
    )
    assert feed["items"][0]["punch_event_id"] is not None
    assert '"lat"' not in json.dumps(feed) and '"lng"' not in json.dumps(feed)
    only = (await client.get(FEED, params={"kind": "MOCK_LOCATION"}, headers=scene.admin)).json()
    assert [i["kind"] for i in only["items"]] == ["MOCK_LOCATION"]
    # The database stamps the exception with the real clock, so "today" means the real today.
    real_today = dt.datetime.now(dt.UTC).date().isoformat()
    assert (
        len(
            (
                await client.get(
                    FEED,
                    params={"from_date": real_today, "to_date": real_today},
                    headers=scene.admin,
                )
            ).json()["items"]
        )
        == 3
    )
    assert (await client.get(FEED, params={"to_date": "2020-01-01"}, headers=scene.admin)).json()[
        "items"
    ] == []


async def test_the_feed_pages_newest_first(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    for _ in range(3):
        await send(client, scene.headers, "punch-in", await point_at(db, scene.branch, 500))
    first = (await client.get(FEED, params={"limit": 2}, headers=scene.admin)).json()
    assert len(first["items"]) == 2 and first["next_cursor"] is not None
    last = (
        await client.get(
            FEED, params={"limit": 2, "cursor": first["next_cursor"]}, headers=scene.admin
        )
    ).json()
    assert len(last["items"]) == 1 and last["next_cursor"] is None
    assert first["items"][0]["id"] > first["items"][1]["id"] > last["items"][0]["id"]


async def test_the_feed_is_for_people_who_can_see_everything(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    _, manager = await employee(client, db, scene, 2, role=ASSIGNER)
    _, hr = await actor(client, db, ADMIN)
    assert (await client.get(FEED, headers=hr)).status_code == 200
    for headers in (manager, scene.headers):
        assert (await client.get(FEED, headers=headers)).status_code == 403


# --- the employee's own month ------------------------------------------------------------------


async def test_my_month_shows_plan_and_outcome_for_every_day(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    clock.at(10, 0, day=MONDAY + dt.timedelta(days=2))  # Wednesday 3 March
    where = await at_branch(db, scene)
    # Monday 1 March worked in full, Tuesday nothing, today (Wednesday) not punched yet.
    clock.at(10, 5)
    await send(client, scene.headers, "punch-in", where)
    clock.at(18, 0)
    await send(client, scene.headers, "punch-out", where)
    clock.at(10, 0, day=MONDAY + dt.timedelta(days=2))
    month = (await client.get(f"{A}/me", params={"month": "2027-03"}, headers=scene.headers)).json()
    days = {d["date"]: d for d in month["days"]}
    assert len(month["days"]) == 31 and month["today"] == "2027-03-03"
    assert (days["2027-03-01"]["status"], days["2027-03-01"]["worked_minutes"]) == ("present", 475)
    assert days["2027-03-02"]["status"] == "absent"  # past working day, nobody punched
    assert days["2027-03-03"]["status"] is None  # today, nothing yet
    assert (
        days["2027-03-07"]["kind"] == "off" and days["2027-03-07"]["status"] is None
    )  # future Sunday
    assert days["2027-03-04"]["status"] is None
    assert month["summary"] == {
        "present": 1, "half_day": 0, "short_hours": 0, "absent": 1, "late": 0,
        "missed_punch_out": 0, "worked_minutes": 475,
    }  # fmt: skip


async def test_a_past_weekly_off_and_a_day_before_joining_are_derived(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    clock.at(9, 0, day=SUNDAY + dt.timedelta(days=3))  # Wednesday 10 March
    scene.user.joined_on = dt.date(2027, 3, 2)
    await db.flush()
    month = (await client.get(f"{A}/me", params={"month": "2027-03"}, headers=scene.headers)).json()
    days = {d["date"]: d for d in month["days"]}
    assert days["2027-03-01"]["status"] is None  # before joining
    assert days["2027-03-07"]["status"] == "weekly_off"


async def test_my_month_is_only_mine_and_validates_the_month(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    other, other_headers = await employee(client, db, scene, 2)
    await send(
        client,
        other_headers,
        "punch-in",
        await at_branch(db, scene),
        selfie=images.same_person("b", 1),
    )
    mine = (await client.get(f"{A}/me", params={"month": "2027-03"}, headers=scene.headers)).json()
    assert all(d["first_in_at"] is None for d in mine["days"])
    for bad in ("2027-13", "2027-3", "March", ""):
        assert (
            await client.get(f"{A}/me", params={"month": bad}, headers=scene.headers)
        ).status_code == 422
    assert (await client.get(f"{A}/me", params={"month": "2027-03"})).status_code == 401
    assert other.id != scene.user.id


# --- notifications -----------------------------------------------------------------------------


async def test_a_person_sees_only_their_own_notifications(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    other, _ = await employee(client, db, scene, 2)
    db.add_all(
        [
            Notification(user_id=scene.user.id, type="punch_out_reminder", title="a", body="first"),
            Notification(
                user_id=scene.user.id, type="punch_out_reminder", title="b", body="second"
            ),
            Notification(user_id=other.id, type="punch_out_reminder", title="c", body="theirs"),
        ]
    )
    await db.flush()
    page = (
        await client.get(f"{API}/notifications", params={"limit": 1}, headers=scene.headers)
    ).json()
    assert [n["body"] for n in page["items"]] == ["second"] and page["next_cursor"]
    rest = (
        await client.get(
            f"{API}/notifications", params={"cursor": page["next_cursor"]}, headers=scene.headers
        )
    ).json()
    assert [n["body"] for n in rest["items"]] == ["first"] and rest["next_cursor"] is None
    assert (await client.get(f"{API}/notifications")).status_code == 401
