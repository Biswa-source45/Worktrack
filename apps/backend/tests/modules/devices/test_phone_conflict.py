"""One phone is active for only one employee at a time (D27)."""

from typing import Any

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.auth import service as auth_service
from app.modules.devices.models import UserDevice
from app.modules.employees.models import User
from tests.factories import ADMIN, SUPER_ADMIN, device, login, make_user
from tests.modules.employees.helpers import API, actor, audit_rows, error_code

DEVICES = f"{API}/admin/devices"
PHONE = device(1)["device_id"]


async def _sign_in(client: httpx.AsyncClient, user: User, phone: int = 1) -> dict[str, Any]:
    response = await login(client, user, kind="mobile", device_info=device(phone))
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


async def _me_device(client: httpx.AsyncClient, tokens: dict[str, Any]) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {tokens['access_token']}"}
    body: dict[str, Any] = (await client.get(f"{API}/me", headers=headers)).json()["device"]
    return body


async def _refresh_status(client: httpx.AsyncClient, tokens: dict[str, Any]) -> int:
    response = await client.post(
        f"{API}/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
    )
    return response.status_code


async def _rows(db: AsyncSession, user: User) -> list[UserDevice]:
    """The user's device rows, oldest first, freshly read."""
    rows = list(
        (
            await db.execute(
                select(UserDevice).where(UserDevice.user_id == user.id).order_by(UserDevice.id)
            )
        ).scalars()
    )
    for row in rows:
        await db.refresh(row)
    return rows


async def _listed(client: httpx.AsyncClient, headers: dict[str, str]) -> dict[int, dict[str, Any]]:
    items = (await client.get(DEVICES, headers=headers)).json()["items"]
    return {item["id"]: item for item in items}


async def _decide(
    client: httpx.AsyncClient, headers: dict[str, str], row: UserDevice, action: str
) -> httpx.Response:
    return await client.patch(f"{DEVICES}/{row.id}", json={"action": action}, headers=headers)


# --- sign-in ----------------------------------------------------------------------------------


