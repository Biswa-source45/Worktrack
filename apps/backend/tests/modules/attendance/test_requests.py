"""Out-of-office punch-out requests and their approval (SRS 4.6, FR-PO-03, FR-PO-04, BR-07)."""

import datetime as dt
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.attendance.models import AttendanceDay, PunchEvent, PunchOutRequest
from tests.factories import ASSIGNER, SUPER_ADMIN, make_branch
from tests.modules.attendance.conftest import MONDAY, Clock, Headers, Scene, employee, ist
from tests.modules.attendance.test_punch import A, at_branch, events, send, today_row
from tests.modules.branches.test_geofence import point_at
from tests.modules.employees.helpers import API, actor, audit_rows, error_code

REQUESTS = f"{API}/admin/punch-out-requests"
SETTINGS = f"{API}/admin/settings"


async def request_out(
    client: httpx.AsyncClient,
    db: AsyncSession,
    scene: Scene,
    clock: Clock,
    *,
    out_at: tuple[int, int] = (18, 0),
    headers: Headers | None = None,
) -> int:
    """Punch in at 10:05 at the branch, then ask to punch out from 3 km away; returns request id."""
    who = headers or scene.headers
    clock.at(10, 5)
    assert (await send(client, who, "punch-in", await at_branch(db, scene))).status_code == 201
    clock.at(*out_at)
    away = await point_at(db, scene.branch, 3000)
    response = await send(client, who, "punch-out-requests", away, reason="Client site, then home")
    assert response.status_code == 201, response.text
    return int(
        (await db.execute(select(PunchOutRequest.id).order_by(PunchOutRequest.id.desc())))
        .scalars()
        .first()  # type: ignore[arg-type]
    )


async def decide(
    client: httpx.AsyncClient, headers: Headers, request_id: int, **body: Any
) -> httpx.Response:
    payload = {"decision": "approve", **body}
    return await client.patch(f"{REQUESTS}/{request_id}/decision", json=payload, headers=headers)


