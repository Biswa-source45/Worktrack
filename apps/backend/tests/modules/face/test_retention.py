"""SRS 13: face photos and templates are deleted when an employee has been gone long enough."""

import datetime as dt
from typing import Any

import httpx
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import utcnow
from app.modules.audit.service import AuditCtx
from app.modules.employees.models import User
from app.modules.face import service
from app.modules.org_settings.models import Setting
from tests.factories import ADMIN
from tests.modules.employees.helpers import API, actor, audit_rows
from tests.modules.face.test_enrollment import approved, enrolled, good, rows, send, stored


def _state(client: httpx.AsyncClient) -> Any:
    transport = client._transport
    assert isinstance(transport, httpx.ASGITransport)
    return transport.app.state


async def left(db: AsyncSession, user: User, days_ago: float) -> None:
    await db.execute(
        update(User)
        .where(User.id == user.id)
        .values(status="inactive", deactivated_at=utcnow() - dt.timedelta(days=days_ago))
    )


async def purge(client: httpx.AsyncClient, db: AsyncSession) -> int:
    state = _state(client)
    return await service.purge_departed(
        db, state.s3, state.settings.s3_bucket, AuditCtx(None, None)
    )


async def test_the_face_of_someone_who_left_over_30_days_ago_is_deleted(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user, _, _, _ = await approved(client, db)
    keys = list((await rows(db, user))[0].image_keys or [])
    assert all(stored(client, key) for key in keys)
    await left(db, user, 31)
    assert await purge(client, db) == 1
    (row,) = await rows(db, user)
    assert (row.status, row.reason) == ("reset", "Employee left")
    assert (row.embeddings, row.image_keys) == (None, None)
    assert not any(stored(client, key) for key in keys)
    (audit,) = await audit_rows(db, "face_enrollment.purge")
    assert audit.actor_id is None
    assert audit.after == {"user_id": user.id, "status": "reset", "reason": "Employee left"}
    assert await purge(client, db) == 0  # nothing left to delete


async def test_a_pending_enrollment_is_deleted_too(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user, _, _ = await enrolled(client, db)
    await left(db, user, 40)
    assert await purge(client, db) == 1
    assert (await rows(db, user))[0].status == "reset"


async def test_nobody_else_is_touched(client: httpx.AsyncClient, db: AsyncSession) -> None:
    recent, _, _, _ = await approved(client, db, 1, "a")
    still_here, _, _, _ = await approved(client, db, 2, "b")
    came_back, _, _, _ = await approved(client, db, 3, "c")
    await left(db, recent, 29)
    await left(db, came_back, 60)
    await db.execute(
        update(User).where(User.id == came_back.id).values(status="active", deactivated_at=None)
    )
    assert await purge(client, db) == 0
    for user in (recent, still_here, came_back):
        assert (await rows(db, user))[0].status == "approved"
    assert await audit_rows(db, "face_enrollment.purge") == []


async def test_the_retention_period_comes_from_settings(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user, _, _, _ = await approved(client, db)
    await left(db, user, 5)
    assert await purge(client, db) == 0
    db.add(Setting(key="face_retention_days_after_exit", value=3))
    await db.flush()
    assert await purge(client, db) == 1


async def test_a_person_who_comes_back_after_the_purge_enrolls_again(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user, headers, _, _ = await approved(client, db)
    await left(db, user, 31)
    await purge(client, db)
    await db.execute(
        update(User).where(User.id == user.id).values(status="active", deactivated_at=None)
    )
    mine = f"{API}/me/face-enrollment"
    assert (await client.get(mine, headers=headers)).json()["status"] == "reset"
    # The old face is gone: a new consent and new photos are needed, and an admin approves again.
    assert (await client.post(f"{mine}/consent", headers=headers)).status_code == 201
    assert (await send(client, headers, good())).status_code == 201
    assert [row.status for row in await rows(db, user)] == ["reset", "pending"]


async def test_deactivating_starts_the_clock_and_reactivating_stops_it(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, admin = await actor(client, db, ADMIN)
    user, _, _, _ = await approved(client, db)
    url = f"{API}/admin/employees/{user.id}"
    before = utcnow()
    assert (await client.patch(url, json={"status": "inactive"}, headers=admin)).status_code == 200
    await db.refresh(user)
    assert user.deactivated_at is not None and user.deactivated_at >= before
    stamped = user.deactivated_at
    # An edit that keeps the person inactive does not restart the clock.
    assert (await client.patch(url, json={"name": "Renamed"}, headers=admin)).status_code == 200
    await db.refresh(user)
    assert user.deactivated_at == stamped
    assert (await client.patch(url, json={"status": "active"}, headers=admin)).status_code == 200
    await db.refresh(user)
    assert user.deactivated_at is None
    assert (await rows(db, user))[0].status == "approved"  # still enrolled: nothing is deleted yet
