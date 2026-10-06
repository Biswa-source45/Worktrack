"""Creating, editing, assigning and unassigning tasks (FR-TASK-01, FR-TASK-02)."""

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.notifications.models import Notification
from app.modules.tasks.models import Task, TaskAssignee, TaskEvent, TaskType
from tests.factories import ADMIN, FIELD, OFFICE, auth_headers, device, make_user
from tests.modules.employees.helpers import actor, audit_rows, error_code
from tests.modules.tasks.helpers import (
    SITE,
    TASKS,
    act,
    assigner,
    body,
    field_person,
    key,
    make_task,
    post,
    status_of,
    type_id,
)


async def events(db: AsyncSession, task_id: int) -> list[str]:
    rows = await db.execute(
        select(TaskEvent.event).where(TaskEvent.task_id == task_id).order_by(TaskEvent.id)
    )
    return list(rows.scalars())


async def notifications(db: AsyncSession, user_id: int, kind: str | None = None) -> list[str]:
    stmt = select(Notification.type).where(Notification.user_id == user_id)
    if kind is not None:
        stmt = stmt.where(Notification.type == kind)
    return list((await db.execute(stmt.order_by(Notification.id))).scalars())


# --- create ------------------------------------------------------------------------------------


async def test_a_task_is_created_with_a_code_assignees_and_a_timeline(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    boss, headers = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    ben, _ = await field_person(client, db, 2)
    kind = await type_id(client, headers, "Firewall Installation")
    response = await client.post(
        TASKS,
        json=body(
            [ann.id, ben.id],
            type_id=kind,
            contact_name="Rao",
            contact_phone="98765 43210",
            priority="high",
            expected_minutes=90,
            description="Rack the box",
        ),
        headers={**headers, "Idempotency-Key": key()},
    )
    assert response.status_code == 201, response.text
    out = response.json()
    task = out["task"]
    assert out["replayed"] is False
    assert task["code"].startswith("T-") and len(task["code"]) >= 7
    assert (task["status"], task["priority"], task["can_manage"]) == ("assigned", "high", True)
    assert task["type"]["name"] == "Firewall Installation"
    assert task["site"] == SITE
    assert task["contact_phone"] == "+919876543210"
    assert task["created_by"]["id"] == boss.id
    assert {a["user"]["id"]: a["status"] for a in task["assignees"]} == {
        ann.id: "assigned",
        ben.id: "assigned",
    }
    assert [e["event"] for e in task["events"]] == ["created", "assigned", "assigned"]


async def test_the_site_radius_defaults_from_settings(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    site = {"address": "Somewhere", "lat": 20.3, "lng": 85.85}
    task = await make_task(client, headers, [ann.id], site=site)
    assert task["site"]["radius_m"] == 200


async def test_each_assignee_gets_a_notification_but_the_creator_does_not(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    boss, headers = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    task = await make_task(client, headers, [ann.id])
    rows = list((await db.execute(select(Notification))).scalars())
    assert [(n.user_id, n.type, n.deep_link) for n in rows] == [
        (ann.id, "task_assigned", f"/tasks/{task['id']}")
    ]
    assert boss.id not in {n.user_id for n in rows}


async def test_creating_is_audited(client: httpx.AsyncClient, db: AsyncSession) -> None:
    boss, headers = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    task = await make_task(client, headers, [ann.id])
    [row] = await audit_rows(db, "task.create")
    assert (row.actor_id, row.entity, row.entity_id) == (boss.id, "task", str(task["id"]))
    assert row.after is not None and row.after["assignee_ids"] == [ann.id]


async def test_only_field_eligible_active_people_can_be_assigned(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await assigner(client, db)
    kind = await type_id(client, headers)
    office = await make_user(db, OFFICE)
    not_field = await make_user(db, FIELD)
    gone = await make_user(db, FIELD, field_eligible=True, status="inactive")
    expected = [
        (office, "NOT_FIELD_ELIGIBLE"),
        (not_field, "NOT_FIELD_ELIGIBLE"),
        (gone, "INVALID_REFERENCE"),
    ]
    for person, code in expected:
        response = await post(client, headers, "", body([person.id], type_id=kind))
        assert (response.status_code, error_code(response)) == (422, code)
    missing = await post(client, headers, "", body([999_999_999], type_id=kind))
    assert (missing.status_code, error_code(missing)) == (422, "INVALID_REFERENCE")
    assert (await db.execute(select(Task))).first() is None


async def test_an_unknown_or_inactive_task_type_is_refused(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    unknown = await post(client, headers, "", body([ann.id], type_id=999_999))
    assert (unknown.status_code, error_code(unknown)) == (422, "INVALID_REFERENCE")
    row = await db.get(TaskType, await type_id(client, headers, "Maintenance"))
    assert row is not None
    row.is_active = False
    await db.flush()
    off = await post(client, headers, "", body([ann.id], type_id=row.id))
    assert (off.status_code, error_code(off)) == (422, "INVALID_REFERENCE")


async def test_bad_input_is_refused(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    good = body([ann.id], type_id=await type_id(client, headers))
    bad = [
        good | {"assignee_ids": []},
        good | {"assignee_ids": [ann.id, ann.id]},
        good | {"title": "  "},
        good | {"site": SITE | {"lat": 91}},
        good | {"site": SITE | {"radius_m": 10}},
        good | {"site": SITE | {"radius_m": 501}},
        good | {"scheduled_at": "2027-03-01T11:00:00"},
        good | {"priority": "asap"},
        good | {"contact_phone": "12"},
        good | {"expected_minutes": 0},
        good | {"surprise": 1},
    ]
    for payload in bad:
        response = await post(client, headers, "", payload)
        assert (response.status_code, error_code(response)) == (422, "VALIDATION_ERROR"), payload
    no_key = await client.post(TASKS, json=good, headers=headers)
    assert (no_key.status_code, error_code(no_key)) == (422, "VALIDATION_ERROR")
    assert (await db.execute(select(Task))).first() is None


async def test_creating_twice_with_one_key_makes_one_task(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    payload = body([ann.id], type_id=await type_id(client, headers))
    used = key()
    one = await post(client, headers, "", payload, idem=used)
    two = await post(client, headers, "", payload, idem=used)
    assert (one.status_code, two.status_code) == (201, 201)
    assert (one.json()["replayed"], two.json()["replayed"]) == (False, True)
    assert one.json()["task"]["id"] == two.json()["task"]["id"]
    assert len(list((await db.execute(select(Task))).scalars())) == 1
    assert await events(db, one.json()["task"]["id"]) == ["created", "assigned"]


async def test_a_key_used_for_another_action_cannot_create(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    ben, _ = await field_person(client, db, 2)
    task = await make_task(client, headers, [ann.id])
    used = key()
    added = await post(
        client, headers, f"{task['id']}/assignees", {"user_ids": [ben.id]}, idem=used
    )
    assert added.status_code == 200
    payload = body([ann.id], type_id=await type_id(client, headers))
    again = await post(client, headers, "", payload, idem=used)
    assert (again.status_code, error_code(again)) == (409, "IDEMPOTENCY_KEY_REUSED")


async def test_two_people_may_use_the_same_key(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, one = await assigner(client, db)
    _, two = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    shared = key()
    payload = body([ann.id], type_id=await type_id(client, one))
    first = await post(client, one, "", payload, idem=shared)
    second = await post(client, two, "", payload, idem=shared)
    assert (first.status_code, second.status_code) == (201, 201)
    assert first.json()["task"]["id"] != second.json()["task"]["id"]


async def test_only_those_who_may_create_can(client: httpx.AsyncClient, db: AsyncSession) -> None:
    ann, field_headers = await field_person(client, db, 1)
    office = await make_user(db, OFFICE)
    office_headers = await auth_headers(client, office, kind="mobile", device_info=device(2))
    _, admin = await actor(client, db, ADMIN)
    payload = body([ann.id], type_id=await type_id(client, admin))
    for headers in (field_headers, office_headers):
        response = await post(client, headers, "", payload)
        assert (response.status_code, error_code(response)) == (403, "FORBIDDEN")
    assert (await post(client, admin, "", payload)).status_code == 201


# --- edit --------------------------------------------------------------------------------------


async def test_a_task_can_be_edited_and_the_change_is_recorded(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    task = await make_task(client, headers, [ann.id], contact_name="Rao")
    response = await post(
        client,
        headers,
        str(task["id"]),
        {"title": "New title", "priority": "urgent", "contact_name": None, "expected_minutes": 30},
        method="PATCH",
    )
    assert response.status_code == 200, response.text
    out = response.json()["task"]
    assert (out["title"], out["priority"], out["expected_minutes"]) == ("New title", "urgent", 30)
    assert out["contact_name"] is None
    assert out["events"][-1]["event"] == "updated"
    assert "title" in out["events"][-1]["note"]
    [row] = await audit_rows(db, "task.update")
    assert row.before is not None and row.before["title"] == "Install firewall"
    assert row.after is not None and row.after["title"] == "New title"


async def test_editing_with_nothing_changed_writes_nothing(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    task = await make_task(client, headers, [ann.id])
    response = await post(
        client, headers, str(task["id"]), {"title": task["title"]}, method="PATCH"
    )
    assert response.status_code == 200
    assert await events(db, task["id"]) == ["created", "assigned"]
    assert await audit_rows(db, "task.update") == []


async def test_required_fields_cannot_be_cleared_and_unknown_fields_are_refused(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    task = await make_task(client, headers, [ann.id])
    for payload in ({"title": None}, {"site": None}, {"status": "closed"}, {"type_id": None}):
        response = await post(client, headers, str(task["id"]), payload, method="PATCH")
        assert (response.status_code, error_code(response)) == (422, "VALIDATION_ERROR"), payload


async def test_the_site_moves_until_someone_has_reached_it(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    task = await make_task(client, headers, [ann.id])
    path = str(task["id"])
    new_site = {"address": "New place", "lat": 20.4, "lng": 85.9, "radius_m": 120}
    moved = await post(client, headers, path, {"site": new_site}, method="PATCH")
    assert moved.status_code == 200
    assert moved.json()["task"]["site"] == new_site
    stmt = select(TaskAssignee).where(TaskAssignee.task_id == task["id"])
    row = (await db.execute(stmt)).scalar_one()
    row.reached_at = row.assigned_at
    await db.flush()
    locked = await post(client, headers, path, {"site": SITE}, method="PATCH")
    assert (locked.status_code, error_code(locked)) == (409, "TASK_SITE_LOCKED")
    # The same site again is not a change, and other details still edit.
    same = await post(
        client, headers, path, {"site": new_site, "title": "Still ok"}, method="PATCH"
    )
    assert same.status_code == 200


async def test_a_finished_task_cannot_be_edited(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    for status in ("completed", "closed", "cancelled"):
        task = await make_task(client, headers, [ann.id])
        row = await db.get(Task, task["id"])
        assert row is not None
        row.status = status
        await db.flush()
        response = await post(client, headers, str(task["id"]), {"title": "x"}, method="PATCH")
        assert (response.status_code, error_code(response)) == (409, "INVALID_TRANSITION")
        assert response.json()["error"]["details"] == {"from": status, "action": "edit"}


async def test_editing_is_for_the_creator_or_an_admin(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await assigner(client, db)
    _, other = await assigner(client, db)
    _, admin = await actor(client, db, ADMIN)
    ann, ann_headers = await field_person(client, db, 1)
    task = await make_task(client, headers, [ann.id])
    path = str(task["id"])
    stranger = await post(client, other, path, {"title": "x"}, method="PATCH")
    assert (stranger.status_code, error_code(stranger)) == (404, "TASK_NOT_FOUND")
    as_assignee = await post(client, ann_headers, path, {"title": "x"}, method="PATCH")
    assert (as_assignee.status_code, error_code(as_assignee)) == (403, "FORBIDDEN")
    assert (
        await post(client, admin, path, {"title": "By admin"}, method="PATCH")
    ).status_code == 200


async def test_an_edit_replays_and_a_key_cannot_be_reused(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    task = await make_task(client, headers, [ann.id])
    path, used = str(task["id"]), key()
    one = await post(client, headers, path, {"title": "A"}, idem=used, method="PATCH")
    two = await post(client, headers, path, {"title": "A"}, idem=used, method="PATCH")
    assert (one.json()["replayed"], two.json()["replayed"]) == (False, True)
    assert (await events(db, task["id"])).count("updated") == 1
    other = await post(client, headers, f"{path}/cancel", {"reason": "no longer needed"}, idem=used)
    assert (other.status_code, error_code(other)) == (409, "IDEMPOTENCY_KEY_REUSED")


# --- assign and unassign -----------------------------------------------------------------------


async def test_more_people_can_be_added_while_the_task_is_open(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await assigner(client, db)
    ann, ann_headers = await field_person(client, db, 1)
    ben, _ = await field_person(client, db, 2)
    task = await make_task(client, headers, [ann.id])
    assert (await act(client, ann_headers, task["id"], "accept")).status_code == 200
    response = await post(client, headers, f"{task['id']}/assignees", {"user_ids": [ben.id]})
    assert response.status_code == 200, response.text
    out = response.json()["task"]
    assert {a["user"]["id"] for a in out["assignees"]} == {ann.id, ben.id}
    # The least advanced person sets the task status again.
    assert out["status"] == "assigned"
    assert await notifications(db, ben.id) == ["task_assigned"]
    assert len(await audit_rows(db, "task.assign")) == 1


async def test_adding_the_same_person_again_is_refused_unless_they_left(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await assigner(client, db)
    ann, ann_headers = await field_person(client, db, 1)
    task = await make_task(client, headers, [ann.id])
    twice = await post(client, headers, f"{task['id']}/assignees", {"user_ids": [ann.id]})
    assert (twice.status_code, error_code(twice)) == (409, "ALREADY_ASSIGNED")
    declined = await act(client, ann_headers, task["id"], "decline", reason="Not available")
    assert declined.json()["task"]["status"] == "declined"
    again = await post(client, headers, f"{task['id']}/assignees", {"user_ids": [ann.id]})
    assert again.status_code == 200
    out = again.json()["task"]
    assert (out["status"], status_of(out, ann.id)) == ("assigned", "assigned")
    assert out["assignees"][0]["declined_reason"] is None
    assert len(out["assignees"]) == 1


async def test_only_eligible_people_and_open_tasks_take_new_assignees(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    office = await make_user(db, OFFICE)
    task = await make_task(client, headers, [ann.id])
    path = f"{task['id']}/assignees"
    refused = await post(client, headers, path, {"user_ids": [office.id]})
    assert (refused.status_code, error_code(refused)) == (422, "NOT_FIELD_ELIGIBLE")
    row = await db.get(Task, task["id"])
    assert row is not None
    row.status = "closed"
    await db.flush()
    ben, _ = await field_person(client, db, 2)
    closed = await post(client, headers, path, {"user_ids": [ben.id]})
    assert (closed.status_code, error_code(closed)) == (409, "INVALID_TRANSITION")


async def test_a_person_is_removed_only_before_they_reach_the_site(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    ben, _ = await field_person(client, db, 2)
    task = await make_task(client, headers, [ann.id, ben.id])
    path = f"{task['id']}/assignees"
    removed = await post(client, headers, f"{path}/{ben.id}", method="DELETE")
    assert removed.status_code == 200
    out = removed.json()["task"]
    assert status_of(out, ben.id) == "cancelled"
    assert out["events"][-1]["event"] == "unassigned"
    row = (
        await db.execute(select(TaskAssignee).where(TaskAssignee.user_id == ann.id))
    ).scalar_one()
    row.status = "reached"
    await db.flush()
    refused = await post(client, headers, f"{path}/{ann.id}", method="DELETE")
    assert (refused.status_code, error_code(refused)) == (409, "INVALID_TRANSITION")
    assert refused.json()["error"]["details"] == {"from": "reached", "action": "cancel"}
    stranger = await post(client, headers, f"{path}/999999999", method="DELETE")
    assert (stranger.status_code, error_code(stranger)) == (404, "NOT_ASSIGNED")
    assert len(await audit_rows(db, "task.unassign")) == 1
    assert await notifications(db, ben.id, "task_cancelled") == ["task_cancelled"]
