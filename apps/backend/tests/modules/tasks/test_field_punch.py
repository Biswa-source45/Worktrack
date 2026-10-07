"""Field punch-in (FR-ATT-10): a person allowed to may punch in at the site of a task they accepted
for today, and it is marked as such. Decision Q1 of M5: off by default, one task per site."""

from typing import Any

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.tasks.models import Task, TaskAssignee
from tests.modules.attendance.conftest import SUNDAY, Clock, Scene, employee
from tests.modules.attendance.test_punch import events, send, today_row
from tests.modules.employees.helpers import API, audit_rows, error_code
from tests.modules.face import images
from tests.modules.tasks.helpers import (
    SITE,
    act,
    assigner,
    count_statements,
    make_task,
    point_from_site,
)
from tests.modules.tasks.test_actions import set_status

A = f"{API}/attendance"
ADMIN_ATT = f"{API}/admin/attendance"


async def field_task(
    client: httpx.AsyncClient,
    db: AsyncSession,
    scene: Scene,
    *,
    allowed: bool = True,
    status: str | None = "accepted",
    **over: Any,
) -> dict[str, Any]:
    """A task for the scene's employee at a site far from the branch, in the given state."""
    scene.user.field_eligible = True
    scene.user.field_punch_in_allowed = allowed
    await db.flush()
    _, boss = await assigner(client, db)
    over.setdefault("site", SITE)
    task = await make_task(client, boss, [scene.user.id], **over)
    if status == "accepted":
        assert (await act(client, scene.headers, task["id"], "accept")).status_code == 200
    elif status is not None and status != "assigned":
        await set_status(db, task["id"], scene.user.id, status)
    return task


async def precheck(
    client: httpx.AsyncClient, scene: Scene, where: dict[str, float], accuracy: float = 10
) -> dict[str, Any]:
    response = await client.post(
        f"{A}/precheck", json={**where, "accuracy_m": accuracy}, headers=scene.headers
    )
    assert response.status_code == 200, response.text
    out: dict[str, Any] = response.json()
    return out


# --- when it is allowed ------------------------------------------------------------------------


