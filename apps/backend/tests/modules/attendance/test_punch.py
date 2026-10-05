"""Punch in and out through the real endpoints (SRS 4.5, 4.6, 5.1, 5.2, 6, 7)."""

import datetime as dt
import json
import uuid
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.modules.attendance.models import AttendanceDay, PunchEvent, PunchException
from app.modules.face.provider import Decision
from tests.conftest import running_client, unique_ip
from tests.factories import auth_headers, device, make_branch, make_user
from tests.modules.attendance.conftest import MONDAY, SUNDAY, Clock, Headers, Scene, ist
from tests.modules.branches.test_geofence import point_at
from tests.modules.employees.helpers import API, audit_rows, error_code
from tests.modules.face import images
from tests.modules.schedule.test_punch import HOME, add_home
from tests.modules.schedule.test_schedule import add_schedule

A = f"{API}/attendance"
GOOD = images.same_person("a", 1)


async def send(
    client: httpx.AsyncClient,
    headers: Headers,
    kind: str,
    at: dict[str, float],
    *,
    key: str | None = None,
    selfie: bytes = GOOD,
    accuracy: float = 10,
    **extra: Any,
) -> httpx.Response:
    """kind: punch-in, punch-out or punch-out-requests."""
    data = {"lat": at["lat"], "lng": at["lng"], "accuracy_m": accuracy}
    data |= {k: str(v).lower() if isinstance(v, bool) else v for k, v in extra.items()}
    return await client.post(
        f"{A}/{kind}",
        data=data,
        files={"selfie": ("s.jpg", selfie, "image/jpeg")},
        headers={**headers, "Idempotency-Key": key or str(uuid.uuid4())},
    )


async def at_branch(db: AsyncSession, scene: Scene, metres: float = 5) -> dict[str, float]:
    return await point_at(db, scene.branch, metres)


async def events(db: AsyncSession, user_id: int) -> list[PunchEvent]:
    result = await db.execute(
        select(PunchEvent)
        .where(PunchEvent.user_id == user_id)
        .order_by(PunchEvent.id)
        .execution_options(populate_existing=True)
    )
    return list(result.scalars())


async def exceptions(db: AsyncSession, user_id: int) -> list[str]:
    result = await db.execute(
        select(PunchException.kind)
        .where(PunchException.user_id == user_id)
        .order_by(PunchException.id)
    )
    return list(result.scalars())