async def request_row(db: AsyncSession, request_id: int) -> PunchOutRequest:
    return (
        await db.execute(
            select(PunchOutRequest)
            .where(PunchOutRequest.id == request_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()


# --- who sees it ------------------------------------------------------------------------------


async def test_the_reporting_manager_and_admins_see_the_request_but_other_managers_do_not(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    manager, manager_headers = await employee(client, db, scene, 2, role=ASSIGNER)
    scene.user.manager_id = manager.id
    await db.flush()
    _, stranger_headers = await employee(client, db, scene, 3, role=ASSIGNER)
    request_id = await request_out(client, db, scene, clock)

    for headers in (manager_headers, scene.admin):
        listed = (await client.get(REQUESTS, headers=headers)).json()["items"]
        assert [i["id"] for i in listed] == [request_id]
        assert listed[0]["employee"]["id"] == scene.user.id
        assert listed[0]["status"] == "pending" and listed[0]["reason"] == "Client site, then home"
    assert (await client.get(REQUESTS, headers=stranger_headers)).json()["items"] == []
    # Out of scope looks like it does not exist.
    for call in (
        client.get(f"{REQUESTS}/{request_id}", headers=stranger_headers),
        decide(client, stranger_headers, request_id),
    ):
        response = await call
        assert (response.status_code, error_code(response)) == (404, "NOT_FOUND")
    # An employee without the permission is refused outright.
    assert (await client.get(REQUESTS, headers=scene.headers)).status_code == 403


async def test_the_approver_sees_where_who_and_the_face_result(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    request_id = await request_out(client, db, scene, clock)
    response = await client.get(f"{REQUESTS}/{request_id}", headers=scene.admin)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["employee"]["id"] == scene.user.id
    assert (body["status"], body["can_decide"], body["final_by_admin"]) == ("pending", True, False)
    assert body["nearest_branch"] == scene.branch.name and body["distance_m"] == 3000
    assert (body["face_decision"], body["offline"]) == ("VERIFIED", False)
    assert 0.3 < body["face_score"] <= 1.001  # float32 rounding: 1.0000001 on Linux
    # The map pin: the only place coordinates are returned.
    assert abs(body["lat"] - 20.2961) < 0.1 and abs(body["lng"] - 85.8245) < 0.1
    assert dt.datetime.fromisoformat(body["punched_in_at"]) == ist(10, 5)
    selfie = await client.get(body["selfie_url"])
    assert (selfie.status_code, selfie.headers["content-type"]) == (200, "image/jpeg")
    assert len(await audit_rows(db, "punch_out_request.view")) == 1


# --- approving --------------------------------------------------------------------------------


async def test_approving_counts_the_hours_and_keeps_the_original_record(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    request_id = await request_out(client, db, scene, clock, out_at=(18, 0))
    assert (await today_row(db, scene.user.id)).status == "pending"
    response = await decide(client, scene.admin, request_id, remarks="Ok")
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "approved"
    day = await today_row(db, scene.user.id)
    assert (day.status, day.worked_minutes, day.late_minutes) == ("present", 475, 0)
    assert day.last_out_at == ist(18, 0)
    out = (await events(db, scene.user.id))[-1]
    assert (out.review_status, out.reviewed_by) == ("approved", (await actor_id(db, scene.admin)))
    row = await request_row(db, request_id)
    assert (row.status, row.approved_time, row.remarks) == ("approved", ist(18, 0), "Ok")
    audit = (await audit_rows(db, "punch_out_request.approve"))[-1]
    assert audit.after is not None and audit.after["day_status"] == "present"
    # The employee's Home sees the outcome.
    today = (await client.get(f"{A}/today", headers=scene.headers)).json()
    assert (today["action"], today["blocked"]) == ("none", "done")


async def actor_id(db: AsyncSession, headers: Headers) -> int:
    from app.core.config import get_settings
    from app.core.security import decode_access_token

    claims = decode_access_token(get_settings(), headers["Authorization"].split()[1])
    assert claims is not None
    return int(claims["sub"])


async def test_approving_with_an_edited_time_uses_it_and_keeps_the_server_time(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    request_id = await request_out(client, db, scene, clock, out_at=(18, 0))
    response = await decide(client, scene.admin, request_id, approved_time=ist(17, 0).isoformat())
    assert response.status_code == 200, response.text
    day = await today_row(db, scene.user.id)
    assert (day.status, day.worked_minutes, day.last_out_at) == ("half_day", 415, ist(17, 0))
    out = (await events(db, scene.user.id))[-1]
    assert out.effective_time == ist(17, 0)
    assert out.server_time == ist(18, 0)  # what the server saw is never overwritten
    audit = (await audit_rows(db, "punch_out_request.approve"))[-1]
    assert audit.before is not None and audit.before["approved_time"] == ist(18, 0).isoformat()


async def test_an_edited_time_must_be_sensible(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    request_id = await request_out(client, db, scene, clock, out_at=(18, 0))
    for bad in (
        ist(9, 0).isoformat(),  # before the punch-in
        ist(19, 0).isoformat(),  # in the future
        ist(17, 0, day=dt.date(2027, 2, 28)).isoformat(),  # another day
        "2027-03-01T17:00:00",  # no time zone
    ):
        response = await decide(client, scene.admin, request_id, approved_time=bad)
        assert (response.status_code, error_code(response)) == (422, "INVALID_TIME"), bad
    assert (await request_row(db, request_id)).status == "pending"


# --- rejecting --------------------------------------------------------------------------------


async def test_rejecting_needs_a_reason_and_frees_the_employee_to_punch_out_again(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    request_id = await request_out(client, db, scene, clock, out_at=(17, 0))
    missing = await decide(client, scene.admin, request_id, decision="reject")
    assert (missing.status_code, error_code(missing)) == (422, "REMARKS_REQUIRED")
    response = await decide(
        client, scene.admin, request_id, decision="reject", remarks="Not at a site"
    )
    assert response.json()["status"] == "rejected"
    day = await today_row(db, scene.user.id)
    assert (day.status, day.worked_minutes, day.last_out_at) == ("working", 0, None)
    assert (await events(db, scene.user.id))[-1].review_status == "rejected"
    # Back at the office the same evening, a normal punch-out works.
    clock.at(18, 0)
    assert (
        await send(client, scene.headers, "punch-out", await at_branch(db, scene))
    ).status_code == 201
    assert (await today_row(db, scene.user.id)).status == "present"


async def test_a_decision_is_final_and_one_cannot_decide_ones_own(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    request_id = await request_out(client, db, scene, clock)
    assert (await decide(client, scene.admin, request_id)).status_code == 200
    again = await decide(client, scene.admin, request_id, decision="reject", remarks="x")
    assert (again.status_code, error_code(again)) == (409, "ALREADY_DECIDED")


async def test_nobody_decides_their_own_request(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    _, boss_headers = await employee(client, db, scene, 2, "b", role=SUPER_ADMIN)
    clock.at(10, 5)
    where = await at_branch(db, scene)
    from tests.modules.face import images

    selfie = images.same_person("b", 1)
    await send(client, boss_headers, "punch-in", where, selfie=selfie)
    clock.at(18, 0)
    away = await point_at(db, scene.branch, 3000)
    await send(
        client, boss_headers, "punch-out-requests", away, reason="At the client", selfie=selfie
    )
    request_id = int((await db.scalar(select(PunchOutRequest.id))) or 0)
    response = await decide(client, boss_headers, request_id)
    assert (response.status_code, error_code(response)) == (403, "CANNOT_DECIDE_OWN")
    detail = (await client.get(f"{REQUESTS}/{request_id}", headers=boss_headers)).json()
    assert detail["can_decide"] is False
    assert (await decide(client, scene.admin, request_id)).status_code == 200


# --- two levels -------------------------------------------------------------------------------


async def two_levels(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, super_admin = await actor(client, db, SUPER_ADMIN)
    response = await client.patch(
        SETTINGS, json={"punch_out_approval_levels": 2}, headers=super_admin
    )
    assert response.status_code == 200, response.text


async def test_with_two_levels_the_manager_passes_it_on_and_an_admin_decides(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    await two_levels(client, db)
    manager, manager_headers = await employee(client, db, scene, 2, role=ASSIGNER)
    scene.user.manager_id = manager.id
    await db.flush()
    request_id = await request_out(client, db, scene, clock)

    # The manager may not edit the time at the first level.
    edit = await decide(client, manager_headers, request_id, approved_time=ist(17, 0).isoformat())
    assert (edit.status_code, error_code(edit)) == (422, "INVALID_TIME")
    first = await decide(client, manager_headers, request_id)
    assert first.json()["status"] == "pending_admin"
    assert (await today_row(db, scene.user.id)).status == "pending"
    again = await decide(client, manager_headers, request_id)
    assert (again.status_code, error_code(again)) == (403, "ADMIN_ONLY")
    # It left the manager's queue and sits in the admin's.
    assert (await client.get(REQUESTS, headers=manager_headers)).json()["items"] == []
    waiting = (await client.get(REQUESTS, headers=scene.admin)).json()["items"]
    assert [(i["id"], i["status"]) for i in waiting] == [(request_id, "pending_admin")]

    final = await decide(client, scene.admin, request_id)
    assert final.json()["status"] == "approved"
    assert (await today_row(db, scene.user.id)).status == "present"
    row = await request_row(db, request_id)
    assert row.first_approver_id == manager.id and row.approver_id != manager.id


async def test_with_two_levels_an_admin_may_decide_at_the_first_stage(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    await two_levels(client, db)
    request_id = await request_out(client, db, scene, clock)
    assert (await decide(client, scene.admin, request_id)).json()["status"] == "approved"


async def test_a_manager_rejection_at_the_first_level_is_final(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    await two_levels(client, db)
    manager, manager_headers = await employee(client, db, scene, 2, role=ASSIGNER)
    scene.user.manager_id = manager.id
    await db.flush()
    request_id = await request_out(client, db, scene, clock)
    response = await decide(client, manager_headers, request_id, decision="reject", remarks="No")
    assert response.json()["status"] == "rejected"


# --- expiry (BR-07) ----------------------------------------------------------------------------


async def test_an_expired_request_can_still_be_approved_by_an_admin_but_not_a_manager(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    manager, manager_headers = await employee(client, db, scene, 2, role=ASSIGNER)
    scene.user.manager_id = manager.id
    await db.flush()
    request_id = await request_out(client, db, scene, clock)
    (await request_row(db, request_id)).status = "expired"
    await db.flush()
    refused = await decide(client, manager_headers, request_id)
    assert (refused.status_code, error_code(refused)) == (403, "ADMIN_ONLY")
    assert (await client.get(REQUESTS, headers=scene.admin)).json()["items"] == []  # not waiting
    expired = (await client.get(REQUESTS, params={"status": "expired"}, headers=scene.admin)).json()
    assert [i["id"] for i in expired["items"]] == [request_id]
    clock.at(18, 30)
    response = await decide(client, scene.admin, request_id)
    assert response.json()["status"] == "approved"
    assert (await today_row(db, scene.user.id)).status == "present"


async def test_decided_requests_are_listed_newest_first_with_a_cursor(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    first = await request_out(client, db, scene, clock)
    await decide(client, scene.admin, first, decision="reject", remarks="No")
    clock.at(18, 5)
    away = await point_at(db, scene.branch, 3000)
    await send(client, scene.headers, "punch-out-requests", away, reason="Again, at the site")
    second = int(
        (await db.scalar(select(PunchOutRequest.id).order_by(PunchOutRequest.id.desc()))) or 0
    )
    await decide(client, scene.admin, second, decision="reject", remarks="Still no")
    page = (
        await client.get(REQUESTS, params={"status": "rejected", "limit": 1}, headers=scene.admin)
    ).json()
    assert [i["id"] for i in page["items"]] == [second] and page["next_cursor"] == str(second)
    rest = (
        await client.get(
            REQUESTS,
            params={"status": "rejected", "limit": 1, "cursor": page["next_cursor"]},
            headers=scene.admin,
        )
    ).json()
    assert [i["id"] for i in rest["items"]] == [first] and rest["next_cursor"] is None


async def test_the_request_of_a_closed_day_still_counts_when_approved(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    request_id = await request_out(client, db, scene, clock, out_at=(18, 0))
    clock.at(9, 0, day=MONDAY + dt.timedelta(days=1))  # next morning; Monday is closed
    response = await decide(client, scene.admin, request_id, approved_time=ist(18, 0).isoformat())
    assert response.status_code == 200, response.text
    day = (
        await db.execute(
            select(AttendanceDay)
            .where(AttendanceDay.user_id == scene.user.id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert (day.status, day.worked_minutes) == ("present", 475)


async def test_an_outside_punch_remembers_the_nearest_branch(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    await make_branch(db, "Another", lat=10.0, lng=70.0)  # far away: not the nearest
    request_id = await request_out(client, db, scene, clock)
    out: PunchEvent = (await events(db, scene.user.id))[-1]
    assert out.nearest_branch_id == scene.branch.id
    assert (await client.get(f"{REQUESTS}/{request_id}", headers=scene.admin)).status_code == 200
