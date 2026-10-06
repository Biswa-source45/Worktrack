"""Cancel, close and reopen, comments, briefs and task types (FR-TASK-09, 12, SRS 4.7)."""

import cv2
import httpx
import numpy as np
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.notifications.models import Notification
from app.modules.tasks.models import Task, TaskAttachment, TaskComment, TaskEvent, TaskType
from tests.factories import ADMIN, SUPER_ADMIN
from tests.modules.employees.helpers import API, actor, audit_rows, error_code
from tests.modules.tasks.helpers import (
    TASKS,
    act,
    assigner,
    detail,
    field_person,
    jpeg,
    key,
    make_task,
    post,
    status_of,
)
from tests.modules.tasks.test_actions import notifications, set_status
from tests.modules.tasks.test_views import reached


async def finish(db: AsyncSession, task_id: int, *user_ids: int) -> None:
    """Complete the task for these people directly (the task follows)."""
    for uid in user_ids:
        await set_status(db, task_id, uid, "completed")
    task = await db.get(Task, task_id, populate_existing=True)
    assert task is not None
    task.status = "completed"
    await db.flush()


# --- cancel ------------------------------------------------------------------------------------


async def test_cancelling_stops_every_assignee_and_tells_them(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    boss_user, boss = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    ben, _ = await field_person(client, db, 2)
    task = await make_task(client, boss, [ann.id, ben.id])
    await set_status(db, task["id"], ann.id, "accepted")
    response = await post(
        client, boss, f"{task['id']}/cancel", {"reason": "Client postponed the visit"}
    )
    assert response.status_code == 200, response.text
    out = response.json()["task"]
    assert out["status"] == "cancelled"
    assert {a["status"] for a in out["assignees"]} == {"cancelled"}
    assert out["cancel_reason"] == "Client postponed the visit"
    assert out["cancelled_by"]["id"] == boss_user.id and out["cancelled_at"]
    assert [e["event"] for e in out["events"]][-1] == "cancelled"
    assert await notifications(db, ann.id) == ["task_assigned", "task_cancelled"]
    assert await notifications(db, ben.id) == ["task_assigned", "task_cancelled"]
    assert len(await audit_rows(db, "task.cancel")) == 1


async def test_nobody_is_cancelled_after_reaching_the_site_or_finishing(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, boss = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    ben, _ = await field_person(client, db, 2)
    for status in ("reached", "in_progress", "on_hold", "completed"):
        task = await make_task(client, boss, [ann.id, ben.id])
        await set_status(db, task["id"], ann.id, status)
        response = await post(client, boss, f"{task['id']}/cancel", {"reason": "Not needed now"})
        assert (response.status_code, error_code(response)) == (409, "INVALID_TRANSITION"), status
        assert response.json()["error"]["details"] == {"from": status, "action": "cancel"}
        assert status_of(await detail(client, boss, task["id"]), ben.id) == "assigned"


async def test_a_task_everyone_declined_can_be_cancelled(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, boss = await assigner(client, db)
    ann, ann_headers = await field_person(client, db, 1)
    task = await make_task(client, boss, [ann.id])
    await act(client, ann_headers, task["id"], "decline", reason="Not available")
    response = await post(client, boss, f"{task['id']}/cancel", {"reason": "Nobody can go"})
    assert response.status_code == 200
    out = response.json()["task"]
    # The decline stays on record; only live assignees are cancelled.
    assert (out["status"], status_of(out, ann.id)) == ("cancelled", "declined")


async def test_cancel_is_final_and_replays(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, boss = await assigner(client, db)
    ann, ann_headers = await field_person(client, db, 1)
    task = await make_task(client, boss, [ann.id])
    path, used = f"{task['id']}/cancel", key()
    one = await post(client, boss, path, {"reason": "Postponed"}, idem=used)
    two = await post(client, boss, path, {"reason": "Postponed"}, idem=used)
    assert (one.json()["replayed"], two.json()["replayed"]) == (False, True)
    again = await post(client, boss, path, {"reason": "Postponed again"})
    assert (again.status_code, error_code(again)) == (409, "INVALID_TRANSITION")
    assert again.json()["error"]["details"] == {"from": "cancelled", "action": "cancel"}
    accept = await act(client, ann_headers, task["id"], "accept")
    assert accept.json()["error"]["details"] == {"from": "cancelled", "action": "accept"}
    short = await post(
        client, boss, f"{(await make_task(client, boss, [ann.id]))['id']}/cancel", {"reason": "no"}
    )
    assert short.status_code == 422
    assert len(await audit_rows(db, "task.cancel")) == 1


async def test_only_the_creator_or_an_admin_manages_a_task(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, boss = await assigner(client, db)
    _, other = await assigner(client, db)
    _, admin = await actor(client, db, ADMIN)
    ann, ann_headers = await field_person(client, db, 1)
    task = await make_task(client, boss, [ann.id])
    await finish(db, task["id"], ann.id)
    for action, payload in (
        ("cancel", {"reason": "No longer needed"}),
        ("close", {}),
        ("reopen", {"comment": "Please redo it"}),
        ("assignees", {"user_ids": [ann.id]}),
    ):
        stranger = await post(client, other, f"{task['id']}/{action}", payload)
        assert (stranger.status_code, error_code(stranger)) == (404, "TASK_NOT_FOUND"), action
        assignee = await post(client, ann_headers, f"{task['id']}/{action}", payload)
        assert (assignee.status_code, error_code(assignee)) == (403, "FORBIDDEN"), action
    assert (await post(client, admin, f"{task['id']}/close", {})).status_code == 200


# --- close and reopen --------------------------------------------------------------------------


async def test_a_completed_task_is_closed_with_the_assigners_remarks(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    boss_user, boss = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    task = await make_task(client, boss, [ann.id])
    early = await post(client, boss, f"{task['id']}/close", {})
    assert (early.status_code, error_code(early)) == (409, "INVALID_TRANSITION")
    assert early.json()["error"]["details"] == {"from": "assigned", "action": "close"}
    await finish(db, task["id"], ann.id)
    used = key()
    closed = await post(client, boss, f"{task['id']}/close", {"remarks": "Looks good"}, idem=used)
    assert closed.status_code == 200, closed.text
    out = closed.json()["task"]
    assert (out["status"], out["close_remarks"], out["closed_by"]["id"]) == (
        "closed",
        "Looks good",
        boss_user.id,
    )
    assert out["events"][-1]["event"] == "closed" and out["closed_at"]
    again = await post(client, boss, f"{task['id']}/close", {"remarks": "Looks good"}, idem=used)
    assert again.json()["replayed"] is True
    second = await post(client, boss, f"{task['id']}/close", {})
    assert (second.status_code, error_code(second)) == (409, "INVALID_TRANSITION")
    assert len(await audit_rows(db, "task.close")) == 1


async def test_a_task_waiting_for_a_reached_review_cannot_be_closed(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, boss = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    task = await make_task(client, boss, [ann.id])
    await reached(db, task["id"], ann.id, status="completed", reach_review="pending")
    row = await db.get(Task, task["id"], populate_existing=True)
    assert row is not None
    row.status = "completed"
    await db.flush()
    response = await post(client, boss, f"{task['id']}/close", {})
    assert (response.status_code, error_code(response)) == (409, "REACH_REVIEW_PENDING")


async def test_closing_after_a_rejected_reached_needs_a_comment(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, boss = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    task = await make_task(client, boss, [ann.id])
    await reached(db, task["id"], ann.id, status="completed", reach_review="rejected")
    row = await db.get(Task, task["id"], populate_existing=True)
    assert row is not None
    row.status = "completed"
    await db.flush()
    refused = await post(client, boss, f"{task['id']}/close", {})
    assert (refused.status_code, error_code(refused)) == (422, "CLOSE_COMMENT_REQUIRED")
    ok = await post(client, boss, f"{task['id']}/close", {"remarks": "Work was fine anyway"})
    assert ok.status_code == 200


async def test_reopening_sends_the_chosen_people_back_to_work(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, boss = await assigner(client, db)
    ann, ann_headers = await field_person(client, db, 1)
    ben, _ = await field_person(client, db, 2)
    task = await make_task(client, boss, [ann.id, ben.id])
    await finish(db, task["id"], ann.id, ben.id)
    missing_comment = await post(client, boss, f"{task['id']}/reopen", {})
    assert missing_comment.status_code == 422
    stranger = await post(
        client, boss, f"{task['id']}/reopen", {"comment": "Fix it", "user_ids": [999_999_999]}
    )
    assert (stranger.status_code, error_code(stranger)) == (404, "NOT_ASSIGNED")
    response = await post(
        client, boss, f"{task['id']}/reopen", {"comment": "Cable is loose", "user_ids": [ann.id]}
    )
    assert response.status_code == 200, response.text
    out = response.json()["task"]
    assert (status_of(out, ann.id), status_of(out, ben.id)) == ("in_progress", "completed")
    assert out["status"] == "in_progress"
    assert out["assignees"][0]["completed_at"] is None
    reopened = [e for e in out["events"] if e["event"] == "reopened"]
    assert [(e["subject"]["id"], e["note"]) for e in reopened] == [(ann.id, "Cable is loose")]
    assert (await notifications(db, ann.id))[-1] == "task_reopened"
    assert (await notifications(db, ben.id))[-1] == "task_assigned"
    # The person can complete it again.
    done = await act(
        client,
        ann_headers,
        task["id"],
        "complete",
        remarks="Fixed",
        files=[("photos", ("p.jpg", jpeg(), "image/jpeg"))],
    )
    assert (done.status_code, done.json()["task"]["status"]) == (200, "completed")


async def test_reopen_defaults_to_everyone_who_completed_and_only_a_completed_task(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, boss = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    ben, _ = await field_person(client, db, 2)
    task = await make_task(client, boss, [ann.id, ben.id])
    not_yet = await post(client, boss, f"{task['id']}/reopen", {"comment": "Again please"})
    assert (not_yet.status_code, error_code(not_yet)) == (409, "INVALID_TRANSITION")
    await finish(db, task["id"], ann.id, ben.id)
    used = key()
    both = await post(client, boss, f"{task['id']}/reopen", {"comment": "Again please"}, idem=used)
    assert {a["status"] for a in both.json()["task"]["assignees"]} == {"in_progress"}
    replay = await post(
        client, boss, f"{task['id']}/reopen", {"comment": "Again please"}, idem=used
    )
    assert replay.json()["replayed"] is True
    row = await db.get(Task, task["id"], populate_existing=True)
    assert row is not None
    row.status = "closed"
    await db.flush()
    closed = await post(client, boss, f"{task['id']}/reopen", {"comment": "Too late"})
    assert (closed.status_code, error_code(closed)) == (409, "INVALID_TRANSITION")
    assert len(await audit_rows(db, "task.reopen")) == 1


async def test_reopening_someone_who_has_not_completed_is_refused(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, boss = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    ben, _ = await field_person(client, db, 2)
    task = await make_task(client, boss, [ann.id, ben.id])
    await set_status(db, task["id"], ann.id, "completed")
    await set_status(db, task["id"], ben.id, "completed")
    row = await db.get(Task, task["id"], populate_existing=True)
    assert row is not None
    row.status = "completed"
    await db.flush()
    await set_status(db, task["id"], ben.id, "on_hold")
    response = await post(
        client, boss, f"{task['id']}/reopen", {"comment": "Check it", "user_ids": [ben.id]}
    )
    assert (response.status_code, error_code(response)) == (409, "INVALID_TRANSITION")
    assert response.json()["error"]["details"] == {"from": "on_hold", "action": "reopen"}


# --- comments ----------------------------------------------------------------------------------


async def test_the_assigner_and_the_assignee_talk_on_the_task(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    boss_user, boss = await assigner(client, db)
    ann, ann_headers = await field_person(client, db, 1)
    task = await make_task(client, boss, [ann.id])
    path = f"{TASKS}/{task['id']}/comments"
    one = await client.post(
        path, data={"body": "Bring the rack screws"}, headers={**boss, "Idempotency-Key": key()}
    )
    assert one.status_code == 201, one.text
    two = await client.post(
        path,
        data={"body": "On my way"},
        files={"photo": ("c.jpg", jpeg(), "image/jpeg")},
        headers={**ann_headers, "Idempotency-Key": key()},
    )
    assert two.status_code == 201, two.text
    out = two.json()["task"]
    assert [(c["author"]["id"], c["body"]) for c in out["comments"]] == [
        (boss_user.id, "Bring the rack screws"),
        (ann.id, "On my way"),
    ]
    picture = out["comments"][1]["attachment"]
    assert picture["kind"] == "comment" and picture["content_type"] == "image/jpeg"
    assert out["attachments"] == []  # the picture is in the thread, not listed twice
    assert (await client.get(picture["url"])).status_code == 200
    only_photo = await client.post(
        path,
        files={"photo": ("c.jpg", jpeg(), "image/jpeg")},
        headers={**ann_headers, "Idempotency-Key": key()},
    )
    assert only_photo.status_code == 201 and only_photo.json()["task"]["comments"][-1]["body"] == ""
    assert len(await audit_rows(db, "task.comment")) == 3


async def test_a_comment_needs_words_or_a_photo_and_a_real_photo(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, boss = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    task = await make_task(client, boss, [ann.id])
    path = f"{TASKS}/{task['id']}/comments"
    empty = await client.post(path, data={"body": "  "}, headers={**boss, "Idempotency-Key": key()})
    assert (empty.status_code, error_code(empty)) == (422, "EMPTY_COMMENT")
    long = await client.post(
        path, data={"body": "x" * 1001}, headers={**boss, "Idempotency-Key": key()}
    )
    assert long.status_code == 422
    fake = await client.post(
        path,
        data={"body": "look"},
        files={"photo": ("c.jpg", b"not a picture", "image/jpeg")},
        headers={**boss, "Idempotency-Key": key()},
    )
    assert (fake.status_code, error_code(fake)) == (422, "PHOTO_UNREADABLE")
    assert (await db.execute(select(TaskComment))).first() is None
    assert (await db.execute(select(TaskAttachment))).first() is None


async def test_only_those_on_the_task_may_comment(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    manager, manager_headers = await assigner(client, db)
    _, boss = await assigner(client, db)
    _, admin = await actor(client, db, ADMIN)
    ann, _ = await field_person(client, db, 1, manager_id=manager.id)
    _, stranger = await field_person(client, db, 2)
    task = await make_task(client, boss, [ann.id])
    path = f"{TASKS}/{task['id']}/comments"
    data = {"body": "hello"}
    gone = await client.post(path, data=data, headers={**stranger, "Idempotency-Key": key()})
    assert (gone.status_code, error_code(gone)) == (404, "TASK_NOT_FOUND")
    # A manager who can see the task through their team does not take part in it.
    watching = await client.post(
        path, data=data, headers={**manager_headers, "Idempotency-Key": key()}
    )
    assert (watching.status_code, error_code(watching)) == (403, "FORBIDDEN")
    allowed = await client.post(path, data=data, headers={**admin, "Idempotency-Key": key()})
    assert allowed.status_code == 201


async def test_a_comment_replays_and_its_key_cannot_move_to_another_task(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, boss = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    one = await make_task(client, boss, [ann.id])
    two = await make_task(client, boss, [ann.id])
    used = key()
    first = await client.post(
        f"{TASKS}/{one['id']}/comments",
        data={"body": "hi"},
        headers={**boss, "Idempotency-Key": used},
    )
    again = await client.post(
        f"{TASKS}/{one['id']}/comments",
        data={"body": "hi"},
        headers={**boss, "Idempotency-Key": used},
    )
    assert (first.json()["replayed"], again.json()["replayed"]) == (False, True)
    assert len(again.json()["task"]["comments"]) == 1
    other = await client.post(
        f"{TASKS}/{two['id']}/comments",
        data={"body": "hi"},
        headers={**boss, "Idempotency-Key": used},
    )
    assert (other.status_code, error_code(other)) == (409, "IDEMPOTENCY_KEY_REUSED")


# --- briefs ------------------------------------------------------------------------------------


async def upload(
    client: httpx.AsyncClient,
    headers: dict[str, str],
    task_id: int,
    name: str,
    data: bytes,
    idem: str | None = None,
) -> httpx.Response:
    return await client.post(
        f"{TASKS}/{task_id}/attachments",
        files={"file": (name, data, "application/octet-stream")},
        headers={**headers, "Idempotency-Key": idem or key()},
    )


async def test_a_brief_is_a_pdf_kept_as_is_or_a_photo_re_encoded(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, boss = await assigner(client, db)
    ann, ann_headers = await field_person(client, db, 1)
    task = await make_task(client, boss, [ann.id])
    pdf = await upload(client, boss, task["id"], "scope.pdf", b"%PDF-1.7\n1 0 obj\n")
    assert pdf.status_code == 201, pdf.text
    wide = np.zeros((1000, 3000, 3), np.uint8)
    cv2.circle(wide, (1500, 500), 400, (0, 255, 0), -1)
    photo = await upload(
        client, boss, task["id"], "site.png", cv2.imencode(".png", wide)[1].tobytes()
    )
    assert photo.status_code == 201, photo.text
    briefs = (await detail(client, ann_headers, task["id"]))["attachments"]
    assert [(b["kind"], b["content_type"], b["filename"]) for b in briefs] == [
        ("brief", "application/pdf", "scope.pdf"),
        ("brief", "image/jpeg", "site.png"),
    ]
    stored = cv2.imdecode(
        np.frombuffer((await client.get(briefs[1]["url"])).content, np.uint8), cv2.IMREAD_COLOR
    )
    assert stored.shape[1] == 1600
    assert len(await audit_rows(db, "task.attachment")) == 2


async def test_a_brief_that_is_neither_a_pdf_nor_a_picture_is_refused(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, boss = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    task = await make_task(client, boss, [ann.id])
    for name, data in (
        ("fake.pdf", b"MZ this is a program"),
        ("notes.txt", b"hello"),
        ("empty.pdf", b""),
    ):
        response = await upload(client, boss, task["id"], name, data)
        assert (response.status_code, error_code(response)) == (422, "PHOTO_UNREADABLE"), name
    big = await upload(client, boss, task["id"], "big.pdf", b"%PDF-" + b"0" * (10 * 1024 * 1024))
    assert (big.status_code, error_code(big)) == (413, "PHOTO_TOO_LARGE")
    assert (await db.execute(select(TaskAttachment))).first() is None


async def test_a_task_takes_ten_briefs_while_open_and_only_from_its_manager(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, boss = await assigner(client, db)
    _, other = await assigner(client, db)
    ann, ann_headers = await field_person(client, db, 1)
    task = await make_task(client, boss, [ann.id])
    for n in range(10):
        assert (await upload(client, boss, task["id"], f"{n}.pdf", b"%PDF-1")).status_code == 201
    eleventh = await upload(client, boss, task["id"], "11.pdf", b"%PDF-1")
    assert (eleventh.status_code, error_code(eleventh)) == (422, "TOO_MANY_ATTACHMENTS")
    as_assignee = await upload(client, ann_headers, task["id"], "x.pdf", b"%PDF-1")
    assert (as_assignee.status_code, error_code(as_assignee)) == (403, "FORBIDDEN")
    stranger = await upload(client, other, task["id"], "x.pdf", b"%PDF-1")
    assert (stranger.status_code, error_code(stranger)) == (404, "TASK_NOT_FOUND")
    row = await db.get(Task, task["id"], populate_existing=True)
    assert row is not None
    row.status = "cancelled"
    await db.flush()
    closed = await upload(client, boss, task["id"], "late.pdf", b"%PDF-1")
    assert (closed.status_code, error_code(closed)) == (409, "INVALID_TRANSITION")


async def test_a_brief_replays(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, boss = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    one = await make_task(client, boss, [ann.id])
    two = await make_task(client, boss, [ann.id])
    used = key()
    first = await upload(client, boss, one["id"], "a.pdf", b"%PDF-1", used)
    again = await upload(client, boss, one["id"], "a.pdf", b"%PDF-1", used)
    assert (first.json()["replayed"], again.json()["replayed"]) == (False, True)
    assert len(again.json()["task"]["attachments"]) == 1
    other = await upload(client, boss, two["id"], "a.pdf", b"%PDF-1", used)
    assert (other.status_code, error_code(other)) == (409, "IDEMPOTENCY_KEY_REUSED")


# --- task types --------------------------------------------------------------------------------

TYPES = f"{API}/admin/task-types"


async def test_any_signed_in_person_lists_the_active_types(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, field = await field_person(client, db, 1)
    _, super_admin = await actor(client, db, SUPER_ADMIN)
    types = (await client.get(f"{API}/task-types", headers=field)).json()
    assert [t["name"] for t in types] == [
        "Firewall Installation",
        "Support/Issue Fix",
        "Maintenance",
        "EMD/Cheque Submission",
        "Document Submission",
        "Client Meeting",
        "Other",
    ]
    assert {t["name"]: t["proof_kind"] for t in types if t["proof_kind"] == "receipt"} == {
        "EMD/Cheque Submission": "receipt",
        "Document Submission": "receipt",
    }
    off = await client.patch(
        f"{TYPES}/{types[0]['id']}", json={"is_active": False}, headers=super_admin
    )
    assert off.status_code == 200
    assert "Firewall Installation" not in [
        t["name"] for t in (await client.get(f"{API}/task-types", headers=field)).json()
    ]
    everything = await client.get(TYPES, headers=super_admin)
    assert len(everything.json()) == 7


async def test_task_types_are_managed_with_the_settings_permission(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, super_admin = await actor(client, db, SUPER_ADMIN)
    _, admin = await actor(client, db, ADMIN)
    _, boss = await assigner(client, db)
    body = {"name": "Site Survey", "proof_photo_required": False, "proof_kind": "photo"}
    for headers in (admin, boss):
        denied = await client.post(TYPES, json=body, headers=headers)
        assert (denied.status_code, error_code(denied)) == (403, "FORBIDDEN")
    assert (await client.get(TYPES, headers=admin)).status_code == 200  # settings.view
    assert (await client.get(TYPES, headers=boss)).status_code == 403
    created = await client.post(TYPES, json=body, headers=super_admin)
    assert created.status_code == 201, created.text
    new = created.json()
    assert (new["name"], new["proof_photo_required"], new["is_active"]) == (
        "Site Survey",
        False,
        True,
    )
    twice = await client.post(TYPES, json=body | {"name": "site survey"}, headers=super_admin)
    assert (twice.status_code, error_code(twice)) == (409, "DUPLICATE")
    renamed = await client.patch(
        f"{TYPES}/{new['id']}",
        json={"name": "Survey", "proof_kind": "receipt", "proof_photo_required": True},
        headers=super_admin,
    )
    assert renamed.status_code == 200
    assert (renamed.json()["name"], renamed.json()["proof_kind"]) == ("Survey", "receipt")
    clash = await client.patch(
        f"{TYPES}/{new['id']}", json={"name": "MAINTENANCE"}, headers=super_admin
    )
    assert (clash.status_code, error_code(clash)) == (409, "DUPLICATE")
    same = await client.patch(f"{TYPES}/{new['id']}", json={"name": "survey"}, headers=super_admin)
    assert same.status_code == 200  # its own name, in another case, is not a clash
    for bad in ({"name": ""}, {"name": None}, {"proof_kind": "selfie"}, {"colour": "red"}):
        refused = await client.patch(f"{TYPES}/{new['id']}", json=bad, headers=super_admin)
        assert (refused.status_code, error_code(refused)) == (422, "VALIDATION_ERROR"), bad
    missing = await client.patch(f"{TYPES}/999999", json={"name": "x"}, headers=super_admin)
    assert (missing.status_code, error_code(missing)) == (404, "NOT_FOUND")
    assert len(await audit_rows(db, "task_type.create")) == 1
    assert len(await audit_rows(db, "task_type.update")) == 2


async def test_a_changed_proof_rule_applies_to_the_next_completion(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, boss = await assigner(client, db)
    ann, ann_headers = await field_person(client, db, 1)
    kind = (await db.execute(select(TaskType).where(TaskType.name == "Other"))).scalar_one()
    task = await make_task(client, boss, [ann.id], type_id=kind.id)
    await set_status(db, task["id"], ann.id, "in_progress")
    refused = await act(client, ann_headers, task["id"], "complete", remarks="Done")
    assert error_code(refused) == "PROOF_PHOTO_REQUIRED"
    kind.proof_photo_required = False
    await db.flush()
    done = await act(client, ann_headers, task["id"], "complete", remarks="Done")
    assert done.status_code == 200


async def test_events_of_one_request_share_its_key_only_on_the_first(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, boss = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    ben, _ = await field_person(client, db, 2)
    cat, _ = await field_person(client, db, 3)
    task = await make_task(client, boss, [ann.id])
    used = key()
    response = await post(
        client, boss, f"{task['id']}/assignees", {"user_ids": [ben.id, cat.id]}, idem=used
    )
    assert response.status_code == 200
    rows = list(
        (
            await db.execute(
                select(TaskEvent).where(
                    TaskEvent.task_id == task["id"], TaskEvent.event == "assigned"
                )
            )
        ).scalars()
    )
    assert sum(1 for e in rows if e.request_id is not None) == 1  # only the first of the two events
    again = await post(
        client, boss, f"{task['id']}/assignees", {"user_ids": [ben.id, cat.id]}, idem=used
    )
    assert again.json()["replayed"] is True
    assert len(again.json()["task"]["assignees"]) == 3
    assert (
        len(
            (await db.execute(select(Notification).where(Notification.user_id == ben.id)))
            .scalars()
            .all()
        )
        == 1
    )
