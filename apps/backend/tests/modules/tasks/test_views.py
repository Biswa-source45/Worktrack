"""Who sees which task, the lists and filters, the detail page and the candidates list."""

import datetime as dt
from typing import Any

import httpx
import pytest
from geoalchemy2 import WKTElement
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.attendance.models import AttendanceDay
from app.modules.auth.permissions import TASKS_CREATE, TEAM_VIEW
from app.modules.shifts.models import Holiday
from app.modules.tasks.models import Task, TaskAssignee
from tests.factories import (
    ADMIN,
    OFFICE,
    auth_headers,
    device,
    headers_with,
    make_shift,
    make_user,
)
from tests.modules.attendance.conftest import MONDAY, SUNDAY, Clock
from tests.modules.employees.helpers import API, actor, error_code
from tests.modules.tasks.helpers import (
    TASKS,
    assigner,
    count_statements,
    detail,
    field_person,
    make_task,
    type_id,
)
from tests.modules.tasks.test_actions import set_status


async def listed(
    client: httpx.AsyncClient, headers: dict[str, str], **params: Any
) -> dict[str, Any]:
    response = await client.get(TASKS, params=params, headers=headers)
    assert response.status_code == 200, response.text
    out: dict[str, Any] = response.json()
    return out


def ids(page: dict[str, Any]) -> list[int]:
    return [item["id"] for item in page["items"]]


# --- scope -------------------------------------------------------------------------------------


