"""Device status counts on the list, and last_seen_at (set at login, moved by refresh)."""

from datetime import timedelta
from typing import Any

import httpx
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import utcnow
from app.modules.devices.models import UserDevice
from tests.factories import FIELD, device, login, make_user
from tests.modules.employees.helpers import API, actor

DEVICES = f"{API}/admin/devices"


async def _counts(
    client: httpx.AsyncClient, headers: dict[str, str], **params: Any
) -> dict[str, int]:
    response = await client.get(DEVICES, params=params, headers=headers)
    assert response.status_code == 200, response.text
    counts: dict[str, int] = response.json()["counts"]
    return counts


async def _row(db: AsyncSession, user_id: int, number: int) -> UserDevice:
    stmt = select(UserDevice).where(
        UserDevice.user_id == user_id, UserDevice.device_id == device(number)["device_id"]
    )
    row = (await db.execute(stmt)).scalar_one()
    await db.refresh(row)
    return row


async def _set_last_seen(db: AsyncSession, user_id: int, value: Any) -> None:
    await db.execute(
        update(UserDevice).where(UserDevice.user_id == user_id).values(last_seen_at=value)
    )


async def test_counts_cover_all_devices_whatever_the_filters(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    before = await _counts(client, headers)

    one = await make_user(db, FIELD)
    await login(client, one, kind="mobile", device_info=device(1))  # active
    await login(client, one, kind="mobile", device_info=device(2))  # pending, then revoked
    await login(client, one, kind="mobile", device_info=device(3))  # pending
    two = await make_user(db, FIELD)
    await login(client, two, kind="mobile", device_info=device(4))  # active

    expected = {
        "active": before["active"] + 2,
        "pending": before["pending"] + 1,
        "revoked": before["revoked"] + 1,
    }
    assert await _counts(client, headers) == expected
    assert await _counts(client, headers, status="pending") == expected
    assert await _counts(client, headers, status="revoked", user_id=two.id) == expected
    assert await _counts(client, headers, limit=1) == expected


async def test_counts_have_all_three_statuses(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    counts = await _counts(client, headers)
    assert set(counts) == {"pending", "active", "revoked"}
    assert all(isinstance(v, int) and v >= 0 for v in counts.values())


async def test_a_first_login_phone_is_listed_as_active(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    user = await make_user(db, FIELD)
    assert (await login(client, user, kind="mobile", device_info=device(1))).status_code == 200
    listing = await client.get(DEVICES, params={"status": "active"}, headers=headers)
    mine = [i for i in listing.json()["items"] if i["user_id"] == user.id]
    assert [i["status"] for i in mine] == ["active"]


async def test_login_sets_last_seen_for_a_new_and_a_returning_device(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    user = await make_user(db, FIELD)
    start = utcnow()
    await login(client, user, kind="mobile", device_info=device(1))
    assert start <= (await _row(db, user.id, 1)).last_seen_at <= utcnow()

    await _set_last_seen(db, user.id, start - timedelta(days=3))
    await login(client, user, kind="mobile", device_info=device(1))
    assert (await _row(db, user.id, 1)).last_seen_at >= start

    listing = await client.get(DEVICES, params={"user_id": user.id}, headers=headers)
    assert listing.json()["items"][0]["last_seen_at"] is not None


async def test_a_pending_phone_gets_last_seen_too(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, FIELD)
    await login(client, user, kind="mobile", device_info=device(1))
    start = utcnow()
    await login(client, user, kind="mobile", device_info=device(2))
    assert (await _row(db, user.id, 2)).last_seen_at >= start


async def test_refresh_moves_last_seen_forward(client: httpx.AsyncClient, db: AsyncSession) -> None:
    user = await make_user(db, FIELD)
    tokens = (await login(client, user, kind="mobile", device_info=device(1))).json()
    old = utcnow() - timedelta(days=3)
    await _set_last_seen(db, user.id, old)
    assert (await _row(db, user.id, 1)).last_seen_at == old

    start = utcnow()
    response = await client.post(
        f"{API}/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
    )
    assert response.status_code == 200
    assert (await _row(db, user.id, 1)).last_seen_at >= start


async def test_a_failed_refresh_does_not_touch_last_seen(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, FIELD)
    await login(client, user, kind="mobile", device_info=device(1))
    old = utcnow() - timedelta(days=3)
    await _set_last_seen(db, user.id, old)
    response = await client.post(f"{API}/auth/refresh", json={"refresh_token": "x" * 43})
    assert response.status_code == 401
    assert (await _row(db, user.id, 1)).last_seen_at == old
