"""Face enrollment: consent, three checked photos, an admin's decision, reset (SRS 4.3, 9.7).

The face is personal data: much of this file checks where the photos, their storage keys and the
template do NOT appear.
"""

import json
from typing import Any

import httpx
import numpy as np
import pytest
from botocore.exceptions import ClientError
from cryptography.exceptions import InvalidTag
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import crypto
from app.core.errors import AppError
from app.modules.auth.permissions import FACE_REVIEW
from app.modules.employees.models import User
from app.modules.face import service
from app.modules.face.models import FaceEnrollment
from app.modules.face.provider import Decision, Issue
from app.modules.org_settings.models import Setting
from tests.factories import ADMIN, FIELD, auth_headers, device, headers_with, make_user
from tests.modules.employees.helpers import API, actor, audit_rows, error_code
from tests.modules.face import images

MINE = f"{API}/me/face-enrollment"
CONSENT = f"{MINE}/consent"
QUEUE = f"{API}/admin/face-enrollments"
Headers = dict[str, str]


def _state(client: httpx.AsyncClient) -> Any:
    transport = client._transport
    assert isinstance(transport, httpx.ASGITransport)
    return transport.app.state


def stored(client: httpx.AsyncClient, key: str) -> bool:
    state = _state(client)
    try:
        state.s3.head_object(Bucket=state.settings.s3_bucket, Key=key)
    except ClientError:
        return False
    return True


def good(name: str = "a") -> list[bytes]:
    return [images.photo(name), images.same_person(name, 1), images.same_person(name, 2)]


async def phone(client: httpx.AsyncClient, db: AsyncSession, n: int = 1) -> tuple[User, Headers]:
    """An employee signed in on their approved phone."""
    user = await make_user(db, FIELD)
    return user, await auth_headers(client, user, kind="mobile", device_info=device(n))


async def send(client: httpx.AsyncClient, headers: Headers, photos: list[bytes]) -> httpx.Response:
    files = [("photos", (f"{n}.jpg", data, "image/jpeg")) for n, data in enumerate(photos)]
    return await client.post(MINE, files=files, headers=headers)


async def rows(db: AsyncSession, user: User) -> list[FaceEnrollment]:
    result = await db.execute(
        select(FaceEnrollment)
        .where(FaceEnrollment.user_id == user.id)
        .order_by(FaceEnrollment.id)
        .execution_options(populate_existing=True)
    )
    return list(result.scalars())


async def enrolled(
    client: httpx.AsyncClient, db: AsyncSession, n: int = 1, name: str = "a"
) -> tuple[User, Headers, int]:
    """An employee with a pending enrollment; returns its id."""
    user, headers = await phone(client, db, n)
    assert (await client.post(CONSENT, headers=headers)).status_code == 201
    response = await send(client, headers, good(name))
    assert response.status_code == 201, response.text
    return user, headers, (await rows(db, user))[-1].id


async def approved(
    client: httpx.AsyncClient, db: AsyncSession, n: int = 1, name: str = "a"
) -> tuple[User, Headers, int, Headers]:
    user, headers, enrollment_id = await enrolled(client, db, n, name)
    _, admin = await actor(client, db, ADMIN)
    response = await client.post(f"{QUEUE}/{enrollment_id}/approve", headers=admin)
    assert response.status_code == 200
    return user, headers, enrollment_id, admin


def nothing_private(value: Any) -> bool:
    text = json.dumps(value, default=str)
    return not any(word in text for word in ("face/", "embedding", "image_keys", ".jpg"))


# --- consent ----------------------------------------------------------------------------------