async def today_row(db: AsyncSession, user_id: int) -> AttendanceDay:
    return (
        await db.execute(
            select(AttendanceDay)
            .where(AttendanceDay.user_id == user_id, AttendanceDay.date == MONDAY)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()


# --- punch in ---------------------------------------------------------------------------------


async def test_a_verified_punch_in_is_stored_with_server_time_and_audited(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    where = await at_branch(db, scene)
    skewed = (clock.now - dt.timedelta(hours=3)).isoformat()  # a phone with the wrong time
    response = await send(client, scene.headers, "punch-in", where, device_time=skewed)
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["result"] == "verified"
    assert body["replayed"] is False
    assert body["punch"]["type"] == "in"
    assert body["punch"]["place"]["branch"] == scene.branch.name
    assert body["day"]["status"] == "working"
    assert body["day"]["late_minutes"] == 0
    [event] = await events(db, scene.user.id)
    # Invariant 1: the counted time is the server's; the phone's is kept for audit only.
    assert event.effective_time == clock.now == event.server_time
    assert event.device_time == dt.datetime.fromisoformat(skewed)
    assert event.review_status == "verified" and event.face_decision == "VERIFIED"
    assert event.thresholds_used == {"verify": 0.4, "review": 0.3}
    assert event.face_model_version
    assert event.selfie_key == f"punch/{scene.user.id}/{event.request_id}.jpg"
    rows = await audit_rows(db, "punch.in")
    assert rows[-1].actor_id == scene.user.id
    assert rows[-1].after is not None and "lat" not in json.dumps(rows[-1].after)


async def test_the_response_never_carries_a_score_or_a_storage_key(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    response = await send(client, scene.headers, "punch-in", await at_branch(db, scene))
    text = response.text
    assert not any(word in text for word in ("score", "selfie", ".jpg", "punch/", "thresholds"))


@pytest.mark.parametrize(("minute", "late"), [(10, 0), (11, 11), (30, 30)])
async def test_late_mark_after_the_grace_period(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock, minute: int, late: int
) -> None:
    clock.at(10, minute)
    response = await send(client, scene.headers, "punch-in", await at_branch(db, scene))
    assert response.json()["day"]["late_minutes"] == late


async def test_the_scenario_10_05_in_and_18_00_out_is_a_full_day_and_not_late(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    where = await at_branch(db, scene)
    clock.at(10, 5)
    assert (await send(client, scene.headers, "punch-in", where)).status_code == 201
    clock.at(18, 0)
    response = await send(client, scene.headers, "punch-out", where)
    assert response.status_code == 201, response.text
    day = response.json()["day"]
    assert (day["status"], day["late_minutes"], day["worked_minutes"]) == ("present", 0, 475)
    assert day["flags"] == []


async def test_only_one_punch_in_a_day(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    where = await at_branch(db, scene)
    assert (await send(client, scene.headers, "punch-in", where)).status_code == 201
    second = await send(client, scene.headers, "punch-in", where)
    assert (second.status_code, error_code(second)) == (409, "ALREADY_PUNCHED_IN")
    assert len(await events(db, scene.user.id)) == 1


# --- idempotency ------------------------------------------------------------------------------


async def test_the_same_request_id_twice_is_the_same_punch(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    where = await at_branch(db, scene)
    key = str(uuid.uuid4())
    first = await send(client, scene.headers, "punch-in", where, key=key)
    clock.at(10, 40)  # a late retry must not move the punch or add a late mark
    again = await send(client, scene.headers, "punch-in", where, key=key)
    assert (first.status_code, again.status_code) == (201, 201)
    assert again.json()["replayed"] is True
    assert again.json()["punch"] == first.json()["punch"]
    assert len(await events(db, scene.user.id)) == 1
    assert len(await audit_rows(db, "punch.in")) == 1


async def test_a_replay_is_answered_even_when_the_day_has_since_closed(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    where = await at_branch(db, scene)
    key = str(uuid.uuid4())
    await send(client, scene.headers, "punch-in", where, key=key)
    clock.at(23, 59, 30)
    assert (await send(client, scene.headers, "punch-in", where, key=key)).status_code == 201


async def test_a_request_id_belongs_to_one_kind_of_punch(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    where = await at_branch(db, scene)
    key = str(uuid.uuid4())
    await send(client, scene.headers, "punch-in", where, key=key)
    wrong = await send(client, scene.headers, "punch-out", where, key=key)
    assert (wrong.status_code, error_code(wrong)) == (409, "IDEMPOTENCY_KEY_REUSED")


async def test_two_people_may_use_the_same_request_id(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    from tests.modules.face.test_enrollment import approved

    other, other_headers, _, _ = await approved(client, db, 2, "b")
    other.shift_id = scene.shift.id
    await db.flush()
    await db.refresh(other)
    where = await at_branch(db, scene)
    key = str(uuid.uuid4())
    first = await send(client, scene.headers, "punch-in", where, key=key)
    second = await send(
        client, other_headers, "punch-in", where, key=key, selfie=images.same_person("b", 1)
    )
    assert (first.status_code, second.status_code) == (201, 201)
    assert second.json()["replayed"] is False


async def test_a_punch_needs_an_idempotency_key(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    where = await at_branch(db, scene)
    response = await client.post(
        f"{A}/punch-in",
        data={"lat": where["lat"], "lng": where["lng"], "accuracy_m": 10},
        files={"selfie": ("s.jpg", GOOD, "image/jpeg")},
        headers=scene.headers,
    )
    assert (response.status_code, error_code(response)) == (422, "VALIDATION_ERROR")


# --- who may punch, and when ------------------------------------------------------------------


async def test_a_phone_that_is_not_approved_cannot_punch(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    second_phone = await auth_headers(client, scene.user, kind="mobile", device_info=device(9))
    response = await send(client, second_phone, "punch-in", await at_branch(db, scene))
    assert (response.status_code, error_code(response)) == (403, "DEVICE_NOT_APPROVED")


async def test_an_employee_without_an_approved_face_cannot_punch(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    user = await make_user(db, shift_id=scene.shift.id)
    headers = await auth_headers(client, user, kind="mobile", device_info=device(5))
    response = await send(client, headers, "punch-in", await at_branch(db, scene))
    assert (response.status_code, error_code(response)) == (409, "FACE_NOT_APPROVED")


async def test_a_day_off_blocks_the_punch(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    clock.at(10, 5, day=SUNDAY)
    response = await send(client, scene.headers, "punch-in", await at_branch(db, scene))
    assert (response.status_code, error_code(response)) == (409, "OFF_DAY")
    assert await events(db, scene.user.id) == []


async def test_a_shift_is_needed(client: httpx.AsyncClient, db: AsyncSession, scene: Scene) -> None:
    scene.user.shift_id = None
    await db.flush()
    await db.refresh(scene.user)
    response = await send(client, scene.headers, "punch-in", await at_branch(db, scene))
    assert (response.status_code, error_code(response)) == (409, "NO_SHIFT")


async def test_after_the_cut_off_the_day_is_closed(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    where = await at_branch(db, scene)
    clock.at(23, 58)
    assert (await send(client, scene.headers, "punch-in", where)).status_code == 201
    clock.at(23, 59)
    response = await send(client, scene.headers, "punch-out", where)
    assert (response.status_code, error_code(response)) == (409, "DAY_CLOSED")


async def test_an_employee_whose_home_branch_is_inactive_punches_at_an_active_branch(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    dormant = await make_branch(db, "Demo HQ", lat=22.0, lng=87.0, is_active=False)
    scene.user.home_branch_id = dormant.id
    await db.flush()
    await db.refresh(scene.user)
    response = await send(client, scene.headers, "punch-in", await at_branch(db, scene))
    assert response.status_code == 201
    [event] = await events(db, scene.user.id)
    assert event.branch_id == scene.branch.id  # where they punched, not their home branch


async def test_restricted_to_an_inactive_home_branch_says_so(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    dormant = await make_branch(db, "Demo HQ", lat=22.0, lng=87.0, is_active=False)
    scene.user.home_branch_id = dormant.id
    scene.user.restrict_to_home_branch = True
    await db.flush()
    await db.refresh(scene.user)
    response = await send(client, scene.headers, "punch-in", await at_branch(db, scene))
    assert (response.status_code, error_code(response)) == (409, "HOME_BRANCH_INACTIVE")


# --- the geofence, on the server ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("metres", "accuracy", "accepted"),
    [
        (95, 5, True),  # inside the 100 m fence
        (108, 10, True),  # outside the fence, inside fence + accuracy (110 m)
        (112, 10, False),  # just beyond fence + accuracy
        (140, 30, False),  # the accuracy buffer is capped at 30 m: 130 m at most
        (128, 30, True),
        (60, 80, False),  # a fix worse than the limit is refused wherever it claims to be
    ],
)
async def test_the_fence_edge_and_accuracy_through_the_endpoint(
    client: httpx.AsyncClient,
    db: AsyncSession,
    scene: Scene,
    metres: float,
    accuracy: float,
    accepted: bool,
) -> None:
    where = await point_at(db, scene.branch, metres)
    response = await send(client, scene.headers, "punch-in", where, accuracy=accuracy)
    assert (response.status_code == 201) is accepted, response.text
    if not accepted:
        assert error_code(response) in {"OUTSIDE_GEOFENCE", "GPS_ACCURACY_POOR"}
        assert await events(db, scene.user.id) == []


async def test_outside_the_fence_says_how_far_and_is_logged_without_coordinates(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    where = await point_at(db, scene.branch, 450)
    response = await send(client, scene.headers, "punch-in", where)
    assert (response.status_code, error_code(response)) == (422, "OUTSIDE_GEOFENCE")
    assert response.json()["error"]["details"] == {"branch": scene.branch.name, "distance_m": 450}
    assert await exceptions(db, scene.user.id) == ["OUTSIDE_GEOFENCE"]
    row = (await db.execute(select(PunchException))).scalars().one()
    assert (row.nearest_branch, row.distance_m) == (scene.branch.name, 450)
    assert "lat" not in json.dumps(row.details or {})
    assert (await db.scalar(select(func.count()).select_from(PunchEvent))) == 0


async def test_a_poor_fix_is_refused_and_logged(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    response = await send(
        client, scene.headers, "punch-in", await at_branch(db, scene), accuracy=80
    )
    assert (response.status_code, error_code(response)) == (422, "GPS_ACCURACY_POOR")
    assert await exceptions(db, scene.user.id) == ["GPS_ACCURACY_POOR"]


# --- face -------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("make", "issue"),
    [
        pytest.param(images.empty_wall, "NO_FACE", id="no-face"),
        pytest.param(images.two_faces, "MULTIPLE_FACES", id="two-faces"),
        pytest.param(lambda: images.blurred("a"), "BLURRY", id="blurry"),
        pytest.param(lambda: images.darkened("a"), "TOO_DARK", id="too-dark"),
    ],
)
async def test_an_unusable_selfie_asks_for_a_retake_and_stores_nothing(
    client: httpx.AsyncClient,
    db: AsyncSession,
    scene: Scene,
    make: Callable[[], bytes],
    issue: str,
) -> None:
    where = await at_branch(db, scene)
    response = await send(client, scene.headers, "punch-in", where, selfie=make())
    assert (response.status_code, error_code(response)) == (422, "FACE_RETAKE")
    assert response.json()["error"]["details"] == {"issue": issue}
    assert await events(db, scene.user.id) == []
    # The employee can simply try again with a good photo (the key was not used up).
    assert (await send(client, scene.headers, "punch-in", where)).status_code == 201


async def test_another_persons_face_is_stored_flagged_and_sent_for_review(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    where = await at_branch(db, scene)
    response = await send(
        client, scene.headers, "punch-in", where, selfie=images.same_person("b", 1)
    )
    assert response.status_code == 201
    body = response.json()
    assert body["result"] == "in_review"
    assert body["day"]["flags"] == ["face_review"]
    [event] = await events(db, scene.user.id)
    assert (event.face_decision, event.review_status) == ("MISMATCH", "pending")
    assert event.review_reasons == ["face_mismatch"]
    assert await exceptions(db, scene.user.id) == ["FACE_MISMATCH"]


async def test_a_borderline_score_goes_to_review_and_still_counts_for_now(
    client: httpx.AsyncClient,
    db: AsyncSession,
    scene: Scene,
    force_face: Callable[[Decision, float], None],
) -> None:
    force_face(Decision.PENDING_REVIEW, 0.35)
    response = await send(client, scene.headers, "punch-in", await at_branch(db, scene))
    assert response.json()["result"] == "in_review"
    [event] = await events(db, scene.user.id)
    assert (event.face_score, event.face_decision) == (0.35, "PENDING_REVIEW")
    assert (await today_row(db, scene.user.id)).first_in_at == event.effective_time
    assert await exceptions(db, scene.user.id) == []  # borderline is not an exception


# --- anti-fraud -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("flag", "code", "kind"),
    [
        ("mocked", "MOCK_LOCATION", "MOCK_LOCATION"),
        ("emulator", "DEVICE_NOT_TRUSTED", "EMULATOR"),
        ("rooted", "DEVICE_NOT_TRUSTED", "ROOTED_DEVICE"),
    ],
)
async def test_a_mock_location_emulator_or_rooted_phone_is_blocked_and_logged(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, flag: str, code: str, kind: str
) -> None:
    response = await send(
        client, scene.headers, "punch-in", await at_branch(db, scene), **{flag: True}
    )
    assert (response.status_code, error_code(response)) == (403, code)
    assert await exceptions(db, scene.user.id) == [kind]
    assert await events(db, scene.user.id) == []


async def test_the_development_switch_allows_a_mock_punch_but_flags_it(
    db: AsyncSession, scene: Scene
) -> None:
    allowed = get_settings().model_copy(
        update={"app_env": "development", "allow_mock_location": True}
    )
    async with running_client(allowed, db, unique_ip()) as dev:
        where = await at_branch(db, scene)
        response = await send(dev, scene.headers, "punch-in", where, mocked=True)
    assert response.status_code == 201, response.text
    [event] = await events(db, scene.user.id)
    assert event.integrity_flags == ["mock"]
    assert response.json()["day"]["flags"] == ["mock"]
    assert await exceptions(db, scene.user.id) == ["MOCK_LOCATION"]


async def test_the_switch_does_nothing_outside_development(db: AsyncSession, scene: Scene) -> None:
    settings = get_settings().model_copy(update={"app_env": "test", "allow_mock_location": True})
    async with running_client(settings, db, unique_ip()) as client:
        response = await send(
            client, scene.headers, "punch-in", await at_branch(db, scene), mocked=True
        )
    assert (response.status_code, error_code(response)) == (403, "MOCK_LOCATION")


async def test_an_impossible_jump_from_the_last_punch_is_flagged_not_blocked(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    far = await make_branch(db, "Far Office", lat=21.5, lng=86.9)  # about 160 km away
    clock.at(10, 5)
    assert (
        await send(client, scene.headers, "punch-in", await at_branch(db, scene))
    ).status_code == 201
    clock.at(10, 15)  # 160 km in ten minutes
    out_there = await point_at(db, far, 5)
    response = await send(client, scene.headers, "punch-out", out_there)
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["result"] == "in_review"
    assert "jump" in body["day"]["flags"]
    assert "IMPOSSIBLE_JUMP" in await exceptions(db, scene.user.id)
    assert (await events(db, scene.user.id))[-1].review_reasons == ["impossible_jump"]


async def test_a_normal_drive_between_branches_is_not_flagged(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    near = await make_branch(db, "Near Office", lat=20.3961, lng=85.8245)  # about 11 km
    clock.at(10, 5)
    await send(client, scene.headers, "punch-in", await at_branch(db, scene))
    clock.at(12, 0)
    response = await send(client, scene.headers, "punch-out", await point_at(db, near, 5))
    assert response.json()["result"] == "verified"


# --- punch out --------------------------------------------------------------------------------


async def test_punch_out_needs_a_punch_in(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    response = await send(client, scene.headers, "punch-out", await at_branch(db, scene))
    assert (response.status_code, error_code(response)) == (409, "NOT_PUNCHED_IN")


async def test_only_one_punch_out_a_day(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    where = await at_branch(db, scene)
    await send(client, scene.headers, "punch-in", where)
    clock.at(18, 0)
    assert (await send(client, scene.headers, "punch-out", where)).status_code == 201
    again = await send(client, scene.headers, "punch-out", where)
    assert (again.status_code, error_code(again)) == (409, "ALREADY_PUNCHED_OUT")


async def test_punch_out_from_outside_the_fence_is_refused_here(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    await send(client, scene.headers, "punch-in", await at_branch(db, scene))
    away = await point_at(db, scene.branch, 800)
    response = await send(client, scene.headers, "punch-out", away)
    assert (response.status_code, error_code(response)) == (422, "OUTSIDE_GEOFENCE")


async def test_a_holiday_added_after_punching_in_does_not_trap_the_person(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    from tests.modules.schedule.test_schedule import add_holiday

    where = await at_branch(db, scene)
    await send(client, scene.headers, "punch-in", where)
    await add_holiday(db, MONDAY)
    clock.at(18, 0)
    assert (await send(client, scene.headers, "punch-out", where)).status_code == 201


async def test_hours_stay_at_zero_until_the_out_of_office_request_is_approved(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    where = await at_branch(db, scene)
    await send(client, scene.headers, "punch-in", where)
    clock.at(17, 30)
    away = await point_at(db, scene.branch, 3000)
    response = await send(
        client, scene.headers, "punch-out-requests", away, reason="Task finished at the client site"
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["result"] == "in_review"
    assert body["punch"]["out_of_office"] is True
    assert body["punch"]["place"] == {
        "type": "outside",
        "branch": scene.branch.name,
        "distance_m": 3000,
    }
    assert (body["day"]["status"], body["day"]["worked_minutes"]) == ("pending", 0)
    assert body["day"]["last_out_at"] is None
    again = await send(client, scene.headers, "punch-out", where)
    assert (again.status_code, error_code(again)) == (409, "ALREADY_PUNCHED_OUT")
    assert "waiting for approval" in again.json()["error"]["message"]


async def test_a_request_from_a_work_location_must_be_a_normal_punch_out(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    where = await at_branch(db, scene)
    await send(client, scene.headers, "punch-in", where)
    response = await send(client, scene.headers, "punch-out-requests", where, reason="Going home")
    assert (response.status_code, error_code(response)) == (409, "USE_PUNCH_OUT")


@pytest.mark.parametrize("fields", [{}, {"reason": ""}, {"reason": "ab"}, {"reason": "x" * 201}])
async def test_a_request_needs_a_reason(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, fields: dict[str, str]
) -> None:
    await send(client, scene.headers, "punch-in", await at_branch(db, scene))
    away = await point_at(db, scene.branch, 3000)
    response = await send(client, scene.headers, "punch-out-requests", away, **fields)
    assert (response.status_code, error_code(response)) == (422, "VALIDATION_ERROR")


# --- home day ---------------------------------------------------------------------------------


async def test_a_home_punch_is_stored_but_the_place_is_never_shown(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    await add_schedule(db, scene.user, dt.date(2027, 1, 1), ["home"] * 7)
    await add_home(db, scene.user)
    response = await send(client, scene.headers, "punch-in", HOME)
    assert response.status_code == 201, response.text
    assert response.json()["punch"]["place"] == {"type": "home", "branch": None, "distance_m": None}
    [event] = await events(db, scene.user.id)
    assert (event.location_type, event.branch_id) == ("home", None)
    today = (await client.get(f"{A}/today", headers=scene.headers)).text
    for text in (response.text, today):
        assert str(HOME["lat"]) not in text and str(HOME["lng"]) not in text
        assert '"lat"' not in text and '"lng"' not in text


# --- offline ----------------------------------------------------------------------------------


async def test_an_offline_punch_counts_at_receipt_and_waits_for_review(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    clock.at(10, 40)
    taken = ist(10, 20).isoformat()
    response = await send(
        client,
        scene.headers,
        "punch-in",
        await at_branch(db, scene),
        offline=True,
        device_time=taken,
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["result"] == "in_review" and body["punch"]["offline"] is True
    assert body["day"]["flags"] == ["offline"]
    [event] = await events(db, scene.user.id)
    assert event.effective_time == ist(10, 40)  # receipt time: the phone's clock is not trusted
    assert event.device_time == ist(10, 20)
    assert event.review_reasons == ["offline"]


async def test_a_device_time_must_carry_its_time_zone(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    response = await send(
        client,
        scene.headers,
        "punch-in",
        await at_branch(db, scene),
        offline=True,
        device_time="2027-03-01T10:20:00",
    )
    assert (response.status_code, error_code(response)) == (422, "VALIDATION_ERROR")


async def test_an_offline_punch_needs_the_time_it_was_taken(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    response = await send(
        client, scene.headers, "punch-in", await at_branch(db, scene), offline=True
    )
    assert (response.status_code, error_code(response)) == (422, "OFFLINE_TIME_MISSING")


async def test_an_offline_punch_older_than_the_limit_is_refused(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    clock.at(23, 0)
    taken = ist(9, 30).isoformat()  # 13.5 h earlier, the limit is 12
    response = await send(
        client,
        scene.headers,
        "punch-in",
        await at_branch(db, scene),
        offline=True,
        device_time=taken,
    )
    assert (response.status_code, error_code(response)) == (409, "OFFLINE_PUNCH_TOO_OLD")


async def test_an_offline_punch_from_yesterday_is_refused_even_if_recent(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    clock.at(0, 10)
    taken = ist(23, 50, day=dt.date(2027, 2, 28)).isoformat()  # 20 minutes earlier, other IST day
    response = await send(
        client,
        scene.headers,
        "punch-in",
        await at_branch(db, scene),
        offline=True,
        device_time=taken,
    )
    assert (response.status_code, error_code(response)) == (409, "OFFLINE_PUNCH_TOO_OLD")


async def test_queued_punches_replay_in_order_and_out_of_order_is_refused(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    where = await at_branch(db, scene)
    clock.at(18, 5)
    taken_out = ist(18, 0).isoformat()
    first = await send(
        client, scene.headers, "punch-out", where, offline=True, device_time=taken_out
    )
    assert (first.status_code, error_code(first)) == (409, "NOT_PUNCHED_IN")
    taken_in = ist(10, 0).isoformat()
    clock.at(17, 59)
    assert (
        await send(client, scene.headers, "punch-in", where, offline=True, device_time=taken_in)
    ).status_code == 201
    clock.at(18, 5)
    assert (
        await send(client, scene.headers, "punch-out", where, offline=True, device_time=taken_out)
    ).status_code == 201


# --- today and precheck -----------------------------------------------------------------------


async def test_today_follows_the_day(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    where = await at_branch(db, scene)
    first = (await client.get(f"{A}/today", headers=scene.headers)).json()
    assert (first["action"], first["blocked"], first["kind"]) == ("punch_in", None, "office")
    assert first["shift"] == "General" and first["day"] is None and first["minutes_so_far"] is None
    await send(client, scene.headers, "punch-in", where)
    clock.at(12, 35)
    mid = (await client.get(f"{A}/today", headers=scene.headers)).json()
    assert (mid["action"], mid["minutes_so_far"]) == ("punch_out", 150)
    assert [p["type"] for p in mid["punches"]] == ["in"]
    clock.at(18, 0)
    await send(client, scene.headers, "punch-out", where)
    done = (await client.get(f"{A}/today", headers=scene.headers)).json()
    assert (done["action"], done["blocked"]) == ("none", "done")
    assert done["day"]["status"] == "present"


async def test_today_says_why_nothing_can_be_done(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    clock.at(10, 0, day=SUNDAY)
    assert (await client.get(f"{A}/today", headers=scene.headers)).json()["blocked"] == "off_day"
    clock.at(23, 59, 30)
    assert (await client.get(f"{A}/today", headers=scene.headers)).json()["blocked"] == "day_closed"
    clock.at(10, 0)
    scene.user.shift_id = None
    await db.flush()
    await db.refresh(scene.user)
    assert (await client.get(f"{A}/today", headers=scene.headers)).json()["blocked"] == "no_shift"
    user = await make_user(db, shift_id=scene.shift.id)
    headers = await auth_headers(client, user, kind="mobile", device_info=device(7))
    assert (await client.get(f"{A}/today", headers=headers)).json()[
        "blocked"
    ] == "face_not_approved"


async def test_precheck_says_how_far_before_the_camera_opens(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    near = await client.post(
        f"{A}/precheck",
        json={**await at_branch(db, scene, 40), "accuracy_m": 8},
        headers=scene.headers,
    )
    assert near.json() | {"details": None} == {
        "allowed": True,
        "action": "punch_in",
        "place": {"type": "branch", "branch": scene.branch.name, "distance_m": 40},
        "nearest_branch": scene.branch.name,
        "distance_m": 40,
        "code": None,
        "message": None,
        "details": None,
    }
    far = (
        await client.post(
            f"{A}/precheck",
            json={**await point_at(db, scene.branch, 700), "accuracy_m": 8},
            headers=scene.headers,
        )
    ).json()
    assert (far["allowed"], far["code"], far["distance_m"]) == (False, "OUTSIDE_GEOFENCE", 700)
    assert far["nearest_branch"] == scene.branch.name
    assert f"700 m from {scene.branch.name}" in far["message"]
    # Nothing was stored by looking.
    assert (await db.scalar(select(func.count()).select_from(AttendanceDay))) == 0
    assert await exceptions(db, scene.user.id) == []


async def test_precheck_turns_a_punch_out_from_outside_into_a_request(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    await send(client, scene.headers, "punch-in", await at_branch(db, scene))
    inside = await client.post(
        f"{A}/precheck",
        json={**await at_branch(db, scene, 20), "accuracy_m": 5},
        headers=scene.headers,
    )
    assert (inside.json()["allowed"], inside.json()["action"]) == (True, "punch_out")
    outside = (
        await client.post(
            f"{A}/precheck",
            json={**await point_at(db, scene.branch, 900), "accuracy_m": 5},
            headers=scene.headers,
        )
    ).json()
    assert (outside["allowed"], outside["action"]) == (True, "request_punch_out")
    assert outside["place"] == {"type": "outside", "branch": scene.branch.name, "distance_m": 900}


async def test_precheck_on_a_poor_fix_and_on_a_day_off(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    poor = (
        await client.post(
            f"{A}/precheck",
            json={**await at_branch(db, scene), "accuracy_m": 90},
            headers=scene.headers,
        )
    ).json()
    assert (poor["allowed"], poor["code"]) == (False, "GPS_ACCURACY_POOR")
    clock.at(10, 0, day=SUNDAY)
    off = (
        await client.post(
            f"{A}/precheck",
            json={**await at_branch(db, scene), "accuracy_m": 5},
            headers=scene.headers,
        )
    ).json()
    assert (off["allowed"], off["code"]) == (False, "OFF_DAY")


async def test_precheck_on_a_home_day_names_no_place(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    await add_schedule(db, scene.user, dt.date(2027, 1, 1), ["home"] * 7)
    await add_home(db, scene.user)
    body = (
        await client.post(f"{A}/precheck", json={**HOME, "accuracy_m": 5}, headers=scene.headers)
    ).json()
    assert body["allowed"] is True
    assert body["place"] == {"type": "home", "branch": None, "distance_m": None}
    assert body["nearest_branch"] is None and body["distance_m"] is None
