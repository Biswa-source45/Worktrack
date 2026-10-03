"""GET /admin/dashboard: headline counts for the admin home page."""

from typing import Any

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from tests.factories import ASSIGNER, FIELD, OFFICE, device, login, make_user
from tests.modules.employees.helpers import API, actor

DASHBOARD = f"{API}/admin/dashboard"


async def _get(client: httpx.AsyncClient, headers: dict[str, str]) -> dict[str, Any]:
    response = await client.get(DASHBOARD, headers=headers)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


async def test_dashboard_has_the_agreed_shape(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    body = await _get(client, headers)
    assert set(body) == {
        "employees_total",
        "employees_active",
        "employees_inactive",
        "pending_devices",
    }
    assert all(isinstance(v, int) for v in body.values())
    assert body["employees_total"] == body["employees_active"] + body["employees_inactive"]


async def test_counts_follow_created_and_deactivated_employees(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    before = await _get(client, headers)

    await make_user(db, OFFICE)
    await make_user(db, FIELD)
    await make_user(db, FIELD, status="inactive")
    after = await _get(client, headers)

    assert after["employees_total"] == before["employees_total"] + 3
    assert after["employees_active"] == before["employees_active"] + 2
    assert after["employees_inactive"] == before["employees_inactive"] + 1
    assert after["pending_devices"] == before["pending_devices"]


async def test_pending_devices_counts_only_waiting_phones(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    before = await _get(client, headers)

    user = await make_user(db, FIELD)
    await login(client, user, kind="mobile", device_info=device(1))  # active, not counted
    assert (await _get(client, headers))["pending_devices"] == before["pending_devices"]
    await login(client, user, kind="mobile", device_info=device(2))  # waits for approval
    assert (await _get(client, headers))["pending_devices"] == before["pending_devices"] + 1


async def test_dashboard_needs_employees_manage(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db, ASSIGNER)
    denied = await client.get(DASHBOARD, headers=headers)
    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "FORBIDDEN"
    assert (await client.get(DASHBOARD)).status_code == 401