async def test_nothing_exists_before_consent(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await phone(client, db)
    body = (await client.get(MINE, headers=headers)).json()
    assert body == {
        "status": "none",
        "consent_at": None,
        "submitted_at": None,
        "decided_at": None,
        "reason": None,
    }


async def test_photos_are_refused_until_the_notice_is_accepted(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user, headers = await phone(client, db)
    response = await send(client, headers, good())
    assert (response.status_code, error_code(response)) == (409, "CONSENT_REQUIRED")
    assert await rows(db, user) == []


async def test_consent_is_recorded_once_with_the_server_time(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user, headers = await phone(client, db)
    first = await client.post(CONSENT, headers=headers)
    assert first.status_code == 201
    assert first.json()["status"] == "consented"
    assert first.json()["consent_at"] is not None
    again = await client.post(CONSENT, headers=headers)
    assert again.json()["consent_at"] == first.json()["consent_at"]
    assert [row.status for row in await rows(db, user)] == ["consented"]
    audits = await audit_rows(db, "face_enrollment.consent")
    assert [(a.actor_id, a.after) for a in audits] == [
        (user.id, {"user_id": user.id, "status": "consented"})
    ]


# --- submitting -------------------------------------------------------------------------------


async def test_three_good_photos_become_a_pending_enrollment(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user, headers, _ = await enrolled(client, db)
    assert (await client.get(MINE, headers=headers)).json()["status"] == "pending"
    (row,) = await rows(db, user)
    assert row.status == "pending"
    assert row.submitted_at is not None
    assert row.model_version == "yunet-2023mar+sface-2021dec"
    assert row.quality is not None and len(row.quality) == 3
    assert row.consistency_score is not None and row.consistency_score >= 0.4
    assert row.image_keys is not None and len(row.image_keys) == 3
    assert all(key.startswith(f"face/{user.id}/") and stored(client, key) for key in row.image_keys)


async def test_the_template_is_stored_encrypted_and_bound_to_its_row(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user, _, _ = await enrolled(client, db)
    (row,) = await rows(db, user)
    assert row.embeddings is not None
    plain_size = 3 * 128 * 4
    assert len(row.embeddings) == crypto.NONCE_BYTES + plain_size + 16  # nonce, data, GCM tag
    template = service._unseal(row)
    assert template.shape == (3, 128)
    assert np.allclose(np.linalg.norm(template, axis=1), 1, atol=1e-5)
    assert template.astype("<f4").tobytes()[:64] not in row.embeddings
    # The same bytes on another person's row do not decrypt.
    other = FaceEnrollment(id=row.id, user_id=user.id + 1, embeddings=row.embeddings)
    with pytest.raises(InvalidTag):
        service._unseal(other)


async def test_the_stored_photos_are_small_jpegs_without_camera_data(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user, headers = await phone(client, db)
    await client.post(CONSENT, headers=headers)
    photos = [images.exif_rotated("a"), images.large("a"), images.same_person("a", 1)]
    assert (await send(client, headers, photos)).status_code == 201
    (row,) = await rows(db, user)
    state = _state(client)
    assert row.image_keys is not None
    for key in row.image_keys:
        data = state.s3.get_object(Bucket=state.settings.s3_bucket, Key=key)["Body"].read()
        assert data[:2] == b"\xff\xd8"
        assert b"Exif" not in data
        assert len(data) < 200_000


async def test_each_bad_photo_is_named_and_nothing_is_kept(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user, headers = await phone(client, db)
    await client.post(CONSENT, headers=headers)
    photos = [images.photo("a"), images.blurred("a"), images.empty_wall()]
    response = await send(client, headers, photos)
    assert (response.status_code, error_code(response)) == (422, "FACE_QUALITY")
    assert response.json()["error"]["details"] == {
        "photos": [
            {"index": 1, "code": Issue.BLURRY.value},
            {"index": 2, "code": Issue.NO_FACE.value},
        ]
    }
    (row,) = await rows(db, user)
    assert (row.status, row.embeddings, row.image_keys) == ("consented", None, None)
    state = _state(client)
    listed = state.s3.list_objects_v2(Bucket=state.settings.s3_bucket, Prefix=f"face/{user.id}/")
    assert listed.get("KeyCount", 0) == 0


async def test_photos_of_different_people_are_refused(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user, headers = await phone(client, db)
    await client.post(CONSENT, headers=headers)
    photos = [images.photo("a"), images.photo("b"), images.photo("c")]
    response = await send(client, headers, photos)
    assert (response.status_code, error_code(response)) == (422, "FACE_INCONSISTENT")
    assert [row.status for row in await rows(db, user)] == ["consented"]


async def test_the_quality_gates_are_the_ones_in_settings(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await phone(client, db)
    await client.post(CONSENT, headers=headers)
    db.add(Setting(key="face_min_face_px", value=400))
    await db.flush()
    response = await send(client, headers, good())
    assert error_code(response) == "FACE_QUALITY"
    codes = {photo["code"] for photo in response.json()["error"]["details"]["photos"]}
    assert codes == {Issue.FACE_TOO_SMALL.value}


@pytest.mark.parametrize("count", [1, 2, 4])
async def test_exactly_three_photos_are_needed(
    client: httpx.AsyncClient, db: AsyncSession, count: int
) -> None:
    _, headers = await phone(client, db)
    await client.post(CONSENT, headers=headers)
    response = await send(client, headers, [images.photo("a")] * count)
    assert (response.status_code, error_code(response)) == (422, "PHOTO_COUNT")


async def test_a_request_without_photos_is_a_validation_error(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await phone(client, db)
    response = await client.post(MINE, headers=headers)
    assert (response.status_code, error_code(response)) == (422, "VALIDATION_ERROR")


async def test_an_oversized_photo_is_refused(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await phone(client, db)
    await client.post(CONSENT, headers=headers)
    huge = b"\xff\xd8" + b"0" * service.MAX_PHOTO_BYTES
    response = await send(client, headers, [images.photo("a"), huge, images.photo("a")])
    assert (response.status_code, error_code(response)) == (413, "PHOTO_TOO_LARGE")


async def test_sending_again_while_pending_replaces_the_photos(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user, headers, enrollment_id = await enrolled(client, db)
    old_keys = list((await rows(db, user))[0].image_keys or [])
    assert (await send(client, headers, good())).status_code == 201
    (row,) = await rows(db, user)
    assert (row.id, row.status) == (enrollment_id, "pending")
    assert row.image_keys is not None and set(row.image_keys).isdisjoint(old_keys)
    assert all(stored(client, key) for key in row.image_keys)
    assert not any(stored(client, key) for key in old_keys)


async def test_the_audit_trail_never_holds_the_face(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    await approved(client, db)
    for action in ("consent", "submit", "approve"):
        audits = await audit_rows(db, f"face_enrollment.{action}")
        assert len(audits) == 1
        assert nothing_private([audits[0].before, audits[0].after])


# --- the review queue -------------------------------------------------------------------------


async def test_the_queue_lists_who_and_when_but_no_photos(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user, _, enrollment_id = await enrolled(client, db)
    _, admin = await actor(client, db, ADMIN)
    body = (await client.get(QUEUE, headers=admin)).json()
    (item,) = [i for i in body["items"] if i["id"] == enrollment_id]
    assert item["employee"] == {"id": user.id, "emp_code": user.emp_code, "name": user.name}
    assert item["status"] == "pending"
    assert set(item) == {"id", "employee", "status", "consent_at", "submitted_at", "decided_at"}
    assert nothing_private(body)
    done = await client.get(QUEUE, params={"status": "approved"}, headers=admin)
    assert done.json()["items"] == []


async def test_the_queue_pages_by_cursor(client: httpx.AsyncClient, db: AsyncSession) -> None:
    ids = [(await enrolled(client, db, n, name))[2] for n, name in ((1, "a"), (2, "b"), (3, "c"))]
    _, admin = await actor(client, db, ADMIN)
    first = (await client.get(QUEUE, params={"limit": 2}, headers=admin)).json()
    assert [i["id"] for i in first["items"]] == ids[:2]
    rest = (
        await client.get(QUEUE, params={"limit": 2, "cursor": first["next_cursor"]}, headers=admin)
    ).json()
    assert [i["id"] for i in rest["items"]] == ids[2:]
    assert rest["next_cursor"] is None
    bad = await client.get(QUEUE, params={"cursor": "x"}, headers=admin)
    assert (bad.status_code, error_code(bad)) == (422, "INVALID_CURSOR")


async def test_the_detail_gives_working_short_lived_photo_links_and_is_audited(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user, _, enrollment_id = await enrolled(client, db)
    admin_user, admin = await actor(client, db, ADMIN)
    response = await client.get(f"{QUEUE}/{enrollment_id}", headers=admin)
    assert response.status_code == 200
    body = response.json()
    assert len(body["photos"]) == len(body["qualities"]) == 3
    assert all(url.startswith("/api/v1/files/") for url in body["photos"])
    assert "face/" not in response.text  # storage keys stay on the server
    assert set(body["qualities"][0]) == {"confidence", "face_px", "sharpness", "brightness"}
    assert body["consistency_score"] >= 0.4
    for url in body["photos"]:
        photo = await client.get(url)  # no sign-in header: the link is the credential
        assert photo.status_code == 200
        assert photo.content[:2] == b"\xff\xd8"
    views = await audit_rows(db, "face_enrollment.view")
    assert [(v.actor_id, v.entity_id) for v in views] == [(admin_user.id, str(enrollment_id))]
    assert views[0].after == {"user_id": user.id, "status": "pending"}


async def test_a_reviewer_sees_only_people_they_may_manage(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    # An admin's own enrollment: a reviewer with fewer permissions than an admin may not see it.
    admin_user = await make_user(db, ADMIN)
    admin_phone = await auth_headers(client, admin_user, kind="mobile", device_info=device(7))
    await client.post(CONSENT, headers=admin_phone)
    assert (await send(client, admin_phone, good())).status_code == 201
    enrollment_id = (await rows(db, admin_user))[0].id
    limited = await headers_with(client, db, FACE_REVIEW)
    assert (await client.get(QUEUE, headers=limited)).json()["items"] == []
    for method, path, body in (
        ("GET", f"{QUEUE}/{enrollment_id}", None),
        ("POST", f"{QUEUE}/{enrollment_id}/approve", None),
        ("POST", f"{QUEUE}/{enrollment_id}/reject", {"reason": "no"}),
        ("POST", f"{QUEUE}/{enrollment_id}/reset", {"reason": "no"}),
    ):
        response = await client.request(method, path, json=body, headers=limited)
        assert (response.status_code, error_code(response)) == (403, "FORBIDDEN"), path
    assert (await rows(db, admin_user))[0].status == "pending"
    assert await audit_rows(db, "face_enrollment.view") == []


async def test_an_unknown_enrollment_is_not_found(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, admin = await actor(client, db, ADMIN)
    for method, path, body in (
        ("GET", f"{QUEUE}/999999", None),
        ("POST", f"{QUEUE}/999999/approve", None),
        ("POST", f"{QUEUE}/999999/reject", {"reason": "x"}),
        ("POST", f"{QUEUE}/999999/reset", {"reason": "x"}),
    ):
        response = await client.request(method, path, json=body, headers=admin)
        assert (response.status_code, error_code(response)) == (404, "NOT_FOUND")


# --- deciding ---------------------------------------------------------------------------------


async def test_approving_records_who_and_when_and_cannot_be_done_twice(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user, headers, enrollment_id = await enrolled(client, db)
    admin_user, admin = await actor(client, db, ADMIN)
    response = await client.post(f"{QUEUE}/{enrollment_id}/approve", headers=admin)
    assert response.status_code == 200
    assert response.json()["status"] == "approved"
    (row,) = await rows(db, user)
    assert (row.status, row.decided_by) == ("approved", admin_user.id)
    assert row.decided_at is not None and row.embeddings is not None
    assert (await client.get(MINE, headers=headers)).json()["status"] == "approved"
    again = await client.post(f"{QUEUE}/{enrollment_id}/approve", headers=admin)
    assert (again.status_code, error_code(again)) == (409, "ENROLLMENT_ALREADY_DECIDED")
    late = await client.post(f"{QUEUE}/{enrollment_id}/reject", json={"reason": "x"}, headers=admin)
    assert (late.status_code, error_code(late)) == (409, "ENROLLMENT_ALREADY_DECIDED")
    (audit,) = await audit_rows(db, "face_enrollment.approve")
    assert (audit.before, audit.after) == (
        {"user_id": user.id, "status": "pending"},
        {"user_id": user.id, "status": "approved"},
    )


async def test_an_approved_person_cannot_enroll_again_without_a_reset(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers, _, _ = await approved(client, db)
    consent = await client.post(CONSENT, headers=headers)
    photos = await send(client, headers, good())
    for response in (consent, photos):
        assert (response.status_code, error_code(response)) == (409, "ALREADY_APPROVED")


@pytest.mark.parametrize("action", ["reject", "reset"])
@pytest.mark.parametrize("body", [{}, {"reason": ""}, {"reason": "   "}, {"reason": "x" * 256}])
async def test_rejecting_and_resetting_need_a_reason(
    client: httpx.AsyncClient, db: AsyncSession, action: str, body: dict[str, str]
) -> None:
    user, _, enrollment_id = await enrolled(client, db)
    _, admin = await actor(client, db, ADMIN)
    response = await client.post(f"{QUEUE}/{enrollment_id}/{action}", json=body, headers=admin)
    assert (response.status_code, error_code(response)) == (422, "VALIDATION_ERROR")
    assert (await rows(db, user))[0].status == "pending"


async def test_rejecting_deletes_the_face_and_tells_the_employee_why(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user, headers, enrollment_id = await enrolled(client, db)
    _, admin = await actor(client, db, ADMIN)
    links = (await client.get(f"{QUEUE}/{enrollment_id}", headers=admin)).json()["photos"]
    keys = list((await rows(db, user))[0].image_keys or [])
    reason = "Face is partly covered"
    response = await client.post(
        f"{QUEUE}/{enrollment_id}/reject", json={"reason": f"  {reason}  "}, headers=admin
    )
    assert response.status_code == 200
    (row,) = await rows(db, user)
    assert (row.status, row.reason) == ("rejected", reason)
    assert (row.embeddings, row.image_keys) == (None, None)
    assert not any(stored(client, key) for key in keys)
    assert (await client.get(links[0])).status_code == 404  # the old link now leads nowhere
    mine = (await client.get(MINE, headers=headers)).json()
    assert (mine["status"], mine["reason"]) == ("rejected", reason)
    closed = (await client.get(f"{QUEUE}/{enrollment_id}", headers=admin)).json()
    assert (closed["photos"], closed["qualities"]) == ([], [])
    (audit,) = await audit_rows(db, "face_enrollment.reject")
    assert audit.after == {"user_id": user.id, "status": "rejected", "reason": reason}


async def test_after_a_rejection_the_person_consents_and_enrolls_again(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user, headers, enrollment_id = await enrolled(client, db)
    _, admin = await actor(client, db, ADMIN)
    await client.post(f"{QUEUE}/{enrollment_id}/reject", json={"reason": "blurred"}, headers=admin)
    refused = await send(client, headers, good())
    assert error_code(refused) == "CONSENT_REQUIRED"
    assert (await client.post(CONSENT, headers=headers)).status_code == 201
    assert (await send(client, headers, good())).status_code == 201
    assert [row.status for row in await rows(db, user)] == ["rejected", "pending"]


@pytest.mark.parametrize("was", ["pending", "approved"])
async def test_reset_deletes_the_face_and_a_new_enrollment_needs_approval(
    client: httpx.AsyncClient, db: AsyncSession, was: str
) -> None:
    user, headers, enrollment_id = await enrolled(client, db)
    _, admin = await actor(client, db, ADMIN)
    if was == "approved":
        await client.post(f"{QUEUE}/{enrollment_id}/approve", headers=admin)
    keys = list((await rows(db, user))[0].image_keys or [])
    response = await client.post(
        f"{QUEUE}/{enrollment_id}/reset", json={"reason": "Grew a beard"}, headers=admin
    )
    assert response.status_code == 200
    (row,) = await rows(db, user)
    assert (row.status, row.reason, row.embeddings, row.image_keys) == (
        "reset",
        "Grew a beard",
        None,
        None,
    )
    assert not any(stored(client, key) for key in keys)
    mine = (await client.get(MINE, headers=headers)).json()
    assert (mine["status"], mine["reason"]) == ("reset", "Grew a beard")
    with pytest.raises(AppError):
        await service.ensure_face_approved(db, user.id)
    # FR-FACE-03: enrolling again leaves the person pending, not approved.
    await client.post(CONSENT, headers=headers)
    assert (await send(client, headers, good())).status_code == 201
    assert [r.status for r in await rows(db, user)] == ["reset", "pending"]
    again = await client.post(f"{QUEUE}/{enrollment_id}/reset", json={"reason": "x"}, headers=admin)
    assert (again.status_code, error_code(again)) == (409, "ENROLLMENT_NOT_RESETTABLE")


# --- the rule and the check the punch endpoints will use (M4) ---------------------------------


async def test_punches_are_blocked_until_the_enrollment_is_approved(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user, headers = await phone(client, db)

    async def blocked() -> bool:
        try:
            await service.ensure_face_approved(db, user.id)
        except AppError as error:
            assert (error.code, error.status_code) == ("FACE_NOT_APPROVED", 409)
            return True
        return False

    assert await blocked()  # never enrolled
    await client.post(CONSENT, headers=headers)
    assert await blocked()  # consent only
    assert (await send(client, headers, good())).status_code == 201
    assert await blocked()  # waiting for an admin
    _, admin = await actor(client, db, ADMIN)
    enrollment_id = (await rows(db, user))[0].id
    await client.post(f"{QUEUE}/{enrollment_id}/approve", headers=admin)
    assert not await blocked()
    await client.post(f"{QUEUE}/{enrollment_id}/reset", json={"reason": "x"}, headers=admin)
    assert await blocked()


async def test_verification_decides_with_the_thresholds_from_settings(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user, _, _, _ = await approved(client, db, name="a")
    same = await service.verify_face(db, user.id, images.same_person("a", 1))
    assert same.decision is Decision.VERIFIED
    other = await service.verify_face(db, user.id, images.photo("b"))
    assert other.decision is Decision.MISMATCH
    assert other.score is not None and 0.2 < other.score < 0.3
    assert (other.thresholds.verify, other.thresholds.review) == (0.4, 0.3)
    retake = await service.verify_face(db, user.id, images.blurred("a"))
    assert (retake.decision, retake.issue, retake.score) == (Decision.RETAKE, Issue.BLURRY, None)

    # The same impostor photo passes once an admin sets absurdly low thresholds: nothing is fixed
    # in code.
    db.add(Setting(key="face_verify_threshold", value=0.2))
    db.add(Setting(key="face_review_threshold", value=0.1))
    await db.flush()
    lowered = await service.verify_face(db, user.id, images.photo("b"))
    assert lowered.score == pytest.approx(other.score)
    assert lowered.decision is Decision.VERIFIED
    assert (lowered.thresholds.verify, lowered.thresholds.review) == (0.2, 0.1)
    assert lowered.model_version == "yunet-2023mar+sface-2021dec"


async def test_verification_needs_an_approved_enrollment(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user, _, _ = await enrolled(client, db)
    with pytest.raises(AppError) as caught:
        await service.verify_face(db, user.id, images.photo("a"))
    assert caught.value.code == "FACE_NOT_APPROVED"


async def test_a_wrong_encryption_key_makes_matching_unavailable_not_wrong(
    client: httpx.AsyncClient, db: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, _, _, _ = await approved(client, db)
    monkeypatch.setattr(crypto, "face_key", lambda: b"k" * 32)
    with pytest.raises(AppError) as caught:
        await service.verify_face(db, user.id, images.photo("a"))
    assert (caught.value.code, caught.value.status_code) == ("FACE_UNAVAILABLE", 503)
