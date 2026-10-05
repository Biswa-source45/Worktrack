from typing import Any

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.auth.permissions import SETTINGS_MANAGE, SETTINGS_VIEW
from app.modules.org_settings import service
from app.modules.org_settings.models import Setting
from app.modules.org_settings.schemas import OrgSettings
from tests.factories import ADMIN, SUPER_ADMIN, headers_with
from tests.modules.employees.helpers import API, actor, audit_rows, error_code

SETTINGS = f"{API}/admin/settings"
DEFAULTS: dict[str, Any] = {
    "geofence_default_radius_m": 100,
    "home_default_radius_m": 100,
    "gps_max_accuracy_m": 50,
    "geofence_accuracy_buffer_cap_m": 30,
    "punch_out_approval_levels": 1,
    "regularization_approval_levels": 1,
    "min_app_version": "0.0.0",
    "face_verify_threshold": 0.40,
    "face_review_threshold": 0.30,
    "face_min_detection_confidence": 0.90,
    "face_min_face_px": 80,
    "face_min_sharpness": 60,
    "face_min_brightness": 50,
    "face_max_brightness": 200,
    "face_retention_days_after_exit": 30,
}


async def test_defaults_are_returned_when_nothing_is_stored(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    response = await client.get(SETTINGS, headers=headers)
    assert response.status_code == 200
    assert response.json() == DEFAULTS
    assert (await db.execute(select(Setting))).first() is None


async def test_update_changes_only_the_keys_sent_and_persists(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    admin, headers = await actor(client, db, SUPER_ADMIN)
    body = {"gps_max_accuracy_m": 80, "min_app_version": "1.4.0"}
    response = await client.patch(SETTINGS, json=body, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json() == {**DEFAULTS, **body}
    assert (await client.get(SETTINGS, headers=headers)).json() == {**DEFAULTS, **body}
    assert await service.get_org_settings(db) == OrgSettings.model_validate(body)

    rows = {row.key: row for row in (await db.execute(select(Setting))).scalars()}
    assert set(rows) == set(body)
    assert rows["gps_max_accuracy_m"].value == 80
    assert rows["gps_max_accuracy_m"].updated_by == admin.id

    # A second change to the same key replaces the row.
    again = await client.patch(SETTINGS, json={"gps_max_accuracy_m": 60}, headers=headers)
    assert again.json()["gps_max_accuracy_m"] == 60
    assert again.json()["min_app_version"] == "1.4.0"
    assert (await service.get_org_settings(db)).gps_max_accuracy_m == 60


async def test_update_writes_an_audit_row_with_only_the_changed_keys(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    admin, headers = await actor(client, db, SUPER_ADMIN)
    body = {"geofence_default_radius_m": 150, "punch_out_approval_levels": 1}
    assert (await client.patch(SETTINGS, json=body, headers=headers)).status_code == 200
    [row] = await audit_rows(db, "settings.update")
    assert row.actor_id == admin.id
    assert row.entity == "settings"
    # punch_out_approval_levels was sent with its current value, so it is not a change.
    assert row.before == {"geofence_default_radius_m": 100}
    assert row.after == {"geofence_default_radius_m": 150}


async def test_an_update_that_changes_nothing_writes_nothing(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db, SUPER_ADMIN)
    bodies: list[dict[str, int]] = [{}, {"gps_max_accuracy_m": 50}]
    for body in bodies:
        response = await client.patch(SETTINGS, json=body, headers=headers)
        assert response.status_code == 200
        assert response.json() == DEFAULTS
    assert await audit_rows(db, "settings.update") == []
    assert (await db.execute(select(Setting))).first() is None


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("geofence_default_radius_m", 29),
        ("geofence_default_radius_m", 501),
        ("home_default_radius_m", 29),
        ("home_default_radius_m", 501),
        ("gps_max_accuracy_m", 4),
        ("gps_max_accuracy_m", 501),
        ("geofence_accuracy_buffer_cap_m", -1),
        ("geofence_accuracy_buffer_cap_m", 101),
        ("punch_out_approval_levels", 0),
        ("punch_out_approval_levels", 3),
        ("regularization_approval_levels", 0),
        ("regularization_approval_levels", 3),
        ("min_app_version", "1.4"),
        ("min_app_version", "v1.4.0"),
        ("min_app_version", ""),
        ("gps_max_accuracy_m", None),
        ("gps_max_accuracy_m", "far"),
        ("face_verify_threshold", 0.95),
        ("face_review_threshold", 0.05),
        ("face_min_detection_confidence", 0.2),
        ("face_min_face_px", 10),
        ("face_max_brightness", 300),
    ],
)
async def test_out_of_range_values_are_rejected(
    client: httpx.AsyncClient, db: AsyncSession, key: str, value: Any
) -> None:
    _, headers = await actor(client, db, SUPER_ADMIN)
    response = await client.patch(SETTINGS, json={key: value}, headers=headers)
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "VALIDATION_ERROR"
    assert error["details"][0]["loc"] == ["body", key]
    assert (await client.get(SETTINGS, headers=headers)).json() == DEFAULTS


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("geofence_default_radius_m", 30),
        ("geofence_default_radius_m", 500),
        ("gps_max_accuracy_m", 5),
        ("gps_max_accuracy_m", 500),
        ("geofence_accuracy_buffer_cap_m", 0),
        ("geofence_accuracy_buffer_cap_m", 100),
        ("punch_out_approval_levels", 2),
        ("min_app_version", "12.0.345"),
        ("face_min_face_px", 400),
    ],
)
async def test_values_on_the_bounds_are_accepted(
    client: httpx.AsyncClient, db: AsyncSession, key: str, value: Any
) -> None:
    _, headers = await actor(client, db, SUPER_ADMIN)
    response = await client.patch(SETTINGS, json={key: value}, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()[key] == value


async def test_an_unknown_key_is_rejected_and_nothing_is_saved(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db, SUPER_ADMIN)
    body = {"gps_max_accuracy_m": 80, "face_threshold": 0.4}
    response = await client.patch(SETTINGS, json=body, headers=headers)
    assert response.status_code == 422
    assert error_code(response) == "VALIDATION_ERROR"
    assert response.json()["error"]["details"][0]["loc"] == ["body", "face_threshold"]
    assert (await client.get(SETTINGS, headers=headers)).json() == DEFAULTS


async def test_a_stored_key_that_is_no_longer_a_setting_is_ignored(db: AsyncSession) -> None:
    db.add(Setting(key="retired_setting", value=1))
    await db.flush()
    assert await service.get_org_settings(db) == OrgSettings()


async def test_view_and_manage_are_separate_permissions(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    viewer = await headers_with(client, db, SETTINGS_VIEW)
    manager = await headers_with(client, db, SETTINGS_MANAGE)
    body = {"gps_max_accuracy_m": 80}

    assert (await client.get(SETTINGS, headers=viewer)).status_code == 200
    denied = await client.patch(SETTINGS, json=body, headers=viewer)
    assert (denied.status_code, error_code(denied)) == (403, "FORBIDDEN")

    assert (await client.patch(SETTINGS, json=body, headers=manager)).status_code == 200
    denied = await client.get(SETTINGS, headers=manager)
    assert (denied.status_code, error_code(denied)) == (403, "FORBIDDEN")


async def test_admin_hr_may_view_but_not_change_settings(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db, ADMIN)
    assert (await client.get(SETTINGS, headers=headers)).status_code == 200
    response = await client.patch(SETTINGS, json={"gps_max_accuracy_m": 80}, headers=headers)
    assert (response.status_code, error_code(response)) == (403, "FORBIDDEN")
    assert await audit_rows(db, "settings.update") == []


@pytest.mark.parametrize(
    "body",
    [
        {"face_review_threshold": 0.45},  # not below the stored verify threshold (0.40)
        {"face_verify_threshold": 0.25},  # not above the stored review threshold (0.30)
        {"face_verify_threshold": 0.35, "face_review_threshold": 0.35},
        {"face_min_brightness": 200},  # not below the stored maximum (200)
    ],
)
async def test_two_key_rules_are_checked_against_the_stored_values(
    client: httpx.AsyncClient, db: AsyncSession, body: dict[str, Any]
) -> None:
    _, headers = await actor(client, db, SUPER_ADMIN)
    response = await client.patch(SETTINGS, json=body, headers=headers)
    assert response.status_code == 422
    assert error_code(response) == "VALIDATION_ERROR"
    assert (await client.get(SETTINGS, headers=headers)).json() == DEFAULTS


async def test_both_thresholds_can_move_together(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db, SUPER_ADMIN)
    body = {"face_verify_threshold": 0.55, "face_review_threshold": 0.45}
    assert (await client.patch(SETTINGS, json=body, headers=headers)).status_code == 200
    stored = (await client.get(SETTINGS, headers=headers)).json()
    assert (stored["face_verify_threshold"], stored["face_review_threshold"]) == (0.55, 0.45)
    # the review threshold can now rise on its own, up to just below the new verify threshold
    assert (
        await client.patch(SETTINGS, json={"face_review_threshold": 0.5}, headers=headers)
    ).status_code == 200


@pytest.mark.parametrize(
    "body",
    [
        {"face_verify_threshold": 0.2, "face_review_threshold": 0.1},
        {"face_verify_threshold": 0.9, "face_review_threshold": 0.8},
    ],
)
async def test_threshold_bounds_are_accepted_as_pairs(
    client: httpx.AsyncClient, db: AsyncSession, body: dict[str, Any]
) -> None:
    _, headers = await actor(client, db, SUPER_ADMIN)
    assert (await client.patch(SETTINGS, json=body, headers=headers)).status_code == 200
