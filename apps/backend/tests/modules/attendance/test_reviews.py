"""The punch review queue: face borderline or mismatch, offline and impossible-jump punches."""

import datetime as dt
from typing import Any

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from tests.factories import ADMIN, ASSIGNER, SUPER_ADMIN
from tests.modules.attendance.conftest import Clock, Headers, Scene, employee, ist
from tests.modules.attendance.test_punch import at_branch, events, send, today_row
from tests.modules.branches.test_geofence import point_at
from tests.modules.employees.helpers import API, audit_rows, error_code
from tests.modules.face import images

QUEUE = f"{API}/admin/punch-reviews"
STRANGER = images.same_person("b", 1)  # not the enrolled person (a): a MISMATCH


async def mismatch_in(client: httpx.AsyncClient, db: AsyncSession, scene: Scene) -> int:
    """The employee punches in with someone else's face; returns the punch id."""
    response = await send(
        client, scene.headers, "punch-in", await at_branch(db, scene), selfie=STRANGER
    )
    assert response.status_code == 201 and response.json()["result"] == "in_review"
    return response.json()["punch"]["id"]


async def decide(
    client: httpx.AsyncClient,
    headers: Headers,
    event_id: int,
    decision: str = "approve",
    **body: Any,
) -> httpx.Response:
    return await client.post(
        f"{QUEUE}/{event_id}/decision", json={"decision": decision, **body}, headers=headers
    )


