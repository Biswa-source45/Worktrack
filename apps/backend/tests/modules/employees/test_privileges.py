"""Nobody can create, change or take over an account that outranks them."""

from typing import Any

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from tests.factories import ADMIN, FIELD, SUPER_ADMIN, make_user, role_id
from tests.modules.employees.helpers import EMPLOYEES, actor, error_code, post_employee


async def test_admin_cannot_create_super_admin(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db, ADMIN)
    response = await post_employee(client, db, headers, role=SUPER_ADMIN)
    assert response.status_code == 403
    assert error_code(response) == "FORBIDDEN"


async def test_super_admin_can_create_super_admin(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db, SUPER_ADMIN)
    response = await post_employee(client, db, headers, role=SUPER_ADMIN)
    assert response.status_code == 201
    assert response.json()["employee"]["role"]["name"] == SUPER_ADMIN


async def test_admin_cannot_promote_someone_to_super_admin(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db, ADMIN)
    target = await make_user(db, FIELD)
    response = await client.patch(
        f"{EMPLOYEES}/{target.id}",
        json={"role_id": await role_id(db, SUPER_ADMIN)},
        headers=headers,
    )
    assert response.status_code == 403
    assert error_code(response) == "FORBIDDEN"


@pytest.mark.parametrize(
    ("method", "suffix", "body"),
    [
        ("PATCH", "", {"name": "Hijacked"}),
        ("PATCH", "", {"status": "inactive"}),
        ("POST", "/reset-password", None),
        ("POST", "/unlock", None),
    ],
)
async def test_admin_cannot_touch_a_super_admin_account(
    client: httpx.AsyncClient,
    db: AsyncSession,
    method: str,
    suffix: str,
    body: dict[str, Any] | None,
) -> None:
    _, headers = await actor(client, db, ADMIN)
    boss = await make_user(db, SUPER_ADMIN)
    response = await client.request(
        method, f"{EMPLOYEES}/{boss.id}{suffix}", json=body, headers=headers
    )
    assert response.status_code == 403
    assert error_code(response) == "FORBIDDEN"
    await db.refresh(boss)
    assert boss.name != "Hijacked"
    assert boss.status == "active"


async def test_super_admin_can_manage_an_admin(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db, SUPER_ADMIN)
    target = await make_user(db, ADMIN)
    response = await client.patch(
        f"{EMPLOYEES}/{target.id}", json={"name": "Renamed"}, headers=headers
    )
    assert response.status_code == 200
    assert response.json()["name"] == "Renamed"


async def test_admin_can_manage_a_peer_admin(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db, ADMIN)
    peer = await make_user(db, ADMIN)
    response = await client.patch(
        f"{EMPLOYEES}/{peer.id}", json={"name": "Renamed"}, headers=headers
    )
    assert response.status_code == 200