async def test_second_employee_on_an_active_phone_waits_with_the_reason(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    alice, bob = await make_user(db, name="Alice Holder"), await make_user(db)
    alice_tokens = await _sign_in(client, alice)
    bob_tokens = await _sign_in(client, bob)  # Bob has no phone at all, and still must wait

    assert bob_tokens["device_status"] == "pending"
    assert await _me_device(client, bob_tokens) == {
        "id": (await _rows(db, bob))[0].id,
        "status": "pending",
        "pending_reason": "phone_in_use",
    }
    # No takeover: the employee who holds the phone is untouched.
    assert (await _me_device(client, alice_tokens))["status"] == "active"
    assert (await _me_device(client, alice_tokens))["pending_reason"] is None
    assert await _refresh_status(client, alice_tokens) == 200

    (alice_row,) = await _rows(db, alice)
    (bob_row,) = await _rows(db, bob)
    (request,) = await audit_rows(db, "device.change_requested")
    assert request.actor_id == bob.id
    assert request.entity_id == str(bob_row.id)
    assert request.after == {
        "status": "pending",
        "reason": "phone_in_use",
        "conflict_user_id": alice.id,
    }

    _, headers = await actor(client, db)
    listed = await _listed(client, headers)
    assert listed[bob_row.id]["conflict"] == {
        "user_id": alice.id,
        "emp_code": alice.emp_code,
        "name": "Alice Holder",
    }
    assert listed[alice_row.id]["conflict"] is None


async def test_the_same_employee_signing_in_again_on_their_phone_stays_active(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    alice = await make_user(db)
    await _sign_in(client, alice)
    again = await _sign_in(client, alice)

    assert again["device_status"] == "active"
    assert (await _me_device(client, again))["pending_reason"] is None
    (row,) = await _rows(db, alice)  # no second row, pending or otherwise
    assert row.status == "active"
    assert len(await audit_rows(db, "device.registered")) == 1
    assert await audit_rows(db, "device.change_requested") == []


async def test_an_ordinary_phone_change_has_no_conflict_reason(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    alice = await make_user(db)
    await _sign_in(client, alice, 1)
    second = await _sign_in(client, alice, 2)
    assert (await _me_device(client, second)) == {
        "id": (await _rows(db, alice))[1].id,
        "status": "pending",
        "pending_reason": None,
    }
    (request,) = await audit_rows(db, "device.change_requested")
    assert request.after == {"status": "pending"}
    _, headers = await actor(client, db)
    assert all(item["conflict"] is None for item in (await _listed(client, headers)).values())


async def test_a_phone_freed_by_a_revoke_is_active_at_once_for_the_next_employee(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    alice, bob = await make_user(db), await make_user(db)
    await _sign_in(client, alice)
    _, headers = await actor(client, db)
    (alice_row,) = await _rows(db, alice)
    assert (await _decide(client, headers, alice_row, "revoke")).status_code == 200

    assert (await _sign_in(client, bob))["device_status"] == "active"


async def test_a_phone_that_is_only_pending_for_someone_else_does_not_block(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    alice, bob = await make_user(db), await make_user(db)
    await _sign_in(client, alice, 1)
    await _sign_in(client, alice, 2)  # phone 2 is Alice's pending change request
    assert (await _sign_in(client, bob, 2))["device_status"] == "active"

    # Alice's request now names Bob, and approving it takes the phone from him.
    _, headers = await actor(client, db)
    alice_pending = (await _rows(db, alice))[1]
    assert (await _listed(client, headers))[alice_pending.id]["conflict"]["user_id"] == bob.id
    assert (await _decide(client, headers, alice_pending, "approve")).status_code == 200
    assert [r.status for r in await _rows(db, alice)] == ["revoked", "active"]
    assert [r.status for r in await _rows(db, bob)] == ["revoked"]


async def test_losing_a_race_for_a_free_phone_ends_as_pending(
    client: httpx.AsyncClient, db: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two sign-ins both see a free phone; the unique index lets one in, the other waits."""
    alice, bob = await make_user(db), await make_user(db)
    await _sign_in(client, alice)

    real = auth_service.phone_holder_id
    looks = 0

    async def stale_then_real(session: AsyncSession, device_id: str, user_id: int) -> int | None:
        nonlocal looks
        looks += 1
        # Bob's first look happens "before" Alice's row exists.
        return None if looks == 1 else await real(session, device_id, user_id)

    monkeypatch.setattr(auth_service, "phone_holder_id", stale_then_real)
    bob_tokens = await _sign_in(client, bob)

    assert bob_tokens["device_status"] == "pending"
    assert [r.status for r in await _rows(db, alice)] == ["active"]
    assert [r.status for r in await _rows(db, bob)] == ["pending"]
    (request,) = await audit_rows(db, "device.change_requested")
    assert request.after is not None
    assert request.after["conflict_user_id"] == alice.id


async def test_the_database_refuses_a_second_active_employee_on_one_phone(
    db: AsyncSession,
) -> None:
    alice, bob = await make_user(db), await make_user(db)
    for owner in (alice, bob):
        row = UserDevice(
            user_id=owner.id,
            device_id=PHONE,
            model="Pixel 8",
            os="Android 14",
            app_version="0.1.0",
            status="active",
        )
        if owner is alice:
            db.add(row)
            await db.flush()
            continue
        with pytest.raises(IntegrityError, match="uq_user_devices_one_active_per_phone"):
            async with db.begin_nested():
                db.add(row)
                await db.flush()


# --- admin decision ---------------------------------------------------------------------------


async def test_approving_revokes_the_other_employees_binding_and_sessions(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    alice, bob = await make_user(db), await make_user(db)
    alice_tokens = await _sign_in(client, alice)
    bob_tokens = await _sign_in(client, bob)
    admin, headers = await actor(client, db)
    (alice_row,) = await _rows(db, alice)
    (bob_row,) = await _rows(db, bob)

    response = await _decide(client, headers, bob_row, "approve")
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "active"
    assert response.json()["conflict"] is None

    assert [r.status for r in await _rows(db, alice)] == ["revoked"]
    assert [r.status for r in await _rows(db, bob)] == ["active"]
    assert await _refresh_status(client, alice_tokens) == 401
    assert await _refresh_status(client, bob_tokens) == 200
    assert await _me_device(client, bob_tokens) == {
        "id": bob_row.id,
        "status": "active",
        "pending_reason": None,
    }

    (approved,) = await audit_rows(db, "device.approved")
    assert (approved.actor_id, approved.entity_id) == (admin.id, str(bob_row.id))
    (revoked,) = await audit_rows(db, "device.revoked")
    assert (revoked.actor_id, revoked.entity_id) == (admin.id, str(alice_row.id))
    assert revoked.after == {
        "status": "revoked",
        "reason": "phone_reassigned",
        "new_user_id": bob.id,
    }


async def test_approving_also_replaces_the_employees_own_old_phone(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    alice, bob = await make_user(db), await make_user(db)
    await _sign_in(client, alice, 1)
    await _sign_in(client, bob, 2)
    await _sign_in(client, bob, 1)  # Bob moves to Alice's phone
    _, headers = await actor(client, db)
    bob_old, bob_new = await _rows(db, bob)

    assert (await _decide(client, headers, bob_new, "approve")).status_code == 200
    assert [r.status for r in await _rows(db, bob)] == ["revoked", "active"]
    assert [r.status for r in await _rows(db, alice)] == ["revoked"]
    reasons = {row.entity_id: row.after for row in await audit_rows(db, "device.revoked")}
    assert reasons[str(bob_old.id)] == {"status": "revoked"}


async def test_rejecting_leaves_the_other_employee_untouched(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    alice, bob = await make_user(db), await make_user(db)
    alice_tokens = await _sign_in(client, alice)
    bob_tokens = await _sign_in(client, bob)
    _, headers = await actor(client, db)
    (bob_row,) = await _rows(db, bob)

    assert (await _decide(client, headers, bob_row, "reject")).status_code == 200
    assert [r.status for r in await _rows(db, alice)] == ["active"]
    assert [r.status for r in await _rows(db, bob)] == ["revoked"]
    assert await _refresh_status(client, alice_tokens) == 200
    assert await _refresh_status(client, bob_tokens) == 401
    assert await audit_rows(db, "device.revoked") == []


async def test_approving_needs_the_right_to_manage_the_other_employee_too(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    boss, bob = await make_user(db, SUPER_ADMIN), await make_user(db)
    boss_tokens = await _sign_in(client, boss)
    await _sign_in(client, bob)
    _, headers = await actor(client, db, ADMIN)  # may manage Bob, not a Super Admin
    (bob_row,) = await _rows(db, bob)

    response = await _decide(client, headers, bob_row, "approve")
    assert response.status_code == 403
    assert error_code(response) == "FORBIDDEN"
    assert [r.status for r in await _rows(db, boss)] == ["active"]
    assert [r.status for r in await _rows(db, bob)] == ["pending"]
    assert await _refresh_status(client, boss_tokens) == 200
    assert await audit_rows(db, "device.approved") == []
    assert await audit_rows(db, "device.revoked") == []
