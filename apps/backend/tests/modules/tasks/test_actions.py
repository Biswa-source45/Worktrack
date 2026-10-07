"""What an assignee does with a task: accept, decline, start, hold, resume, notes, complete
(FR-TASK-03, 07, 08) and the lifecycle through the real endpoints (invariant 9)."""

import datetime as dt
import itertools
from typing import Any

import cv2
import httpx
import numpy as np
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.notifications.models import Notification
from app.modules.tasks.lifecycle import ASSIGNEE_STATUSES
from app.modules.tasks.models import TaskAssignee, TaskAttachment, TaskEvent, TaskType
from tests.factories import ADMIN, auth_headers, device
from tests.modules.attendance.conftest import Clock
from tests.modules.employees.helpers import actor, audit_rows, error_code
from tests.modules.tasks.helpers import (
    act,
    assigner,
    detail,
    field_person,
    jpeg,
    key,
    make_task,
    post,
    status_of,
    type_id,
)

ALLOWED = {
    ("assigned", "accept"),
    ("assigned", "decline"),
    ("reached", "start"),
    ("in_progress", "hold"),
    ("on_hold", "resume"),
    ("in_progress", "complete"),
}


async def set_status(
    db: AsyncSession,
    task_id: int,
    user_id: int,
    status: str,
    reached_at: dt.datetime | None = None,
) -> None:
    """Put an assignee in a state directly (Reached has its own endpoint, tested separately)."""
    row = (
        await db.execute(
            select(TaskAssignee)
            .where(TaskAssignee.task_id == task_id, TaskAssignee.user_id == user_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    row.status = status
    if status == "reached":
        row.reached_at = reached_at or dt.datetime.now(dt.UTC)
    await db.flush()


async def events(db: AsyncSession, task_id: int) -> list[TaskEvent]:
    rows = await db.execute(
        select(TaskEvent)
        .where(TaskEvent.task_id == task_id)
        .order_by(TaskEvent.id)
        .execution_options(populate_existing=True)
    )
    return list(rows.scalars())


async def notifications(db: AsyncSession, user_id: int) -> list[str]:
    rows = await db.execute(
        select(Notification.type).where(Notification.user_id == user_id).order_by(Notification.id)
    )
    return list(rows.scalars())


# --- the happy path ----------------------------------------------------------------------------


async def test_an_assignee_works_a_task_from_accept_to_complete(
    client: httpx.AsyncClient, db: AsyncSession, clock: Clock
) -> None:
    boss, boss_headers = await assigner(client, db)
    ann, headers = await field_person(client, db, 1)
    task = await make_task(client, boss_headers, [ann.id])
    tid = task["id"]

    clock.at(10, 6)
    accepted = (await act(client, headers, tid, "accept")).json()["task"]
    assert (accepted["status"], status_of(accepted, ann.id)) == ("accepted", "accepted")
    assert accepted["assignees"][0]["accepted_at"].startswith("2027-03-01T04:36")

    clock.at(10, 20)
    await set_status(db, tid, ann.id, "reached", reached_at=clock.now)
    clock.at(10, 30)
    started = (await act(client, headers, tid, "start")).json()["task"]
    assert started["status"] == "in_progress"
    clock.at(11, 0)
    held = (await act(client, headers, tid, "hold", reason="Waiting for the client")).json()["task"]
    assert held["status"] == "on_hold"
    clock.at(11, 20)
    assert (await act(client, headers, tid, "resume")).json()["task"]["status"] == "in_progress"
    clock.at(12, 0)
    done = await act(
        client,
        headers,
        tid,
        "complete",
        remarks="All racked and tested",
        files=[("photos", ("p.jpg", jpeg(), "image/jpeg"))],
    )
    assert done.status_code == 200, done.text
    out = done.json()["task"]
    assert (out["status"], status_of(out, ann.id)) == ("completed", "completed")
    mine = out["assignees"][0]
    assert mine["completion_remarks"] == "All racked and tested"
    # Reached 10:20, completed 12:00, minus 20 minutes on hold; accepted 10:06.
    metrics = mine["metrics"]
    assert metrics["time_on_site_min"] == 80
    assert metrics["accept_to_reached_min"] == 14
    names = [e["event"] for e in out["events"]]
    assert names == ["created", "assigned", "accepted", "started", "held", "resumed", "completed"]
    assert [e["note"] for e in out["events"] if e["event"] == "held"] == ["Waiting for the client"]
    assert await notifications(db, boss.id) == ["task_accepted", "task_completed"]
    for action in ("accept", "start", "hold", "resume", "complete"):
        assert len(await audit_rows(db, f"task.{action}")) == 1


async def test_events_are_stamped_with_the_server_clock_not_the_phones(
    client: httpx.AsyncClient, db: AsyncSession, clock: Clock
) -> None:
    _, boss_headers = await assigner(client, db)
    ann, headers = await field_person(client, db, 1)
    task = await make_task(client, boss_headers, [ann.id])
    clock.at(10, 6)
    response = await act(
        client, headers, task["id"], "accept", device_time="2020-01-01T00:00:00+00:00"
    )
    assert response.status_code == 200
    accept = (await events(db, task["id"]))[-1]
    assert accept.at == clock.now
    assert accept.device_time == dt.datetime(2020, 1, 1, tzinfo=dt.UTC)


async def test_a_position_is_stored_with_the_event_and_shown_only_to_managers(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, boss_headers = await assigner(client, db)
    ann, headers = await field_person(client, db, 1)
    task = await make_task(client, boss_headers, [ann.id])
    sent = await act(client, headers, task["id"], "accept", lat=20.31, lng=85.84, accuracy_m=12)
    assert sent.status_code == 200
    mine = await detail(client, headers, task["id"])
    assert all(e["lat"] is None and e["lng"] is None for e in mine["events"])
    theirs = await detail(client, boss_headers, task["id"])
    accepted = next(e for e in theirs["events"] if e["event"] == "accepted")
    assert (round(accepted["lat"], 4), round(accepted["lng"], 4)) == (20.31, 85.84)
    # About 1.5 km from the site: shown as a straight line.
    assert 1000 < theirs["assignees"][0]["metrics"]["straight_line_m"] < 2500


async def test_a_partial_position_is_refused(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, boss_headers = await assigner(client, db)
    ann, headers = await field_person(client, db, 1)
    task = await make_task(client, boss_headers, [ann.id])
    for partial in ({"lat": 20.3}, {"lat": 20.3, "lng": 85.8}, {"accuracy_m": 5}):
        response = await act(client, headers, task["id"], "accept", **partial)
        assert (response.status_code, error_code(response)) == (422, "VALIDATION_ERROR")
    assert (
        await act(client, headers, task["id"], "accept", lat=95, lng=85, accuracy_m=5)
    ).status_code == 422


# --- decline, hold ----------------------------------------------------------------------------


async def test_declining_needs_a_reason_and_tells_the_assigner(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    boss, boss_headers = await assigner(client, db)
    ann, headers = await field_person(client, db, 1)
    task = await make_task(client, boss_headers, [ann.id])
    for reason in ("", "no", "x" * 201):
        refused = await act(client, headers, task["id"], "decline", reason=reason)
        assert (refused.status_code, error_code(refused)) == (422, "VALIDATION_ERROR")
    no_reason = await act(client, headers, task["id"], "decline")
    assert no_reason.status_code == 422
    done = await act(client, headers, task["id"], "decline", reason="On leave that day")
    out = done.json()["task"]
    assert (out["status"], out["assignees"][0]["declined_reason"]) == (
        "declined",
        "On leave that day",
    )
    assert await notifications(db, boss.id) == ["task_declined"]
    [note] = (
        await db.execute(select(Notification).where(Notification.user_id == boss.id))
    ).scalars()
    assert "On leave that day" in note.body


async def test_holding_needs_a_reason(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, boss_headers = await assigner(client, db)
    ann, headers = await field_person(client, db, 1)
    task = await make_task(client, boss_headers, [ann.id])
    await set_status(db, task["id"], ann.id, "in_progress")
    assert (await act(client, headers, task["id"], "hold")).status_code == 422
    assert (await act(client, headers, task["id"], "hold", reason="ab")).status_code == 422
    assert (await act(client, headers, task["id"], "hold", reason="Lunch break")).status_code == 200


# --- the lifecycle through the endpoints -------------------------------------------------------

ENDPOINTS = ("accept", "decline", "start", "hold", "resume", "complete")
INVALID = [
    (status, action)
    for status, action in itertools.product(ASSIGNEE_STATUSES, ENDPOINTS)
    if (status, action) not in ALLOWED
]


@pytest.mark.parametrize(("status", "action"), INVALID)
async def test_every_other_status_action_pair_is_a_409(
    client: httpx.AsyncClient, db: AsyncSession, status: str, action: str
) -> None:
    _, boss_headers = await assigner(client, db)
    ann, headers = await field_person(client, db, 1)
    task = await make_task(client, boss_headers, [ann.id])
    await set_status(db, task["id"], ann.id, status)
    before = len(await events(db, task["id"]))
    extra: dict[str, Any] = {"reason": "A good reason", "remarks": "Done"}
    response = await act(client, headers, task["id"], action, **extra)
    assert (response.status_code, error_code(response)) == (409, "INVALID_TRANSITION")
    assert response.json()["error"]["details"] == {"from": status, "action": action}
    assert len(await events(db, task["id"])) == before


@pytest.mark.parametrize("status", ["assigned", "accepted", "completed", "declined", "cancelled"])
async def test_notes_wait_until_the_person_is_on_site(
    client: httpx.AsyncClient, db: AsyncSession, status: str
) -> None:
    _, boss_headers = await assigner(client, db)
    ann, headers = await field_person(client, db, 1)
    task = await make_task(client, boss_headers, [ann.id])
    await set_status(db, task["id"], ann.id, status)
    response = await act(client, headers, task["id"], "notes", note="Rack is in")
    assert (response.status_code, error_code(response)) == (409, "INVALID_TRANSITION")
    assert response.json()["error"]["details"] == {"from": status, "action": "note"}


async def test_the_task_follows_its_assignees(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, boss_headers = await assigner(client, db)
    ann, ann_headers = await field_person(client, db, 1)
    ben, ben_headers = await field_person(client, db, 2)
    task = await make_task(client, boss_headers, [ann.id, ben.id])
    tid = task["id"]
    one = (await act(client, ann_headers, tid, "accept")).json()["task"]
    assert one["status"] == "assigned"  # Ben has not answered
    two = (await act(client, ben_headers, tid, "decline", reason="Not free")).json()["task"]
    assert two["status"] == "accepted"  # the one active person has accepted
    assert (await detail(client, boss_headers, tid))["status"] == "accepted"


# --- who may act, and from where ---------------------------------------------------------------


async def test_only_the_assignee_acts_on_their_own_task(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    boss, boss_headers = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    _, ben_headers = await field_person(client, db, 2)
    task = await make_task(client, boss_headers, [ann.id])
    other = await act(client, ben_headers, task["id"], "accept")
    assert (other.status_code, error_code(other)) == (404, "TASK_NOT_FOUND")
    missing = await act(client, ben_headers, 999_999_999, "accept")
    assert (missing.status_code, error_code(missing)) == (404, "TASK_NOT_FOUND")
    # The assigner on a phone is not an assignee either.
    boss_phone = await auth_headers(client, boss, kind="mobile", device_info=device(5))
    as_boss = await act(client, boss_phone, task["id"], "accept")
    assert (as_boss.status_code, error_code(as_boss)) == (404, "TASK_NOT_FOUND")
    assert (await detail(client, boss_headers, task["id"]))["status"] == "assigned"


async def test_an_action_needs_the_approved_phone(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, boss_headers = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    task = await make_task(client, boss_headers, [ann.id])
    _, on_the_web = await actor(client, db, ADMIN)
    response = await act(client, on_the_web, task["id"], "accept")
    assert (response.status_code, error_code(response)) == (403, "DEVICE_NOT_APPROVED")
    second_phone = await auth_headers(client, ann, kind="mobile", device_info=device(9))
    pending = await act(client, second_phone, task["id"], "accept")
    assert (pending.status_code, error_code(pending)) == (403, "DEVICE_NOT_APPROVED")


async def test_a_removed_person_can_no_longer_act(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, boss_headers = await assigner(client, db)
    ann, headers = await field_person(client, db, 1)
    ben, _ = await field_person(client, db, 2)
    task = await make_task(client, boss_headers, [ann.id, ben.id])
    await post(client, boss_headers, f"{task['id']}/assignees/{ann.id}", method="DELETE")
    response = await act(client, headers, task["id"], "accept")
    assert (response.status_code, error_code(response)) == (409, "INVALID_TRANSITION")


# --- idempotency -------------------------------------------------------------------------------


async def test_the_same_key_twice_changes_nothing_the_second_time(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    boss, boss_headers = await assigner(client, db)
    ann, headers = await field_person(client, db, 1)
    task = await make_task(client, boss_headers, [ann.id])
    used = key()
    one = await act(client, headers, task["id"], "accept", idem=used)
    two = await act(client, headers, task["id"], "accept", idem=used)
    assert (one.status_code, two.status_code) == (200, 200)
    assert (one.json()["replayed"], two.json()["replayed"]) == (False, True)
    assert two.json()["task"]["status"] == "accepted"
    assert [e.event for e in await events(db, task["id"])].count("accepted") == 1
    assert await notifications(db, boss.id) == ["task_accepted"]
    assert len(await audit_rows(db, "task.accept")) == 1


async def test_a_replay_still_answers_after_later_steps(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, boss_headers = await assigner(client, db)
    ann, headers = await field_person(client, db, 1)
    task = await make_task(client, boss_headers, [ann.id])
    used = key()
    await act(client, headers, task["id"], "accept", idem=used)
    await set_status(db, task["id"], ann.id, "in_progress")
    again = await act(client, headers, task["id"], "accept", idem=used)
    assert (again.status_code, again.json()["replayed"]) == (200, True)


async def test_a_key_used_for_another_action_or_task_is_refused(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, boss_headers = await assigner(client, db)
    ann, headers = await field_person(client, db, 1)
    one = await make_task(client, boss_headers, [ann.id])
    two = await make_task(client, boss_headers, [ann.id])
    used = key()
    assert (await act(client, headers, one["id"], "accept", idem=used)).status_code == 200
    other_action = await act(
        client, headers, one["id"], "decline", idem=used, reason="Changed my mind"
    )
    assert (other_action.status_code, error_code(other_action)) == (409, "IDEMPOTENCY_KEY_REUSED")
    other_task = await act(client, headers, two["id"], "accept", idem=used)
    assert (other_task.status_code, error_code(other_task)) == (409, "IDEMPOTENCY_KEY_REUSED")
    assert status_of(await detail(client, headers, two["id"]), ann.id) == "assigned"


async def test_an_action_needs_an_idempotency_key(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, boss_headers = await assigner(client, db)
    ann, headers = await field_person(client, db, 1)
    task = await make_task(client, boss_headers, [ann.id])
    response = await client.post(f"/api/v1/tasks/{task['id']}/accept", headers=headers)
    assert (response.status_code, error_code(response)) == (422, "VALIDATION_ERROR")
    bad = await client.post(
        f"/api/v1/tasks/{task['id']}/accept", headers={**headers, "Idempotency-Key": "nope"}
    )
    assert bad.status_code == 422


# --- offline replays ---------------------------------------------------------------------------


async def test_an_offline_action_is_counted_at_receipt_time_and_flagged(
    client: httpx.AsyncClient, db: AsyncSession, clock: Clock
) -> None:
    _, boss_headers = await assigner(client, db)
    ann, headers = await field_person(client, db, 1)
    task = await make_task(client, boss_headers, [ann.id])
    taken = clock.now - dt.timedelta(hours=3)
    response = await act(
        client, headers, task["id"], "accept", offline=True, device_time=taken.isoformat()
    )
    assert response.status_code == 200, response.text
    accept = (await events(db, task["id"]))[-1]
    assert (accept.offline, accept.at, accept.device_time) == (True, clock.now, taken)
    shown = next(e for e in response.json()["task"]["events"] if e["event"] == "accepted")
    assert shown["offline"] is True


async def test_an_offline_action_must_say_when_and_not_be_too_old(
    client: httpx.AsyncClient, db: AsyncSession, clock: Clock
) -> None:
    _, boss_headers = await assigner(client, db)
    ann, headers = await field_person(client, db, 1)
    task = await make_task(client, boss_headers, [ann.id])
    no_time = await act(client, headers, task["id"], "accept", offline=True)
    assert (no_time.status_code, error_code(no_time)) == (422, "OFFLINE_TIME_MISSING")
    old = clock.now - dt.timedelta(hours=13)
    too_old = await act(
        client, headers, task["id"], "accept", offline=True, device_time=old.isoformat()
    )
    assert (too_old.status_code, error_code(too_old)) == (409, "OFFLINE_PUNCH_TOO_OLD")
    assert status_of(await detail(client, headers, task["id"]), ann.id) == "assigned"


# --- notes -------------------------------------------------------------------------------------


async def test_notes_and_photos_are_added_while_working(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, boss_headers = await assigner(client, db)
    ann, headers = await field_person(client, db, 1)
    task = await make_task(client, boss_headers, [ann.id])
    await set_status(db, task["id"], ann.id, "in_progress")
    text = await act(client, headers, task["id"], "notes", note="Rack mounted")
    assert text.status_code == 200, text.text
    photo = await act(
        client, headers, task["id"], "notes", files={"photo": ("n.jpg", jpeg(), "image/jpeg")}
    )
    assert photo.status_code == 200
    out = photo.json()["task"]
    assert [e["note"] for e in out["events"] if e["event"] == "note"] == ["Rack mounted", None]
    [work] = out["attachments"]
    assert (work["kind"], work["content_type"]) == ("work_photo", "image/jpeg")
    assert out["status"] == "in_progress"  # notes change no status
    empty = await act(client, headers, task["id"], "notes", note="  ")
    assert (empty.status_code, error_code(empty)) == (422, "EMPTY_NOTE")


# --- complete and proof ------------------------------------------------------------------------


async def make_working(
    client: httpx.AsyncClient, db: AsyncSession, type_name: str = "Other"
) -> tuple[int, dict[str, str], int]:
    _, boss_headers = await assigner(client, db)
    ann, headers = await field_person(client, db, 1)
    task = await make_task(
        client, boss_headers, [ann.id], type_id=await type_id(client, boss_headers, type_name)
    )
    await set_status(db, task["id"], ann.id, "in_progress")
    return task["id"], headers, ann.id


async def test_completing_needs_remarks_and_the_proof_photo_of_the_type(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    tid, headers, me = await make_working(client, db)
    no_remarks = await act(
        client, headers, tid, "complete", files=[("photos", ("p.jpg", jpeg(), "image/jpeg"))]
    )
    assert (no_remarks.status_code, error_code(no_remarks)) == (422, "VALIDATION_ERROR")
    no_photo = await act(client, headers, tid, "complete", remarks="Done")
    assert (no_photo.status_code, error_code(no_photo)) == (422, "PROOF_PHOTO_REQUIRED")
    assert no_photo.json()["error"]["details"] == {"proof_kind": "photo"}
    assert status_of(await detail(client, headers, tid), me) == "in_progress"


async def test_a_receipt_type_asks_for_the_receipt(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    tid, headers, _ = await make_working(client, db, "EMD/Cheque Submission")
    refused = await act(client, headers, tid, "complete", remarks="Submitted")
    assert (refused.status_code, error_code(refused)) == (422, "PROOF_PHOTO_REQUIRED")
    assert refused.json()["error"]["details"] == {"proof_kind": "receipt"}
    assert "receipt" in refused.json()["error"]["message"]
    done = await act(
        client,
        headers,
        tid,
        "complete",
        remarks="Submitted",
        files=[("photos", ("r.jpg", jpeg(), "image/jpeg"))],
    )
    assert done.status_code == 200
    assert [a["kind"] for a in done.json()["task"]["attachments"]] == ["receipt"]


async def test_a_type_that_needs_no_proof_completes_without_a_photo(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    tid, headers, _ = await make_working(client, db, "Client Meeting")
    kind = (
        await db.execute(select(TaskType).where(TaskType.name == "Client Meeting"))
    ).scalar_one()
    kind.proof_photo_required = False
    await db.flush()
    done = await act(client, headers, tid, "complete", remarks="Met the client")
    assert (done.status_code, done.json()["task"]["status"]) == (200, "completed")


async def test_up_to_five_photos_each_a_real_picture(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    tid, headers, _ = await make_working(client, db)
    many = [("photos", (f"{n}.jpg", jpeg(), "image/jpeg")) for n in range(6)]
    too_many = await act(client, headers, tid, "complete", remarks="Done", files=many)
    assert (too_many.status_code, error_code(too_many)) == (422, "TOO_MANY_PHOTOS")
    fake = await act(
        client,
        headers,
        tid,
        "complete",
        remarks="Done",
        files=[("photos", ("p.jpg", b"%PDF-1.4 not a photo", "image/jpeg"))],
    )
    assert (fake.status_code, error_code(fake)) == (422, "PHOTO_UNREADABLE")
    huge = await act(
        client,
        headers,
        tid,
        "complete",
        remarks="Done",
        files=[("photos", ("p.jpg", b"\xff" * (5 * 1024 * 1024 + 2), "image/jpeg"))],
    )
    assert (huge.status_code, error_code(huge)) == (413, "PHOTO_TOO_LARGE")
    # Nothing was stored for the failed attempts.
    assert (await db.execute(select(TaskAttachment))).first() is None


async def test_a_photo_is_shrunk_and_stripped_before_it_is_stored(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    tid, headers, _ = await make_working(client, db)
    big = np.zeros((2400, 3200, 3), np.uint8)
    for n in range(0, 3200, 40):
        cv2.line(big, (n, 0), (3200 - n, 2400), (n % 255, 255 - n % 255, 90), 6)
    original = cv2.imencode(".jpg", big)[1].tobytes()
    # A fake EXIF block (APP1) in front of the picture data.
    exif = b"\xff\xe1\x00\x10Exif\x00\x00GPSSECRET!"
    with_exif = original[:2] + exif + original[2:]
    done = await act(
        client,
        headers,
        tid,
        "complete",
        remarks="Done",
        files=[("photos", ("p.jpg", with_exif, "image/jpeg"))],
    )
    assert done.status_code == 200, done.text
    [proof] = done.json()["task"]["attachments"]
    stored = await client.get(proof["url"])
    assert stored.status_code == 200 and stored.headers["content-type"] == "image/jpeg"
    assert b"GPSSECRET" not in stored.content and b"Exif" not in stored.content
    picture = cv2.imdecode(np.frombuffer(stored.content, np.uint8), cv2.IMREAD_COLOR)
    assert max(picture.shape[:2]) == 1600
    assert proof["size"] == len(stored.content)


async def test_a_picture_that_claims_to_be_enormous_is_refused(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    tid, headers, _ = await make_working(client, db)
    # A valid PNG header that declares 60 000 x 60 000 pixels (3.6 billion).
    header = (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
        + (60000).to_bytes(4, "big") * 2
        + b"\x08\x02\x00\x00\x00\x00\x00\x00\x00"
    )
    response = await act(
        client,
        headers,
        tid,
        "complete",
        remarks="Done",
        files=[("photos", ("p.png", header, "image/png"))],
    )
    assert (response.status_code, error_code(response)) == (422, "PHOTO_UNREADABLE")


async def test_completing_twice_with_one_key_stores_the_photos_once(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    tid, headers, _ = await make_working(client, db)
    used = key()
    files = [("photos", ("p.jpg", jpeg(), "image/jpeg"))]
    one = await act(client, headers, tid, "complete", idem=used, remarks="Done", files=files)
    two = await act(client, headers, tid, "complete", idem=used, remarks="Done", files=files)
    assert (one.json()["replayed"], two.json()["replayed"]) == (False, True)
    assert len(list((await db.execute(select(TaskAttachment))).scalars())) == 1
