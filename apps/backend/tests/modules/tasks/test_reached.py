"""I have reached: the site geofence, the face check and the flags (FR-TASK-05, US-5.3), and the
assigner's review of a flagged Reached."""

import datetime as dt
import json
import uuid
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.modules.attendance.models import PunchException
from app.modules.face.provider import Decision
from app.modules.notifications.models import Notification
from app.modules.tasks.models import Task, TaskAssignee, TaskEvent
from tests.conftest import running_client, unique_ip
from tests.factories import ADMIN, role_id
from tests.modules.attendance.conftest import Clock, Scene
from tests.modules.attendance.test_punch import at_branch
from tests.modules.attendance.test_punch import send as punch
from tests.modules.employees.helpers import audit_rows, error_code
from tests.modules.face import images
from tests.modules.face.test_enrollment import stored
from tests.modules.tasks.helpers import (
    SITE,
    act,
    assigner,
    detail,
    field_person,
    key,
    make_task,
    point_from_site,
    post,
    status_of,
)
from tests.modules.tasks.test_actions import events, notifications

GOOD = images.same_person("a", 1)
Headers = dict[str, str]


async def reach(
    client: httpx.AsyncClient,
    headers: Headers,
    task_id: int,
    at: dict[str, float],
    *,
    selfie: bytes | None = GOOD,
    accuracy: float = 10,
    idem: str | None = None,
    **extra: Any,
) -> httpx.Response:
    data = {"lat": at["lat"], "lng": at["lng"], "accuracy_m": accuracy}
    data |= {k: str(v).lower() if isinstance(v, bool) else v for k, v in extra.items()}
    files = None if selfie is None else {"selfie": ("s.jpg", selfie, "image/jpeg")}
    return await client.post(
        f"/api/v1/tasks/{task_id}/reached",
        data=data,
        files=files,
        headers={**headers, "Idempotency-Key": idem or key()},
    )


async def accepted_task(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, **over: Any
) -> tuple[dict[str, Any], Headers]:
    """A task for the scene's employee (field eligible, face approved), already accepted."""
    scene.user.field_eligible = True
    await db.flush()
    _, boss = await assigner(client, db)
    task = await make_task(client, boss, [scene.user.id], **over)
    assert (await act(client, scene.headers, task["id"], "accept")).status_code == 200
    return task, boss


async def exception_rows(db: AsyncSession, user_id: int) -> list[PunchException]:
    rows = await db.execute(
        select(PunchException).where(PunchException.user_id == user_id).order_by(PunchException.id)
    )
    return list(rows.scalars())


