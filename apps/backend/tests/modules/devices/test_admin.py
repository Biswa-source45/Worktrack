"""Admin device decisions: GET/PATCH /admin/devices."""

from dataclasses import dataclass
from typing import Any

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.devices.models import UserDevice
from app.modules.employees.models import User
from tests.factories import ADMIN, ASSIGNER, SUPER_ADMIN, device, login, make_user
from tests.modules.employees.helpers import API, actor, audit_rows, error_code

DEVICES = f"{API}/admin/devices"


@dataclass
class TwoPhones:
    user: User
    old_tokens: dict[str, Any]  # the active phone
    new_tokens: dict[str, Any]  # the pending phone
    old: UserDevice
    new: UserDevice


async def _phone(db: AsyncSession, user: User, number: int) -> UserDevice:
    row = (
        await db.execute(
            select(UserDevice).where(
                UserDevice.user_id == user.id,
                UserDevice.device_id == device(number)["device_id"],
                UserDevice.status != "revoked",
            )
        )
    ).scalar_one()
    return row


async def _two_phones(
    client: httpx.AsyncClient, db: AsyncSession, role: str = "Field Employee"
) -> TwoPhones:
    user = await make_user(db, role)
    old = (await login(client, user, kind="mobile", device_info=device(1))).json()
    new = (await login(client, user, kind="mobile", device_info=device(2))).json()
    return TwoPhones(user, old, new, await _phone(db, user, 1), await _phone(db, user, 2))


async def _decide(
    client: httpx.AsyncClient, headers: dict[str, str], device_id: int, action: str
) -> httpx.Response:
    return await client.patch(f"{DEVICES}/{device_id}", json={"action": action}, headers=headers)


async def _refresh_status(client: httpx.AsyncClient, tokens: dict[str, Any]) -> int:
    response = await client.post(
        f"{API}/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
    )
    return response.status_code


async def _me_device_status(client: httpx.AsyncClient, tokens: dict[str, Any]) -> str:
    headers = {"Authorization": f"Bearer {tokens['access_token']}"}
    status: str = (await client.get(f"{API}/me", headers=headers)).json()["device"]["status"]
    return status


# --- listing ----------------------------------------------------------------------------------