async def test_each_assigner_lists_only_their_own_tasks_and_an_admin_lists_all(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, one = await assigner(client, db)
    _, two = await assigner(client, db)
    _, admin = await actor(client, db, ADMIN)
    ann, _ = await field_person(client, db, 1)
    mine = await make_task(client, one, [ann.id])
    theirs = await make_task(client, two, [ann.id])
    assert ids(await listed(client, one)) == [mine["id"]]
    assert ids(await listed(client, two)) == [theirs["id"]]
    assert set(ids(await listed(client, admin))) == {mine["id"], theirs["id"]}
    assert ids(await listed(client, admin, view="assigned_by_me")) == []
    assert ids(await listed(client, one, view="assigned_by_me")) == [mine["id"]]


async def test_a_manager_sees_the_tasks_of_their_team(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    manager, manager_headers = await assigner(client, db)
    _, other = await assigner(client, db)
    mine, _ = await field_person(client, db, 1, manager_id=manager.id)
    deep, _ = await field_person(client, db, 2, manager_id=mine.id)
    outsider, _ = await field_person(client, db, 3)
    team_task = await make_task(client, other, [mine.id])
    deep_task = await make_task(client, other, [deep.id])
    outside_task = await make_task(client, other, [outsider.id])
    page = await listed(client, manager_headers, view="team")
    assert set(ids(page)) == {team_task["id"], deep_task["id"]}
    assert outside_task["id"] not in ids(page)
    # Their own list is still only what they created.
    assert ids(await listed(client, manager_headers, view="assigned_by_me")) == []
    # They can open a team task but not manage it.
    seen = await detail(client, manager_headers, team_task["id"])
    assert seen["can_manage"] is False
    hidden = await client.get(f"{TASKS}/{outside_task['id']}", headers=manager_headers)
    assert (hidden.status_code, error_code(hidden)) == (404, "TASK_NOT_FOUND")


async def test_views_need_their_permission(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, boss = await assigner(client, db)
    _, field = await field_person(client, db, 1)
    for view in (None, "assigned_by_me", "team", "all"):
        params = {} if view is None else {"view": view}
        response = await client.get(TASKS, params=params, headers=field)
        assert (response.status_code, error_code(response)) == (403, "FORBIDDEN")
    refused = await client.get(TASKS, params={"view": "all"}, headers=boss)
    assert (refused.status_code, error_code(refused)) == (403, "FORBIDDEN")
    create_only = await headers_with(client, db, TASKS_CREATE)
    team = await client.get(TASKS, params={"view": "team"}, headers=create_only)
    assert (team.status_code, error_code(team)) == (403, "FORBIDDEN")
    team_only = await headers_with(client, db, TEAM_VIEW)
    mine = await client.get(TASKS, params={"view": "assigned_by_me"}, headers=team_only)
    assert (mine.status_code, error_code(mine)) == (403, "FORBIDDEN")
    assert (await client.get(TASKS, headers=team_only)).status_code == 200


async def test_the_detail_is_for_the_creator_the_assignees_and_admins_only(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, boss = await assigner(client, db)
    _, other = await assigner(client, db)
    _, admin = await actor(client, db, ADMIN)
    ann, ann_headers = await field_person(client, db, 1)
    _, stranger = await field_person(client, db, 2)
    task = await make_task(client, boss, [ann.id])
    for headers in (boss, ann_headers, admin):
        assert (await detail(client, headers, task["id"]))["id"] == task["id"]
    for headers in (other, stranger):
        response = await client.get(f"{TASKS}/{task['id']}", headers=headers)
        assert (response.status_code, error_code(response)) == (404, "TASK_NOT_FOUND")
    missing = await client.get(f"{TASKS}/999999999", headers=boss)
    assert (missing.status_code, error_code(missing)) == (404, "TASK_NOT_FOUND")
    assert (await detail(client, boss, task["id"]))["can_manage"] is True
    assert (await detail(client, ann_headers, task["id"]))["can_manage"] is False


# --- filters and paging ------------------------------------------------------------------------


async def test_filters(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, boss = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    ben, _ = await field_person(client, db, 2)
    meeting = await type_id(client, boss, "Client Meeting")
    one = await make_task(
        client, boss, [ann.id], title="Firewall at Acme", client_name="Acme Ltd",
        scheduled_at="2027-03-01T05:00:00Z",
    )  # fmt: skip
    two = await make_task(
        client, boss, [ben.id], title="Visit", client_name="Globex 100%", type_id=meeting,
        scheduled_at="2027-03-02T20:00:00Z",
    )  # fmt: skip
    three = await make_task(
        client, boss, [ann.id, ben.id], title="Maintenance", client_name="Initech_X",
        scheduled_at="2027-03-05T05:00:00Z",
    )  # fmt: skip
    row = await db.get(Task, three["id"])
    assert row is not None
    row.status = "cancelled"
    await db.flush()
    assert set(ids(await listed(client, boss))) == {one["id"], two["id"], three["id"]}
    assert ids(await listed(client, boss, status=["assigned"])) == [two["id"], one["id"]]
    both = await listed(client, boss, status=["cancelled", "declined"])
    assert ids(both) == [three["id"]]
    assert set(ids(await listed(client, boss, assignee=ann.id))) == {one["id"], three["id"]}
    assert ids(await listed(client, boss, type_id=meeting)) == [two["id"]]
    assert ids(await listed(client, boss, q="acme")) == [one["id"]]
    assert ids(await listed(client, boss, q=one["code"].lower())) == [one["id"]]
    assert ids(await listed(client, boss, q="globex 100%")) == [two["id"]]
    assert ids(await listed(client, boss, q="%")) == [two["id"]]
    assert ids(await listed(client, boss, q="_")) == [three["id"]]
    assert ids(await listed(client, boss, q="nothing like it")) == []
    # Dates are IST days of the scheduled time: 2027-03-02T20:00Z is already 3 March in IST.
    assert ids(await listed(client, boss, **{"from": "2027-03-03", "to": "2027-03-03"})) == [
        two["id"]
    ]
    assert ids(await listed(client, boss, **{"from": "2027-03-04"})) == [three["id"]]
    assert set(ids(await listed(client, boss, **{"to": "2027-03-02"}))) == {one["id"]}
    both_ends = await listed(client, boss, **{"from": "2027-03-01", "to": "2027-03-03"})
    assert set(ids(both_ends)) == {one["id"], two["id"]}


async def test_pages_follow_one_another_without_gaps(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, boss = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    made = [(await make_task(client, boss, [ann.id]))["id"] for _ in range(5)]
    seen: list[int] = []
    cursor = None
    for _ in range(5):
        page = await listed(client, boss, limit=2, **({"cursor": cursor} if cursor else {}))
        seen += ids(page)
        cursor = page["next_cursor"]
        if cursor is None:
            break
    assert seen == list(reversed(made))
    assert cursor is None
    bad = await client.get(TASKS, params={"limit": 0}, headers=boss)
    assert bad.status_code == 422


async def test_a_list_costs_the_same_number_of_queries_however_long(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, boss = await assigner(client, db)
    ann, ann_headers = await field_person(client, db, 1)
    await make_task(client, boss, [ann.id])
    with count_statements(db) as one:
        await listed(client, boss)
    with count_statements(db) as mine_one:
        await client.get(f"{API}/me/tasks", headers=ann_headers)
    for _ in range(5):
        await make_task(client, boss, [ann.id])
    with count_statements(db) as many:
        page = await listed(client, boss)
    with count_statements(db) as mine_many:
        await client.get(f"{API}/me/tasks", headers=ann_headers)
    assert len(page["items"]) == 6
    assert len(many) == len(one)
    assert len(mine_many) == len(mine_one)


# --- the detail --------------------------------------------------------------------------------


async def reached(db: AsyncSession, task_id: int, user_id: int, **fields: Any) -> TaskAssignee:
    row = (
        await db.execute(
            select(TaskAssignee)
            .where(TaskAssignee.task_id == task_id, TaskAssignee.user_id == user_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    row.status = "reached"
    row.reached_at = dt.datetime(2027, 3, 1, 5, 0, tzinfo=dt.UTC)
    row.reached_location = WKTElement("POINT(85.851 20.301)", srid=4326)
    row.reached_accuracy_m = 8
    row.reached_distance_m = 143.6
    row.reached_selfie_key = f"task/{user_id}/secret-selfie.jpg"
    row.reached_face_score = 0.55
    row.reached_face_decision = "VERIFIED"
    row.reach_flags = ["location_mismatch"]
    row.reach_reason = "The gate was on the other side"
    row.reach_review = "pending"
    for name, value in fields.items():
        setattr(row, name, value)
    await db.flush()
    return row


async def test_reached_details_are_for_managers_and_the_score_for_face_reviewers(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, boss = await assigner(client, db)
    _, admin = await actor(client, db, ADMIN)
    manager, manager_headers = await assigner(client, db)
    ann, ann_headers = await field_person(client, db, 1, manager_id=manager.id)
    ben, _ = await field_person(client, db, 2)
    task = await make_task(client, boss, [ann.id, ben.id])
    await reached(db, task["id"], ann.id)
    await reached(db, task["id"], ben.id, reach_flags=[])

    as_boss = await detail(client, boss, task["id"])
    mine = next(a for a in as_boss["assignees"] if a["user"]["id"] == ann.id)["reach"]
    assert mine["distance_m"] == 144
    assert mine["flags"] == ["location_mismatch"]
    assert mine["review"] == "pending"
    assert mine["reason"] == "The gate was on the other side"
    assert (round(mine["lat"], 3), round(mine["lng"], 3)) == (20.301, 85.851)
    assert mine["face_decision"] == "VERIFIED"
    assert mine["selfie_url"].startswith("/api/v1/files/")
    # The creator is no face reviewer: no score.
    assert mine["face_score"] is None
    as_admin = await detail(client, admin, task["id"])
    admin_view = next(a for a in as_admin["assignees"] if a["user"]["id"] == ann.id)["reach"]
    assert admin_view["face_score"] == pytest.approx(0.55)

    # The employee sees their own result, without the selfie, position or score ...
    as_ann = await detail(client, ann_headers, task["id"])
    own = next(a for a in as_ann["assignees"] if a["user"]["id"] == ann.id)["reach"]
    assert own["distance_m"] == 144 and own["review"] == "pending"
    for hidden in ("selfie_url", "face_score", "face_decision", "lat", "lng", "accuracy_m"):
        assert own[hidden] is None
    # ... and nothing of the other person's.
    other = next(a for a in as_ann["assignees"] if a["user"]["id"] == ben.id)
    assert other["reach"] is None
    # A manager watching from a team scope is not a manager of the task.
    as_team = await detail(client, manager_headers, task["id"])
    assert all(a["reach"] is None for a in as_team["assignees"] if a["user"]["id"] == ann.id)
    assert "secret-selfie" not in str(as_ann) + str(as_team)


async def test_attachments_are_signed_links_that_open_and_expire_with_the_token(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, boss = await assigner(client, db)
    ann, ann_headers = await field_person(client, db, 1)
    task = await make_task(client, boss, [ann.id])
    response = await client.post(
        f"{TASKS}/{task['id']}/attachments",
        files={"file": ("brief.pdf", b"%PDF-1.4 hello", "application/pdf")},
        headers={**boss, "Idempotency-Key": "11111111-1111-1111-1111-111111111111"},
    )
    assert response.status_code == 201, response.text
    [brief] = (await detail(client, ann_headers, task["id"]))["attachments"]
    assert brief["url"].startswith("/api/v1/files/") and "task/" not in brief["url"]
    opened = await client.get(brief["url"])
    assert (opened.status_code, opened.headers["content-type"]) == (200, "application/pdf")
    assert opened.content == b"%PDF-1.4 hello"
    broken = await client.get(brief["url"][:-3] + "abc")
    assert broken.status_code == 404


# --- my tasks ----------------------------------------------------------------------------------


async def test_my_tasks_are_mine_and_split_into_active_and_done(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    boss_user, boss = await assigner(client, db)
    ann, ann_headers = await field_person(client, db, 1)
    ben, ben_headers = await field_person(client, db, 2)
    active = await make_task(client, boss, [ann.id])
    done = await make_task(client, boss, [ann.id])
    declined = await make_task(client, boss, [ann.id, ben.id])
    others = await make_task(client, boss, [ben.id])
    await set_status(db, done["id"], ann.id, "completed")
    await set_status(db, declined["id"], ann.id, "declined")

    mine = await client.get(f"{API}/me/tasks", headers=ann_headers)
    assert mine.status_code == 200
    page = mine.json()
    assert [t["id"] for t in page["items"]] == [active["id"]]
    item = page["items"][0]
    assert item["my"]["status"] == "assigned"
    assert item["site"]["radius_m"] == 200 and item["created_by"]["id"] == boss_user.id
    assert item["type"]["proof_kind"] == "photo" and item["type"]["proof_photo_required"] is True
    assert "assignees" not in item
    finished = await client.get(f"{API}/me/tasks", params={"state": "done"}, headers=ann_headers)
    assert [t["id"] for t in finished.json()["items"]] == [declined["id"], done["id"]]
    ben_page = await client.get(f"{API}/me/tasks", headers=ben_headers)
    assert {t["id"] for t in ben_page.json()["items"]} == {declined["id"], others["id"]}
    paged = await client.get(
        f"{API}/me/tasks", params={"state": "done", "limit": 1}, headers=ann_headers
    )
    assert paged.json()["next_cursor"] is not None
    bad = await client.get(f"{API}/me/tasks", params={"state": "all"}, headers=ann_headers)
    assert bad.status_code == 422


# --- candidates --------------------------------------------------------------------------------


async def candidates(client: httpx.AsyncClient, headers: dict[str, str]) -> dict[str, str]:
    response = await client.get(f"{TASKS}/candidates", headers=headers)
    assert response.status_code == 200, response.text
    for item in response.json()["items"]:
        assert set(item) == {"id", "name", "emp_code", "status"}
    return {item["name"]: item["status"] for item in response.json()["items"]}


async def test_candidates_show_each_persons_status_today(
    client: httpx.AsyncClient, db: AsyncSession, clock: Clock
) -> None:
    _, boss = await assigner(client, db)
    shift = await make_shift(db, weekly_offs=[{"weekday": 6, "weeks": None}])
    names = {}
    for label in ("in office", "on task", "punched out", "not in", "busy first"):
        user = await make_user(
            db, "Field Employee", field_eligible=True, name=label, shift_id=shift.id
        )
        names[label] = user
    now = clock.now
    db.add(
        AttendanceDay(user_id=names["in office"].id, date=MONDAY, status="working", first_in_at=now)
    )
    db.add(
        AttendanceDay(
            user_id=names["punched out"].id,
            date=MONDAY,
            status="present",
            first_in_at=now,
            last_out_at=now,
        )
    )
    # Working in the office, but on a task: the task wins.
    db.add(
        AttendanceDay(
            user_id=names["busy first"].id, date=MONDAY, status="working", first_in_at=now
        )
    )
    await db.flush()
    _, other = await assigner(client, db)
    on_task = await make_task(client, other, [names["on task"].id])
    busy = await make_task(client, other, [names["busy first"].id])
    await set_status(db, on_task["id"], names["on task"].id, "accepted")
    await set_status(db, busy["id"], names["busy first"].id, "in_progress")
    got = await candidates(client, boss)
    assert got == {
        "in office": "in_office",
        "on task": "on_task",
        "punched out": "punched_out",
        "not in": "not_punched_in",
        "busy first": "on_task",
    }
    # Finished and declined assignments do not make someone busy.
    await set_status(db, on_task["id"], names["on task"].id, "completed")
    await set_status(db, busy["id"], names["busy first"].id, "declined")
    again = await candidates(client, boss)
    assert again["on task"] == "not_punched_in" and again["busy first"] == "in_office"


async def test_candidates_on_a_weekly_off_or_holiday_are_off_day(
    client: httpx.AsyncClient, db: AsyncSession, clock: Clock
) -> None:
    _, boss = await assigner(client, db)
    shift = await make_shift(db, weekly_offs=[{"weekday": 6, "weeks": None}])
    plain = await make_user(
        db, "Field Employee", field_eligible=True, name="plain", shift_id=shift.id
    )
    clock.at(10, 0, day=SUNDAY)
    assert (await candidates(client, boss))["plain"] == "off_day"
    clock.at(10, 0)
    assert (await candidates(client, boss))["plain"] == "not_punched_in"
    db.add(Holiday(date=MONDAY, name="Founders day", branch_id=None))
    await db.flush()
    assert (await candidates(client, boss))["plain"] == "off_day"
    assert plain.id


async def test_candidates_leave_out_office_staff_and_people_who_left(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, boss = await assigner(client, db)
    await make_user(db, OFFICE, name="office person", field_eligible=False)
    await make_user(db, "Field Employee", name="gone", field_eligible=True, status="inactive")
    await make_user(db, "Field Employee", name="not eligible")
    await make_user(db, "Field Employee", name="eligible", field_eligible=True)
    assert await candidates(client, boss) == {"eligible": "not_punched_in"}


async def test_candidates_cost_the_same_number_of_queries_for_any_number_of_people(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, boss = await assigner(client, db)
    await make_user(db, "Field Employee", field_eligible=True)
    with count_statements(db) as one:
        await client.get(f"{TASKS}/candidates", headers=boss)
    for _ in range(6):
        await make_user(db, "Field Employee", field_eligible=True)
    with count_statements(db) as many:
        response = await client.get(f"{TASKS}/candidates", headers=boss)
    assert len(response.json()["items"]) == 7
    assert len(many) == len(one)


async def test_only_assigners_see_the_candidates(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, field = await field_person(client, db, 1)
    office = await auth_headers(
        client, await make_user(db, OFFICE), kind="mobile", device_info=device(2)
    )
    for headers in (field, office):
        response = await client.get(f"{TASKS}/candidates", headers=headers)
        assert (response.status_code, error_code(response)) == (403, "FORBIDDEN")