async def test_a_mismatch_waits_in_the_queue_for_a_reviewer_and_only_one(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    event_id = await mismatch_in(client, db, scene)
    listed = (await client.get(QUEUE, headers=scene.admin)).json()["items"]
    assert [i["id"] for i in listed] == [event_id]
    item = listed[0]
    assert (item["employee"]["id"], item["type"], item["face_decision"]) == (
        scene.user.id,
        "in",
        "MISMATCH",
    )
    assert item["review_reasons"] == ["face_mismatch"] and item["face_score"] < 0.3
    # The employee and a manager (no face.review) are refused.
    _, manager = await employee(client, scene=scene, db=db, n=2, role=ASSIGNER)
    for headers in (scene.headers, manager):
        assert (await client.get(QUEUE, headers=headers)).status_code == 403


async def test_the_reviewer_sees_the_selfie_and_the_look_is_audited(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    event_id = await mismatch_in(client, db, scene)
    detail = (await client.get(f"{QUEUE}/{event_id}", headers=scene.admin)).json()
    assert detail["can_decide"] is True
    assert detail["thresholds"] == {"verify": 0.4, "review": 0.3}
    assert detail["place"]["branch"] == scene.branch.name
    selfie = await client.get(detail["selfie_url"])
    assert (selfie.status_code, selfie.headers["content-type"]) == (200, "image/jpeg")
    assert len(await audit_rows(db, "punch_event.view")) == 1


async def test_approving_keeps_the_punch_and_clears_the_review_flag(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    event_id = await mismatch_in(client, db, scene)
    assert (await today_row(db, scene.user.id)).flags == ["face_review"]
    response = await decide(client, scene.admin, event_id, remarks="Known colleague, new glasses")
    assert response.status_code == 200, response.text
    assert response.json()["review_status"] == "approved"
    day = await today_row(db, scene.user.id)
    assert (day.status, day.flags) == ("working", [])
    assert day.first_in_at == ist(10, 5)
    assert (await client.get(QUEUE, headers=scene.admin)).json()["items"] == []
    approved = (await client.get(QUEUE, params={"status": "approved"}, headers=scene.admin)).json()
    assert [i["id"] for i in approved["items"]] == [event_id]
    audit = (await audit_rows(db, "punch_review.approve"))[-1]
    assert audit.before is not None and audit.before["review_status"] == "pending"
    assert audit.after is not None and audit.after["remarks"] == "Known colleague, new glasses"


async def test_a_rejected_punch_does_not_count_and_the_employee_can_punch_in_again(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    event_id = await mismatch_in(client, db, scene)
    missing = await decide(client, scene.admin, event_id, "reject")
    assert (missing.status_code, error_code(missing)) == (422, "REMARKS_REQUIRED")
    assert (
        await decide(client, scene.admin, event_id, "reject", remarks="Not the employee")
    ).status_code == 200
    day = await today_row(db, scene.user.id)
    assert (day.status, day.first_in_at, day.worked_minutes) == ("absent", None, 0)
    clock.at(10, 30)
    again = await send(client, scene.headers, "punch-in", await at_branch(db, scene))
    assert again.status_code == 201 and again.json()["result"] == "verified"
    day = await today_row(db, scene.user.id)
    assert (day.status, day.first_in_at, day.late_minutes) == ("working", ist(10, 30), 30)
    assert len(await events(db, scene.user.id)) == 2  # the rejected one stays as history


async def test_a_decision_is_final(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    event_id = await mismatch_in(client, db, scene)
    await decide(client, scene.admin, event_id)
    again = await decide(client, scene.admin, event_id, "reject", remarks="x")
    assert (again.status_code, error_code(again)) == (409, "ALREADY_DECIDED")


async def test_nobody_reviews_their_own_punch(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    _, boss = await employee(client, db, scene, 2, "b", role=ADMIN)
    response = await send(
        client, boss, "punch-in", await at_branch(db, scene), selfie=images.same_person("c", 1)
    )
    event_id = response.json()["punch"]["id"]
    refused = await decide(client, boss, event_id)
    assert (refused.status_code, error_code(refused)) == (403, "CANNOT_DECIDE_OWN")
    assert (await client.get(f"{QUEUE}/{event_id}", headers=boss)).json()["can_decide"] is False
    assert (await decide(client, scene.admin, event_id)).status_code == 200


async def test_a_reviewer_cannot_review_someone_with_more_access(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    _, top = await employee(client, db, scene, 2, "b", role=SUPER_ADMIN)
    response = await send(
        client, top, "punch-in", await at_branch(db, scene), selfie=images.same_person("c", 1)
    )
    event_id = response.json()["punch"]["id"]
    assert (await client.get(QUEUE, headers=scene.admin)).json()["items"] == []
    for call in (
        client.get(f"{QUEUE}/{event_id}", headers=scene.admin),
        decide(client, scene.admin, event_id),
    ):
        refused = await call
        assert (refused.status_code, error_code(refused)) == (403, "FORBIDDEN")


async def test_an_offline_punch_is_reviewed_and_the_time_can_be_edited(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    clock.at(10, 40)
    response = await send(
        client,
        scene.headers,
        "punch-in",
        await at_branch(db, scene),
        offline=True,
        device_time=ist(10, 20).isoformat(),
    )
    event_id = response.json()["punch"]["id"]
    item = (await client.get(QUEUE, params={"reason": "offline"}, headers=scene.admin)).json()[
        "items"
    ][0]
    assert (item["id"], item["offline"], item["face_decision"]) == (event_id, True, "VERIFIED")
    detail = (await client.get(f"{QUEUE}/{event_id}", headers=scene.admin)).json()
    assert dt.datetime.fromisoformat(detail["device_time"]) == ist(10, 20)
    assert dt.datetime.fromisoformat(detail["server_time"]) == ist(10, 40)
    # The reviewer accepts the time the phone said, within the same day and not in the future.
    for bad in (ist(10, 50).isoformat(), ist(9, 0, day=dt.date(2027, 2, 28)).isoformat()):
        refused = await decide(client, scene.admin, event_id, effective_time=bad)
        assert (refused.status_code, error_code(refused)) == (422, "INVALID_TIME")
    ok = await decide(client, scene.admin, event_id, effective_time=ist(10, 20).isoformat())
    assert ok.status_code == 200, ok.text
    day = await today_row(db, scene.user.id)
    # Approved, but it stays recorded as an offline punch.
    assert (day.first_in_at, day.late_minutes, day.flags) == (ist(10, 20), 20, ["offline"])


async def test_only_an_offline_punch_can_have_its_time_changed(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    event_id = await mismatch_in(client, db, scene)
    response = await decide(client, scene.admin, event_id, effective_time=ist(10, 0).isoformat())
    assert (response.status_code, error_code(response)) == (422, "INVALID_TIME")


async def test_out_of_office_requests_are_not_in_this_queue(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    where = await at_branch(db, scene)
    await send(client, scene.headers, "punch-in", where)
    clock.at(18, 0)
    away = await point_at(db, scene.branch, 3000)
    response = await send(
        client, scene.headers, "punch-out-requests", away, reason="At the client site"
    )
    event_id = response.json()["punch"]["id"]
    assert (await client.get(QUEUE, headers=scene.admin)).json()["items"] == []
    assert (await client.get(f"{QUEUE}/{event_id}", headers=scene.admin)).status_code == 404
    assert (await decide(client, scene.admin, event_id)).status_code == 404


async def test_the_queue_filters_by_reason_and_pages(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    far_event = await mismatch_in(client, db, scene)
    clock.at(10, 15)
    other, other_headers = await employee(client, db, scene, 2, "b")
    got = await send(
        client,
        other_headers,
        "punch-in",
        await at_branch(db, scene),
        selfie=images.same_person("c", 1),
    )
    second = got.json()["punch"]["id"]
    both = (await client.get(QUEUE, params={"limit": 1}, headers=scene.admin)).json()
    assert [i["id"] for i in both["items"]] == [far_event] and both["next_cursor"] == str(far_event)
    rest = (
        await client.get(
            QUEUE, params={"limit": 1, "cursor": both["next_cursor"]}, headers=scene.admin
        )
    ).json()
    assert [i["id"] for i in rest["items"]] == [second]
    assert (await client.get(QUEUE, params={"reason": "offline"}, headers=scene.admin)).json()[
        "items"
    ] == []
    assert other.id != scene.user.id