async def assignee(db: AsyncSession, task_id: int, user_id: int) -> TaskAssignee:
    return (
        await db.execute(
            select(TaskAssignee)
            .where(TaskAssignee.task_id == task_id, TaskAssignee.user_id == user_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()


# --- inside the site ---------------------------------------------------------------------------


async def test_reaching_the_site_is_verified_stamped_and_recorded(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    task, boss = await accepted_task(client, db, scene)
    clock.at(10, 40)
    where = await point_from_site(db, task["id"], 5)
    used = key()
    response = await reach(client, scene.headers, task["id"], where, idem=used)
    assert response.status_code == 200, response.text
    out = response.json()
    assert out["replayed"] is False
    assert (out["task"]["status"], status_of(out["task"], scene.user.id)) == ("reached", "reached")
    mine = out["task"]["assignees"][0]["reach"]
    assert mine["at"].startswith("2027-03-01T05:10")
    assert (mine["distance_m"], mine["flags"], mine["review"]) == (5, [], "none")
    # The employee never gets the selfie link, the position or the score back.
    assert all(mine[k] is None for k in ("selfie_url", "lat", "lng", "face_score", "face_decision"))

    row = await assignee(db, task["id"], scene.user.id)
    assert (row.reached_at, row.reach_review, row.reach_flags) == (clock.now, "none", [])
    assert row.reached_face_decision == "VERIFIED" and row.reached_face_score is not None
    assert row.reached_selfie_key == f"task/{scene.user.id}/{used}.jpg"
    assert stored(client, row.reached_selfie_key)
    last = (await events(db, task["id"]))[-1]
    assert (last.event, last.subject_user_id, last.at) == ("reached", scene.user.id, clock.now)
    assert last.accuracy_m == 10
    assert await notifications(db, task["created_by"]["id"]) == ["task_accepted", "task_reached"]
    [row_audit] = await audit_rows(db, "task.reached")
    assert row_audit.after is not None and row_audit.after["flags"] == []
    assert "lat" not in json.dumps(row_audit.after)
    assert await exception_rows(db, scene.user.id) == []

    seen = await detail(client, boss, task["id"])
    reach_out = seen["assignees"][0]["reach"]
    assert reach_out["selfie_url"].startswith("/api/v1/files/")
    assert reach_out["face_decision"] == "VERIFIED"
    assert reach_out["face_score"] is None  # the creator is no face reviewer
    assert reach_out["lat"] == pytest.approx(where["lat"])
    assert seen["assignees"][0]["metrics"]["accept_to_reached_min"] == 35


@pytest.mark.parametrize(
    ("metres", "accuracy", "accepted"),
    [
        (195, 5, True),  # inside the 200 m radius
        (208, 10, True),  # outside the radius, inside radius + accuracy (210 m)
        (230, 30, True),  # exactly on radius + the capped 30 m buffer
        (231, 30, False),  # one metre beyond
        (212, 10, False),
        (260, 80, False),  # a fix worse than the limit is refused wherever it claims to be
    ],
)
async def test_the_site_edge_and_accuracy_through_the_endpoint(
    client: httpx.AsyncClient,
    db: AsyncSession,
    scene: Scene,
    metres: float,
    accuracy: float,
    accepted: bool,
) -> None:
    task, _ = await accepted_task(client, db, scene)
    where = await point_from_site(db, task["id"], metres)
    response = await reach(client, scene.headers, task["id"], where, accuracy=accuracy)
    assert (response.status_code == 200) is accepted, response.text
    if accepted:
        assert response.json()["task"]["assignees"][0]["reach"]["flags"] == []
        return
    assert error_code(response) in {"OUTSIDE_SITE", "GPS_ACCURACY_POOR"}
    assert (await assignee(db, task["id"], scene.user.id)).status == "accepted"


async def test_outside_the_site_says_how_far_and_changes_nothing(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    task, _ = await accepted_task(client, db, scene)
    where = await point_from_site(db, task["id"], 450)
    response = await reach(client, scene.headers, task["id"], where)
    assert (response.status_code, error_code(response)) == (422, "OUTSIDE_SITE")
    assert response.json()["error"]["details"] == {"distance_m": 450, "radius_m": 200}
    row = await assignee(db, task["id"], scene.user.id)
    assert (row.status, row.reached_at, row.reached_selfie_key) == ("accepted", None, None)
    assert [e.event for e in await events(db, task["id"])][-1] == "accepted"
    assert await exception_rows(db, scene.user.id) == []


async def test_a_wider_site_radius_accepts_a_further_point(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    task, _ = await accepted_task(client, db, scene, site=SITE | {"radius_m": 400})
    where = await point_from_site(db, task["id"], 390)
    assert (await reach(client, scene.headers, task["id"], where)).status_code == 200


# --- a location mismatch with a reason ---------------------------------------------------------


async def test_a_mismatch_with_a_reason_is_flagged_and_waits_for_review(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    task, _ = await accepted_task(client, db, scene)
    where = await point_from_site(db, task["id"], 450)
    response = await reach(
        client, scene.headers, task["id"], where, mismatch_reason="The client met me at the gate"
    )
    assert response.status_code == 200, response.text
    mine = response.json()["task"]["assignees"][0]["reach"]
    assert (mine["flags"], mine["review"], mine["distance_m"]) == (
        ["location_mismatch"],
        "pending",
        450,
    )
    assert mine["reason"] == "The client met me at the gate"
    assert response.json()["task"]["status"] == "reached"  # work is not blocked
    note = (
        await db.execute(select(Notification).where(Notification.type == "task_reach_mismatch"))
    ).scalar_one()
    assert note.user_id == task["created_by"]["id"] and "needs review" in note.title
    [feed] = await exception_rows(db, scene.user.id)
    assert (feed.kind, feed.distance_m, feed.details) == (
        "OUTSIDE_GEOFENCE",
        450,
        {"task": task["code"]},
    )
    assert str(where["lat"])[:6] not in json.dumps(feed.details)
    event = (await events(db, task["id"]))[-1]
    assert event.note == "The client met me at the gate"


async def test_a_reason_is_ignored_when_the_person_is_at_the_site_and_must_be_real(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    task, _ = await accepted_task(client, db, scene)
    where = await point_from_site(db, task["id"], 3)
    short = await reach(client, scene.headers, task["id"], where, mismatch_reason="no")
    assert (short.status_code, error_code(short)) == (422, "VALIDATION_ERROR")
    response = await reach(client, scene.headers, task["id"], where, mismatch_reason="At the site")
    mine = response.json()["task"]["assignees"][0]["reach"]
    assert (mine["flags"], mine["reason"], mine["review"]) == ([], None, "none")


# --- the phone's own report --------------------------------------------------------------------


@pytest.mark.parametrize(
    ("flag", "code", "kind"),
    [
        ("mocked", "MOCK_LOCATION", "MOCK_LOCATION"),
        ("emulator", "DEVICE_NOT_TRUSTED", "EMULATOR"),
        ("rooted", "DEVICE_NOT_TRUSTED", "ROOTED_DEVICE"),
    ],
)
async def test_a_mock_location_emulator_or_rooted_phone_is_refused_and_logged(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, flag: str, code: str, kind: str
) -> None:
    task, _ = await accepted_task(client, db, scene)
    where = await point_from_site(db, task["id"], 5)
    response = await reach(client, scene.headers, task["id"], where, **{flag: True})
    assert (response.status_code, error_code(response)) == (403, code)
    [feed] = await exception_rows(db, scene.user.id)
    assert (feed.kind, feed.details) == (kind, {"task": task["code"]})
    assert (feed.nearest_branch, feed.distance_m) == (None, None)  # no coordinates, no place
    assert (await assignee(db, task["id"], scene.user.id)).status == "accepted"


async def test_the_development_switch_lets_a_mock_reach_through_flagged(
    db: AsyncSession, scene: Scene
) -> None:
    allowed = get_settings().model_copy(
        update={"app_env": "development", "allow_mock_location": True}
    )
    async with running_client(allowed, db, unique_ip()) as dev:
        task, _ = await accepted_task(dev, db, scene)
        where = await point_from_site(db, task["id"], 5)
        response = await reach(dev, scene.headers, task["id"], where, mocked=True)
    assert response.status_code == 200, response.text
    assert [f.kind for f in await exception_rows(db, scene.user.id)] == ["MOCK_LOCATION"]


async def test_the_switch_does_nothing_outside_development(db: AsyncSession, scene: Scene) -> None:
    settings = get_settings().model_copy(update={"app_env": "test", "allow_mock_location": True})
    async with running_client(settings, db, unique_ip()) as other:
        task, _ = await accepted_task(other, db, scene)
        where = await point_from_site(db, task["id"], 5)
        response = await reach(other, scene.headers, task["id"], where, mocked=True)
    assert (response.status_code, error_code(response)) == (403, "MOCK_LOCATION")


async def test_a_poor_fix_is_refused_and_logged(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    task, _ = await accepted_task(client, db, scene)
    where = await point_from_site(db, task["id"], 5)
    response = await reach(client, scene.headers, task["id"], where, accuracy=80)
    assert (response.status_code, error_code(response)) == (422, "GPS_ACCURACY_POOR")
    assert [f.kind for f in await exception_rows(db, scene.user.id)] == ["GPS_ACCURACY_POOR"]


# --- the face ----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("make", "issue"),
    [
        pytest.param(images.empty_wall, "NO_FACE", id="no-face"),
        pytest.param(images.two_faces, "MULTIPLE_FACES", id="two-faces"),
        pytest.param(lambda: images.blurred("a"), "BLURRY", id="blurry"),
        pytest.param(lambda: images.darkened("a"), "TOO_DARK", id="too-dark"),
        pytest.param(lambda: b"not a picture", "UNREADABLE_IMAGE", id="garbage"),
    ],
)
async def test_an_unusable_selfie_asks_for_a_retake_and_stores_nothing(
    client: httpx.AsyncClient,
    db: AsyncSession,
    scene: Scene,
    make: Callable[[], bytes],
    issue: str,
) -> None:
    task, _ = await accepted_task(client, db, scene)
    where = await point_from_site(db, task["id"], 5)
    response = await reach(client, scene.headers, task["id"], where, selfie=make())
    assert (response.status_code, error_code(response)) == (422, "FACE_RETAKE")
    assert response.json()["error"]["details"] == {"issue": issue}
    assert (await assignee(db, task["id"], scene.user.id)).status == "accepted"
    assert await exception_rows(db, scene.user.id) == []
    # Trying again with a good photo works.
    assert (await reach(client, scene.headers, task["id"], where)).status_code == 200


async def test_a_borderline_face_is_flagged_for_review_but_work_goes_on(
    client: httpx.AsyncClient,
    db: AsyncSession,
    scene: Scene,
    force_face: Callable[[Decision, float], None],
) -> None:
    force_face(Decision.PENDING_REVIEW, 0.35)
    task, _ = await accepted_task(client, db, scene)
    where = await point_from_site(db, task["id"], 5)
    response = await reach(client, scene.headers, task["id"], where)
    assert response.status_code == 200
    mine = response.json()["task"]["assignees"][0]["reach"]
    assert (mine["flags"], mine["review"]) == (["face_review"], "pending")
    row = await assignee(db, task["id"], scene.user.id)
    assert (row.reached_face_score, row.reached_face_decision) == (0.35, "PENDING_REVIEW")
    assert await exception_rows(db, scene.user.id) == []  # borderline is not an exception
    assert response.json()["task"]["status"] == "reached"


async def test_another_persons_face_is_flagged_logged_and_the_score_is_for_face_reviewers(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    task, boss = await accepted_task(client, db, scene)
    where = await point_from_site(db, task["id"], 5)
    response = await reach(
        client, scene.headers, task["id"], where, selfie=images.same_person("b", 1)
    )
    assert response.status_code == 200
    mine = response.json()["task"]["assignees"][0]["reach"]
    assert (mine["flags"], mine["review"]) == (["face_review"], "pending")
    assert [f.kind for f in await exception_rows(db, scene.user.id)] == ["FACE_MISMATCH"]
    row = await assignee(db, task["id"], scene.user.id)
    assert row.reached_face_decision == "MISMATCH"
    assert (await detail(client, boss, task["id"]))["assignees"][0]["reach"]["face_score"] is None


async def test_reaching_needs_an_approved_face(client: httpx.AsyncClient, db: AsyncSession) -> None:
    ann, headers = await field_person(client, db, 1)
    _, boss = await assigner(client, db)
    task = await make_task(client, boss, [ann.id])
    assert (await act(client, headers, task["id"], "accept")).status_code == 200
    where = await point_from_site(db, task["id"], 5)
    response = await reach(client, headers, task["id"], where)
    assert (response.status_code, error_code(response)) == (409, "FACE_NOT_APPROVED")


# --- impossible jumps --------------------------------------------------------------------------


async def test_an_impossible_jump_from_the_last_punch_is_flagged_not_blocked(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    far = SITE | {"lat": 21.5, "lng": 86.9}  # about 160 km from the branch
    task, _ = await accepted_task(client, db, scene, site=far)
    clock.at(10, 5)
    assert (
        await punch(client, scene.headers, "punch-in", await at_branch(db, scene))
    ).status_code == 201
    clock.at(10, 15)  # 160 km in ten minutes
    where = await point_from_site(db, task["id"], 5)
    response = await reach(client, scene.headers, task["id"], where)
    assert response.status_code == 200, response.text
    mine = response.json()["task"]["assignees"][0]["reach"]
    assert (mine["flags"], mine["review"]) == (["impossible_jump"], "pending")
    assert "IMPOSSIBLE_JUMP" in [f.kind for f in await exception_rows(db, scene.user.id)]


async def test_an_impossible_jump_from_the_last_reached_is_flagged(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    near, _ = await accepted_task(client, db, scene)
    far, _ = await accepted_task(client, db, scene, site=SITE | {"lat": 21.5, "lng": 86.9})
    clock.at(10, 5)
    assert (
        await reach(client, scene.headers, near["id"], await point_from_site(db, near["id"], 5))
    ).status_code == 200
    clock.at(10, 20)
    response = await reach(
        client, scene.headers, far["id"], await point_from_site(db, far["id"], 5)
    )
    mine = response.json()["task"]["assignees"][0]["reach"]
    assert mine["flags"] == ["impossible_jump"]


async def test_a_normal_drive_is_not_flagged(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    first, _ = await accepted_task(client, db, scene)
    second, _ = await accepted_task(client, db, scene, site=SITE | {"lat": 20.4, "lng": 85.85})
    clock.at(10, 5)
    await reach(client, scene.headers, first["id"], await point_from_site(db, first["id"], 5))
    clock.at(12, 0)  # 11 km in two hours
    response = await reach(
        client, scene.headers, second["id"], await point_from_site(db, second["id"], 5)
    )
    assert response.json()["task"]["assignees"][0]["reach"]["flags"] == []


# --- idempotency, state, offline ---------------------------------------------------------------


async def test_the_same_key_twice_changes_nothing_the_second_time(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    task, _ = await accepted_task(client, db, scene)
    where = await point_from_site(db, task["id"], 5)
    used = key()
    one = await reach(client, scene.headers, task["id"], where, idem=used)
    two = await reach(client, scene.headers, task["id"], where, idem=used)
    assert (one.status_code, two.status_code) == (200, 200)
    assert (one.json()["replayed"], two.json()["replayed"]) == (False, True)
    assert [e.event for e in await events(db, task["id"])].count("reached") == 1
    assert len(await audit_rows(db, "task.reached")) == 1
    assert await notifications(db, task["created_by"]["id"]) == ["task_accepted", "task_reached"]


async def test_a_key_used_for_another_action_is_refused(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    scene.user.field_eligible = True
    await db.flush()
    _, boss = await assigner(client, db)
    task = await make_task(client, boss, [scene.user.id])
    where = await point_from_site(db, task["id"], 5)
    used = key()
    assert (await act(client, scene.headers, task["id"], "accept", idem=used)).status_code == 200
    response = await reach(client, scene.headers, task["id"], where, idem=used)
    assert (response.status_code, error_code(response)) == (409, "IDEMPOTENCY_KEY_REUSED")


@pytest.mark.parametrize(
    "status", ["assigned", "reached", "in_progress", "on_hold", "completed", "declined"]
)
async def test_reaching_is_only_possible_after_accepting(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, status: str
) -> None:
    task, _ = await accepted_task(client, db, scene)
    row = await assignee(db, task["id"], scene.user.id)
    row.status = status
    await db.flush()
    where = await point_from_site(db, task["id"], 5)
    response = await reach(client, scene.headers, task["id"], where)
    assert (response.status_code, error_code(response)) == (409, "INVALID_TRANSITION")
    assert response.json()["error"]["details"] == {"from": status, "action": "reached"}


async def test_only_the_assignee_reaches(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    task, _ = await accepted_task(client, db, scene)
    _, other = await field_person(client, db, 7)
    where = await point_from_site(db, task["id"], 5)
    response = await reach(client, other, task["id"], where)
    assert (response.status_code, error_code(response)) == (404, "TASK_NOT_FOUND")


async def test_the_selfie_is_required_and_limited(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    task, _ = await accepted_task(client, db, scene)
    where = await point_from_site(db, task["id"], 5)
    none = await reach(client, scene.headers, task["id"], where, selfie=None)
    assert (none.status_code, error_code(none)) == (422, "VALIDATION_ERROR")
    huge = await reach(
        client, scene.headers, task["id"], where, selfie=b"\xff" * (5 * 1024 * 1024 + 2)
    )
    assert (huge.status_code, error_code(huge)) == (413, "PHOTO_TOO_LARGE")
    no_position = await client.post(
        f"/api/v1/tasks/{task['id']}/reached",
        files={"selfie": ("s.jpg", GOOD, "image/jpeg")},
        headers={**scene.headers, "Idempotency-Key": key()},
    )
    assert no_position.status_code == 422


async def test_an_offline_reach_counts_at_receipt_time_and_skips_the_jump_check(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    far = SITE | {"lat": 21.5, "lng": 86.9}
    task, _ = await accepted_task(client, db, scene, site=far)
    clock.at(10, 5)
    await punch(client, scene.headers, "punch-in", await at_branch(db, scene))
    clock.at(10, 15)
    where = await point_from_site(db, task["id"], 5)
    taken = clock.now - dt.timedelta(minutes=30)
    missing = await reach(client, scene.headers, task["id"], where, offline=True)
    assert (missing.status_code, error_code(missing)) == (422, "OFFLINE_TIME_MISSING")
    old = clock.now - dt.timedelta(hours=13)
    too_old = await reach(
        client, scene.headers, task["id"], where, offline=True, device_time=old.isoformat()
    )
    assert (too_old.status_code, error_code(too_old)) == (409, "OFFLINE_PUNCH_TOO_OLD")
    response = await reach(
        client, scene.headers, task["id"], where, offline=True, device_time=taken.isoformat()
    )
    assert response.status_code == 200, response.text
    assert response.json()["task"]["assignees"][0]["reach"]["flags"] == []
    event = (await events(db, task["id"]))[-1]
    assert (event.offline, event.at, event.device_time) == (True, clock.now, taken)


# --- the review --------------------------------------------------------------------------------


async def flagged(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> tuple[dict[str, Any], Headers]:
    task, boss = await accepted_task(client, db, scene)
    where = await point_from_site(db, task["id"], 450)
    response = await reach(
        client, scene.headers, task["id"], where, mismatch_reason="Gate is on the far side"
    )
    assert response.status_code == 200
    return task, boss


async def test_the_assigner_approves_a_flagged_reached(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    task, boss = await flagged(client, db, scene)
    path = f"{task['id']}/assignees/{scene.user.id}/reach-review"
    used = key()
    response = await post(
        client, boss, path, {"decision": "approve", "remarks": "Seen it"}, idem=used
    )
    assert response.status_code == 200, response.text
    out = response.json()["task"]["assignees"][0]["reach"]
    assert (out["review"], out["review_remarks"]) == ("approved", "Seen it")
    assert out["reviewed_by"]["id"] == task["created_by"]["id"] and out["reviewed_at"]
    assert out["flags"] == ["location_mismatch"]  # the flag stays on record
    again = await post(client, boss, path, {"decision": "approve", "remarks": "Seen it"}, idem=used)
    assert again.json()["replayed"] is True
    decided = await post(client, boss, path, {"decision": "reject", "remarks": "Changed my mind"})
    assert (decided.status_code, error_code(decided)) == (409, "ALREADY_DECIDED")
    last = (await events(db, task["id"]))[-1]
    assert (last.event, last.subject_user_id) == ("reach_reviewed", scene.user.id)
    assert len(await audit_rows(db, "task.reach_review")) == 1


async def test_a_rejection_needs_a_reason_and_is_final_for_the_review(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    task, boss = await flagged(client, db, scene)
    path = f"{task['id']}/assignees/{scene.user.id}/reach-review"
    assert error_code(await post(client, boss, path, {"decision": "reject"})) == "REMARKS_REQUIRED"
    assert (await post(client, boss, path, {"decision": "maybe"})).status_code == 422
    rejected = await post(client, boss, path, {"decision": "reject", "remarks": "Not at the site"})
    assert rejected.status_code == 200
    assert rejected.json()["task"]["assignees"][0]["reach"]["review"] == "rejected"
    assert (await assignee(db, task["id"], scene.user.id)).status == "reached"  # work continues


async def test_nobody_reviews_their_own_reached(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    # An admin who is also on the task.
    scene.user.role_id = await role_id(db, ADMIN)
    await db.flush()
    await db.refresh(scene.user)
    task, _ = await accepted_task(client, db, scene)
    where = await point_from_site(db, task["id"], 450)
    await reach(client, scene.headers, task["id"], where, mismatch_reason="Far side of the site")
    path = f"{task['id']}/assignees/{scene.user.id}/reach-review"
    response = await post(client, scene.headers, path, {"decision": "approve"})
    assert (response.status_code, error_code(response)) == (403, "CANNOT_DECIDE_OWN")
    assert (await assignee(db, task["id"], scene.user.id)).reach_review == "pending"


async def test_only_a_manager_of_the_task_reviews(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    task, boss = await flagged(client, db, scene)
    _, other = await assigner(client, db)
    path = f"{task['id']}/assignees/{scene.user.id}/reach-review"
    body = {"decision": "approve"}
    stranger = await post(client, other, path, body)
    assert (stranger.status_code, error_code(stranger)) == (404, "TASK_NOT_FOUND")
    own = await post(client, scene.headers, path, body)
    assert (own.status_code, error_code(own)) == (403, "FORBIDDEN")
    nobody = await post(client, boss, f"{task['id']}/assignees/999999999/reach-review", body)
    assert (nobody.status_code, error_code(nobody)) == (404, "NOT_ASSIGNED")


async def test_a_reached_that_needs_no_review_cannot_be_reviewed(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    task, boss = await accepted_task(client, db, scene)
    await reach(client, scene.headers, task["id"], await point_from_site(db, task["id"], 5))
    response = await post(
        client,
        boss,
        f"{task['id']}/assignees/{scene.user.id}/reach-review",
        {"decision": "approve"},
    )
    assert (response.status_code, error_code(response)) == (409, "ALREADY_DECIDED")


async def test_the_whole_flow_a_flagged_reached_blocks_closing_until_it_is_decided(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    task, boss = await flagged(client, db, scene)
    tid = task["id"]
    assert (await act(client, scene.headers, tid, "start")).status_code == 200
    done = await act(
        client,
        scene.headers,
        tid,
        "complete",
        remarks="Installed",
        files=[("photos", ("p.jpg", images.photo("a"), "image/jpeg"))],
    )
    assert done.json()["task"]["status"] == "completed"
    blocked = await post(client, boss, f"{tid}/close", {})
    assert (blocked.status_code, error_code(blocked)) == (409, "REACH_REVIEW_PENDING")
    review = f"{tid}/assignees/{scene.user.id}/reach-review"
    assert (await post(client, boss, review, {"decision": "approve"})).status_code == 200
    closed = await post(client, boss, f"{tid}/close", {})
    assert closed.status_code == 200
    out = closed.json()["task"]
    assert out["status"] == "closed"
    metrics = out["assignees"][0]["metrics"]
    assert metrics["time_on_site_min"] == 0 and metrics["accept_to_reached_min"] == 0


async def test_the_site_cannot_move_once_someone_reached(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    task, boss = await accepted_task(client, db, scene)
    await reach(client, scene.headers, task["id"], await point_from_site(db, task["id"], 5))
    response = await post(
        client, boss, str(task["id"]), {"site": SITE | {"lat": 20.31}}, method="PATCH"
    )
    assert (response.status_code, error_code(response)) == (409, "TASK_SITE_LOCKED")
    row = await db.get(Task, task["id"], populate_existing=True)
    assert row is not None and row.site_lat == pytest.approx(SITE["lat"])


async def test_reached_events_are_tied_to_the_person_and_key(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    task, _ = await accepted_task(client, db, scene)
    used = key()
    await reach(
        client, scene.headers, task["id"], await point_from_site(db, task["id"], 5), idem=used
    )
    event = (
        await db.execute(select(TaskEvent).where(TaskEvent.request_id == uuid.UUID(used)))
    ).scalar_one()
    assert (event.event, event.actor_id) == ("reached", scene.user.id)
