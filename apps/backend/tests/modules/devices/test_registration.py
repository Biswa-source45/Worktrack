"""Device binding at mobile login (FR-AUTH-04)."""

from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.devices.models import UserDevice
from app.modules.employees.models import User
from tests.factories import ASSIGNER, device, login, make_user
from tests.modules.employees.helpers import API, audit_rows


async def _devices(db: AsyncSession, user: User) -> dict[str, UserDevice]:
    """The user's device rows by phone id, freshly read."""
    rows = (await db.execute(select(UserDevice).where(UserDevice.user_id == user.id))).scalars()
    result = {d.device_id: d for d in rows}
    for row in result.values():
        await db.refresh(row)
    return result


async def _mobile_login(
    client: httpx.AsyncClient, user: User, phone: int, **overrides: str
) -> dict[str, Any]:
    response = await login(client, user, kind="mobile", device_info=device(phone, **overrides))
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


async def _me(client: httpx.AsyncClient, tokens: dict[str, Any]) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {tokens['access_token']}"}
    response = await client.get(f"{API}/me", headers=headers)
    assert response.status_code == 200
    body: dict[str, Any] = response.json()
    return body


async def _refresh_status(client: httpx.AsyncClient, tokens: dict[str, Any]) -> int:
    response = await client.post(
        f"{API}/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
    )
    return response.status_code


async def test_first_phone_is_active_at_once(client: httpx.AsyncClient, db: AsyncSession) -> None:
    user = await make_user(db)
    tokens = await _mobile_login(client, user, 1)
    assert tokens["device_status"] == "active"
    me = await _me(client, tokens)
    assert me["device"]["status"] == "active"
    assert me["client"] == "mobile"

    (phone,) = (await _devices(db, user)).values()
    assert phone.status == "active"
    assert (phone.model, phone.os, phone.app_version) == ("Pixel 8", "Android 14", "0.1.0")
    (row,) = await audit_rows(db, "device.registered")
    assert row.actor_id == user.id
    assert row.entity_id == str(phone.id)


async def test_second_phone_waits_as_a_pending_request(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db)
    first = await _mobile_login(client, user, 1)
    second = await _mobile_login(client, user, 2)
    assert second["device_status"] == "pending"

    # The pending phone knows it is pending; the approved phone is unaffected.
    assert (await _me(client, second))["device"]["status"] == "pending"
    assert (await _me(client, first))["device"]["status"] == "active"
    assert await _refresh_status(client, first) == 200

    phones = await _devices(db, user)
    assert {p.status for p in phones.values()} == {"active", "pending"}
    assert len(await audit_rows(db, "device.change_requested")) == 1


async def test_same_phone_logging_in_again_reuses_its_row(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db)
    await _mobile_login(client, user, 1)
    again = await _mobile_login(client, user, 1, model="Pixel 9", app_version="0.2.0")
    assert again["device_status"] == "active"

    (phone,) = (await _devices(db, user)).values()
    assert (phone.model, phone.app_version) == ("Pixel 9", "0.2.0")
    assert len(await audit_rows(db, "device.registered")) == 1


async def test_pending_phone_logging_in_again_stays_the_same_request(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db)
    await _mobile_login(client, user, 1)
    await _mobile_login(client, user, 2)
    again = await _mobile_login(client, user, 2)
    assert again["device_status"] == "pending"
    assert len(await _devices(db, user)) == 2
    assert len(await audit_rows(db, "device.change_requested")) == 1


async def test_third_phone_replaces_the_older_pending_request(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db)
    first = await _mobile_login(client, user, 1)
    second = await _mobile_login(client, user, 2)
    third = await _mobile_login(client, user, 3)
    assert third["device_status"] == "pending"

    phones = await _devices(db, user)
    assert phones[device(1)["device_id"]].status == "active"
    assert phones[device(2)["device_id"]].status == "revoked"
    assert phones[device(3)["device_id"]].status == "pending"
    assert await _refresh_status(client, second) == 401
    assert await _refresh_status(client, third) == 200
    assert await _refresh_status(client, first) == 200


async def test_a_revoked_phone_logging_in_again_is_a_new_request(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db)
    await _mobile_login(client, user, 1)
    await _mobile_login(client, user, 2)
    await _mobile_login(client, user, 3)  # phone 2 is now revoked

    back = await _mobile_login(client, user, 2)
    assert back["device_status"] == "pending"
    rows = (await db.execute(select(UserDevice).where(UserDevice.user_id == user.id))).scalars()
    assert sorted(r.status for r in rows if r.device_id == device(2)["device_id"]) == [
        "pending",
        "revoked",
    ]


async def test_each_user_has_their_own_device_rows(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    alice, bob = await make_user(db), await make_user(db)
    assert (await _mobile_login(client, alice, 1))["device_status"] == "active"
    assert (await _mobile_login(client, bob, 1))["device_status"] == "active"


async def test_web_login_creates_no_device(client: httpx.AsyncClient, db: AsyncSession) -> None:
    user = await make_user(db, ASSIGNER)
    response = await login(client, user, kind="web")
    assert response.status_code == 200
    tokens = response.json()
    assert tokens["device_status"] is None
    assert (await _me(client, tokens))["device"] is None
    assert await _devices(db, user) == {}
    assert await audit_rows(db, "device.registered") == []


async def test_mobile_login_without_device_info_is_rejected(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db)
    response = await client.post(
        f"{API}/auth/login",
        json={"identifier": user.emp_code, "password": "Correct-Horse-1234", "client": "mobile"},
    )
    assert response.status_code == 422
    assert await _devices(db, user) == {}