async def test_list_shows_owner_details_and_filters(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    phones = await _two_phones(client, db)
    other = await make_user(db)
    await login(client, other, kind="mobile", device_info=device(9))

    everything = (await client.get(DEVICES, headers=headers)).json()
    assert len(everything["items"]) == 3
    assert everything["next_cursor"] is None
    item = next(i for i in everything["items"] if i["id"] == phones.new.id)
    assert item["emp_code"] == phones.user.emp_code
    assert item["user_name"] == phones.user.name
    assert item["user_id"] == phones.user.id
    assert item["status"] == "pending"
    assert item["device_id"] == device(2)["device_id"]
    assert item["approved_by"] is None
    assert "fcm_token" not in item

    pending = (await client.get(DEVICES, params={"status": "pending"}, headers=headers)).json()
    assert [i["id"] for i in pending["items"]] == [phones.new.id]

    mine = (await client.get(DEVICES, params={"user_id": phones.user.id}, headers=headers)).json()
    assert {i["id"] for i in mine["items"]} == {phones.old.id, phones.new.id}

    both = await client.get(
        DEVICES, params={"user_id": phones.user.id, "status": "active"}, headers=headers
    )
    assert [i["id"] for i in both.json()["items"]] == [phones.old.id]


async def test_list_pagination(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    owner = await make_user(db)
    await login(client, owner, kind="mobile", device_info=device(1))
    for number in (2, 3):  # a third phone replaces the second: 2 revoked, 3 pending
        await login(client, owner, kind="mobile", device_info=device(number))
    ids = sorted(
        (await client.get(DEVICES, params={"user_id": owner.id}, headers=headers)).json()["items"],
        key=lambda i: i["id"],
    )
    assert len(ids) == 3

    seen: list[int] = []
    cursor: str | None = None
    sizes: list[int] = []
    while True:
        params: dict[str, Any] = {"user_id": owner.id, "limit": 2}
        if cursor:
            params["cursor"] = cursor
        page = (await client.get(DEVICES, params=params, headers=headers)).json()
        sizes.append(len(page["items"]))
        seen += [i["id"] for i in page["items"]]
        cursor = page["next_cursor"]
        if cursor is None:
            break
    assert sizes == [2, 1]
    assert seen == [i["id"] for i in ids]


async def test_list_rejects_bad_parameters(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    bad_status = await client.get(DEVICES, params={"status": "lost"}, headers=headers)
    assert bad_status.status_code == 422
    bad_cursor = await client.get(DEVICES, params={"cursor": "abc"}, headers=headers)
    assert bad_cursor.status_code == 422
    assert error_code(bad_cursor) == "INVALID_CURSOR"
    assert (await client.get(DEVICES, params={"limit": 0}, headers=headers)).status_code == 422


# --- approve ----------------------------------------------------------------------------------


async def test_approve_swaps_phones_and_ends_the_old_phones_sessions(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    admin, headers = await actor(client, db)
    phones = await _two_phones(client, db)

    response = await _decide(client, headers, phones.new.id, "approve")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "active"
    assert body["approved_by"] == admin.id
    assert body["emp_code"] == phones.user.emp_code

    await db.refresh(phones.old)
    assert phones.old.status == "revoked"
    assert await _refresh_status(client, phones.old_tokens) == 401
    assert await _refresh_status(client, phones.new_tokens) == 200
    assert await _me_device_status(client, phones.new_tokens) == "active"
    assert await _me_device_status(client, phones.old_tokens) == "revoked"

    (approved,) = await audit_rows(db, "device.approved")
    assert approved.actor_id == admin.id
    assert approved.entity_id == str(phones.new.id)
    assert approved.before == {"status": "pending"}
    assert approved.after == {"status": "active", "user_id": phones.user.id}
    (revoked,) = await audit_rows(db, "device.revoked")
    assert revoked.entity_id == str(phones.old.id)


async def test_pending_phone_shows_as_pending_until_approved(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    phones = await _two_phones(client, db)
    assert await _me_device_status(client, phones.new_tokens) == "pending"
    await _decide(client, headers, phones.new.id, "approve")
    assert await _me_device_status(client, phones.new_tokens) == "active"


@pytest.mark.parametrize("starting", ["active", "revoked"])
async def test_only_a_pending_device_can_be_approved(
    client: httpx.AsyncClient, db: AsyncSession, starting: str
) -> None:
    _, headers = await actor(client, db)
    phones = await _two_phones(client, db)
    target = phones.old
    if starting == "revoked":
        target.status = "revoked"
        await db.flush()
    response = await _decide(client, headers, target.id, "approve")
    assert response.status_code == 409
    assert error_code(response) == "CONFLICT"
    await db.refresh(target)
    assert target.status == starting


async def test_approve_for_an_inactive_employee_is_rejected(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    phones = await _two_phones(client, db)
    phones.user.status = "inactive"
    await db.flush()
    response = await _decide(client, headers, phones.new.id, "approve")
    assert response.status_code == 409
    await db.refresh(phones.new)
    await db.refresh(phones.old)
    assert (phones.new.status, phones.old.status) == ("pending", "active")


# --- reject and revoke ------------------------------------------------------------------------


async def test_reject_revokes_the_pending_phone_only(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    admin, headers = await actor(client, db)
    phones = await _two_phones(client, db)
    response = await _decide(client, headers, phones.new.id, "reject")
    assert response.status_code == 200
    assert response.json()["status"] == "revoked"

    assert await _refresh_status(client, phones.new_tokens) == 401
    assert await _refresh_status(client, phones.old_tokens) == 200
    await db.refresh(phones.old)
    assert phones.old.status == "active"
    (row,) = await audit_rows(db, "device.rejected")
    assert row.actor_id == admin.id
    assert row.before == {"status": "pending"}


async def test_reject_needs_a_pending_device(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    phones = await _two_phones(client, db)
    response = await _decide(client, headers, phones.old.id, "reject")
    assert response.status_code == 409
    assert error_code(response) == "CONFLICT"
    assert await _refresh_status(client, phones.old_tokens) == 200


async def test_revoke_active_phone_ends_its_sessions(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    phones = await _two_phones(client, db)
    response = await _decide(client, headers, phones.old.id, "revoke")
    assert response.status_code == 200
    assert response.json()["status"] == "revoked"
    assert await _refresh_status(client, phones.old_tokens) == 401
    assert await _refresh_status(client, phones.new_tokens) == 200
    assert len(await audit_rows(db, "device.revoked")) == 1


async def test_revoke_pending_phone_is_allowed(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    phones = await _two_phones(client, db)
    response = await _decide(client, headers, phones.new.id, "revoke")
    assert response.status_code == 200
    assert response.json()["status"] == "revoked"


@pytest.mark.parametrize("action", ["approve", "reject", "revoke"])
async def test_an_already_revoked_device_cannot_be_decided_again(
    client: httpx.AsyncClient, db: AsyncSession, action: str
) -> None:
    _, headers = await actor(client, db)
    phones = await _two_phones(client, db)
    assert (await _decide(client, headers, phones.old.id, "revoke")).status_code == 200
    again = await _decide(client, headers, phones.old.id, action)
    assert again.status_code == 409
    assert error_code(again) == "CONFLICT"


# --- errors and permissions -------------------------------------------------------------------


async def test_unknown_device_is_404(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    response = await _decide(client, headers, 999_999, "approve")
    assert response.status_code == 404
    assert error_code(response) == "NOT_FOUND"


async def test_invalid_action_is_a_validation_error(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    phones = await _two_phones(client, db)
    for body in ({"action": "delete"}, {}):
        response = await client.patch(f"{DEVICES}/{phones.new.id}", json=body, headers=headers)
        assert response.status_code == 422
        assert error_code(response) == "VALIDATION_ERROR"
    await db.refresh(phones.new)
    assert phones.new.status == "pending"


async def test_admin_cannot_decide_a_super_admins_device(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, admin_headers = await actor(client, db, ADMIN)
    boss = await _two_phones(client, db, SUPER_ADMIN)
    for action, target in (("approve", boss.new), ("revoke", boss.old), ("reject", boss.new)):
        response = await _decide(client, admin_headers, target.id, action)
        assert response.status_code == 403, action
        assert error_code(response) == "FORBIDDEN"
    await db.refresh(boss.old)
    await db.refresh(boss.new)
    assert (boss.old.status, boss.new.status) == ("active", "pending")
    assert await audit_rows(db, "device.approved") == []


async def test_super_admin_can_decide_a_super_admins_device(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db, SUPER_ADMIN)
    other = await _two_phones(client, db, SUPER_ADMIN)
    assert (await _decide(client, headers, other.new.id, "approve")).status_code == 200


async def test_device_endpoints_need_devices_manage(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db, ASSIGNER)
    phones = await _two_phones(client, db)
    assert (await client.get(DEVICES, headers=headers)).status_code == 403
    assert (await _decide(client, headers, phones.new.id, "approve")).status_code == 403
    assert (await client.get(DEVICES)).status_code == 401
    assert (
        await client.patch(f"{DEVICES}/{phones.new.id}", json={"action": "approve"})
    ).status_code == 401
    await db.refresh(phones.new)
    assert phones.new.status == "pending"