async def test_a_field_punch_in_at_the_site_of_todays_accepted_task(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    task = await field_task(client, db, scene)
    where = await point_from_site(db, task["id"], 40)
    clock.at(10, 6)
    checked = await precheck(client, scene, where)
    assert checked["allowed"] is True
    assert checked["place"] == {
        "type": "task",
        "branch": None,
        "task": task["code"],
        "distance_m": 40,
    }

    response = await send(client, scene.headers, "punch-in", where)
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["result"] == "verified"
    assert body["punch"]["place"]["type"] == "task"
    assert body["punch"]["place"]["task"] == task["code"]
    assert "field_punch" in body["day"]["flags"]
    [event] = await events(db, scene.user.id)
    assert (event.location_type, event.task_id, event.branch_id) == ("task", task["id"], None)
    assert event.distance_m == pytest.approx(40, abs=0.01)
    assert (await today_row(db, scene.user.id)).flags == ["field_punch"]

    today = (await client.get(f"{A}/today", headers=scene.headers)).json()
    assert today["punches"][0]["place"]["task"] == task["code"]
    assert today["action"] == "punch_out"


@pytest.mark.parametrize("status", ["accepted", "reached", "in_progress", "on_hold"])
async def test_any_working_state_of_the_assignment_counts(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, status: str
) -> None:
    task = await field_task(client, db, scene, status=status)
    where = await point_from_site(db, task["id"], 10)
    assert (await send(client, scene.headers, "punch-in", where)).status_code == 201


@pytest.mark.parametrize("status", ["assigned", "declined", "cancelled", "completed"])
async def test_a_task_that_is_not_accepted_or_is_finished_does_not_count(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, status: str
) -> None:
    task = await field_task(client, db, scene, status=status)
    where = await point_from_site(db, task["id"], 10)
    assert (await precheck(client, scene, where))["allowed"] is False
    response = await send(client, scene.headers, "punch-in", where)
    assert (response.status_code, error_code(response)) == (422, "OUTSIDE_GEOFENCE")
    assert await events(db, scene.user.id) == []


async def test_a_cancelled_or_closed_task_does_not_count_even_if_the_person_is_marked_working(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    task = await field_task(client, db, scene)
    row = await db.get(Task, task["id"], populate_existing=True)
    assert row is not None
    row.status = "cancelled"
    await db.flush()
    where = await point_from_site(db, task["id"], 10)
    response = await send(client, scene.headers, "punch-in", where)
    assert (response.status_code, error_code(response)) == (422, "OUTSIDE_GEOFENCE")


# --- when it is not ----------------------------------------------------------------------------


async def test_it_is_off_by_default(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    assert scene.user.field_punch_in_allowed is False
    task = await field_task(client, db, scene, allowed=False)
    where = await point_from_site(db, task["id"], 10)
    assert (await precheck(client, scene, where))["allowed"] is False
    response = await send(client, scene.headers, "punch-in", where)
    assert (response.status_code, error_code(response)) == (422, "OUTSIDE_GEOFENCE")
    assert await events(db, scene.user.id) == []


async def test_it_needs_a_task(client: httpx.AsyncClient, db: AsyncSession, scene: Scene) -> None:
    scene.user.field_punch_in_allowed = True
    await db.flush()
    where = {"lat": SITE["lat"], "lng": SITE["lng"]}
    response = await send(client, scene.headers, "punch-in", where)
    assert (response.status_code, error_code(response)) == (422, "OUTSIDE_GEOFENCE")


async def test_it_needs_a_task_scheduled_for_today_in_ist(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    clock.at(10, 6)
    # Monday 2027-03-01 in IST runs from 2027-02-28T18:30Z to 2027-03-01T18:30Z.
    days = {
        "yesterday 23:59": ("2027-02-28T18:29:00Z", False),
        "today 00:00": ("2027-02-28T18:30:00Z", True),
        "today 23:59": ("2027-03-01T18:29:00Z", True),
        "tomorrow 00:00": ("2027-03-01T18:30:00Z", False),
    }
    for label, (scheduled, accepted) in days.items():
        task = await field_task(client, db, scene, scheduled_at=scheduled)
        where = await point_from_site(db, task["id"], 10)
        verdict = (await precheck(client, scene, where))["allowed"]
        assert verdict is accepted, label
        row = await db.get(Task, task["id"], populate_existing=True)
        assert row is not None
        row.status = "cancelled"  # the next label starts clean
        await db.flush()


async def test_it_needs_the_point_to_be_inside_the_site(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    task = await field_task(client, db, scene)
    inside = await point_from_site(db, task["id"], 230)
    outside = await point_from_site(db, task["id"], 231)
    assert (await precheck(client, scene, outside, accuracy=30))["allowed"] is False
    response = await send(client, scene.headers, "punch-in", outside, accuracy=30)
    assert (response.status_code, error_code(response)) == (422, "OUTSIDE_GEOFENCE")
    assert (await send(client, scene.headers, "punch-in", inside, accuracy=30)).status_code == 201


async def test_another_persons_task_does_not_open_the_site(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    task = await field_task(client, db, scene)
    other, headers = await employee(client, db, scene, 2, "b")
    other.field_punch_in_allowed = True
    await db.flush()
    where = await point_from_site(db, task["id"], 10)
    response = await send(client, headers, "punch-in", where, selfie=images.same_person("b", 1))
    assert (response.status_code, error_code(response)) == (422, "OUTSIDE_GEOFENCE")


async def test_a_day_off_still_blocks_a_field_punch_in(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    clock.at(10, 6, day=SUNDAY)
    task = await field_task(client, db, scene, scheduled_at="2027-03-07T05:30:00Z")
    where = await point_from_site(db, task["id"], 10)
    response = await send(client, scene.headers, "punch-in", where)
    assert (response.status_code, error_code(response)) == (409, "OFF_DAY")


async def test_a_branch_is_still_preferred_where_both_apply(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    site = SITE | {"lat": scene.branch.lat, "lng": scene.branch.lng}
    await field_task(client, db, scene, site=site)
    where = {"lat": scene.branch.lat, "lng": scene.branch.lng}
    response = await send(client, scene.headers, "punch-in", where)
    assert response.status_code == 201, response.text
    [event] = await events(db, scene.user.id)
    assert (event.location_type, event.branch_id, event.task_id) == (
        "branch",
        scene.branch.id,
        None,
    )


async def test_the_branch_still_works_for_a_person_allowed_to_punch_in_in_the_field(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    await field_task(client, db, scene)
    where = {"lat": scene.branch.lat, "lng": scene.branch.lng}
    assert (await send(client, scene.headers, "punch-in", where)).status_code == 201


async def test_punching_out_at_the_site_stays_an_out_of_office_request(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    task = await field_task(client, db, scene)
    where = await point_from_site(db, task["id"], 10)
    clock.at(10, 6)
    assert (await send(client, scene.headers, "punch-in", where)).status_code == 201
    clock.at(17, 0)
    plain = await send(client, scene.headers, "punch-out", where)
    assert (plain.status_code, error_code(plain)) == (422, "OUTSIDE_GEOFENCE")
    checked = await precheck(client, scene, where)
    assert (checked["action"], checked["allowed"]) == ("request_punch_out", True)
    request = await send(
        client, scene.headers, "punch-out-requests", where, reason="Finished at the client site"
    )
    assert request.status_code == 201, request.text
    assert request.json()["punch"]["out_of_office"] is True


# --- what the admin sees -----------------------------------------------------------------------


async def test_the_day_detail_lists_the_persons_tasks_for_that_day(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    task = await field_task(client, db, scene)
    other_day = await field_task(client, db, scene, scheduled_at="2027-03-02T05:30:00Z")
    stranger_task = await field_task(client, db, scene)
    row = (
        await db.execute(
            select(TaskAssignee)
            .where(TaskAssignee.task_id == stranger_task["id"])
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    other, _ = await employee(client, db, scene, 2, "b")
    row.user_id = other.id
    await db.flush()
    where = await point_from_site(db, task["id"], 10)
    clock.at(10, 6)
    assert (await send(client, scene.headers, "punch-in", where)).status_code == 201
    clock.at(10, 20)
    await set_status(db, task["id"], scene.user.id, "in_progress")
    day = await today_row(db, scene.user.id)

    response = await client.get(f"{ADMIN_ATT}/{day.id}", headers=scene.admin)
    assert response.status_code == 200, response.text
    out = response.json()
    codes = [t["code"] for t in out["tasks"]]
    assert task["code"] in codes
    assert other_day["code"] not in codes and stranger_task["code"] not in codes
    mine = next(t for t in out["tasks"] if t["id"] == task["id"])
    assert (mine["title"], mine["status"]) == (task["title"], "in_progress")
    assert set(mine) == {"id", "code", "title", "status", "reached_at", "completed_at"}
    assert out["punches"][0]["place"]["task"] == task["code"]
    assert "field_punch" in out["day"]["flags"]

    listed = (
        await client.get(ADMIN_ATT, params={"date": "2027-03-01"}, headers=scene.admin)
    ).json()
    register_row = next(r for r in listed["items"] if r["employee"]["id"] == scene.user.id)
    assert "field_punch" in register_row["flags"]


async def test_a_day_without_tasks_says_so_and_the_tasks_cost_one_query(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    where = {"lat": scene.branch.lat, "lng": scene.branch.lng}
    assert (await send(client, scene.headers, "punch-in", where)).status_code == 201
    day = await today_row(db, scene.user.id)
    with count_statements(db) as none:
        empty = await client.get(f"{ADMIN_ATT}/{day.id}", headers=scene.admin)
    assert empty.json()["tasks"] == []
    for _ in range(4):
        await field_task(client, db, scene)
    with count_statements(db) as four:
        shown = await client.get(f"{ADMIN_ATT}/{day.id}", headers=scene.admin)
    assert len(shown.json()["tasks"]) == 4
    assert len(four) == len(none)


# --- who may switch it on ----------------------------------------------------------------------


async def test_the_switch_is_set_on_the_employee_and_audited(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    url = f"{API}/admin/employees/{scene.user.id}"
    before = (await client.get(url, headers=scene.admin)).json()
    assert before["field_punch_in_allowed"] is False
    response = await client.patch(url, json={"field_punch_in_allowed": True}, headers=scene.admin)
    assert response.status_code == 200, response.text
    assert response.json()["field_punch_in_allowed"] is True
    assert (await client.get(url, headers=scene.admin)).json()["field_punch_in_allowed"] is True
    [row] = await audit_rows(db, "employee.update")
    assert row.before is not None and row.before["field_punch_in_allowed"] is False
    assert row.after is not None and row.after["field_punch_in_allowed"] is True
    null = await client.patch(url, json={"field_punch_in_allowed": None}, headers=scene.admin)
    assert (null.status_code, error_code(null)) == (422, "VALIDATION_ERROR")
    off = await client.patch(url, json={"field_punch_in_allowed": False}, headers=scene.admin)
    assert off.json()["field_punch_in_allowed"] is False


async def test_the_employee_list_shows_the_switch(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    scene.user.field_punch_in_allowed = True
    await db.flush()
    listed = (await client.get(f"{API}/admin/employees", headers=scene.admin)).json()
    mine = next(e for e in listed["items"] if e["id"] == scene.user.id)
    assert mine["field_punch_in_allowed"] is True
