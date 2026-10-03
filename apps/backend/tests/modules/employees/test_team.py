from typing import Any

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from tests.factories import ADMIN, ASSIGNER, FIELD, OFFICE, SUPER_ADMIN, auth_headers, make_user
from tests.modules.employees.helpers import API, actor, error_code

TEAM = f"{API}/employees/team"


async def _ids(client: httpx.AsyncClient, headers: dict[str, str], **params: Any) -> list[int]:
    response = await client.get(TEAM, params=params, headers=headers)
    assert response.status_code == 200, response.text
    return [i["id"] for i in response.json()["items"]]


async def test_team_has_direct_and_indirect_active_reports_only(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    boss, headers = await actor(client, db, ASSIGNER)
    direct = await make_user(db, FIELD, manager_id=boss.id)
    indirect = await make_user(db, FIELD, manager_id=direct.id)
    deep = await make_user(db, FIELD, manager_id=indirect.id)
    await make_user(db, FIELD, manager_id=boss.id, status="inactive")
    other_boss = await make_user(db, ASSIGNER)
    await make_user(db, FIELD, manager_id=other_boss.id)
    await make_user(db, OFFICE)  # no manager at all

    ids = await _ids(client, headers)
    assert sorted(ids) == sorted([direct.id, indirect.id, deep.id])
    assert boss.id not in ids


async def test_team_does_not_include_the_callers_own_manager_chain(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    director = await make_user(db, ASSIGNER)
    boss, headers = await actor(client, db, ASSIGNER, manager_id=director.id)
    report = await make_user(db, FIELD, manager_id=boss.id)
    assert await _ids(client, headers) == [report.id]


async def test_team_page_exposes_only_what_a_manager_needs(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    boss, headers = await actor(client, db, ASSIGNER)
    report = await make_user(db, FIELD, manager_id=boss.id, email="private@example.com")
    (item,) = (await client.get(TEAM, headers=headers)).json()["items"]
    assert item["emp_code"] == report.emp_code
    assert item["manager_id"] == boss.id
    assert not set(item) & {"mobile", "email", "password_hash", "status"}


async def test_team_pagination_stays_inside_the_scope(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    boss, headers = await actor(client, db, ASSIGNER)
    rival = await make_user(db, ASSIGNER)
    mine: list[int] = []
    for _ in range(5):  # ids interleave with the rival's team
        mine.append((await make_user(db, FIELD, manager_id=boss.id)).id)
        await make_user(db, FIELD, manager_id=rival.id)

    seen: list[int] = []
    cursor: str | None = None
    pages = 0
    while True:
        params = {"limit": 2, **({"cursor": cursor} if cursor else {})}
        response = await client.get(TEAM, params=params, headers=headers)
        body = response.json()
        seen += [i["id"] for i in body["items"]]
        pages += 1
        cursor = body["next_cursor"]
        if cursor is None:
            break
    assert pages == 3
    assert seen == mine


async def test_team_of_someone_without_reports_is_empty(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db, ASSIGNER)
    assert (await client.get(TEAM, headers=headers)).json() == {"items": [], "next_cursor": None}


async def test_team_invalid_cursor_is_rejected(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db, ASSIGNER)
    response = await client.get(TEAM, params={"cursor": "x"}, headers=headers)
    assert response.status_code == 422
    assert error_code(response) == "INVALID_CURSOR"


@pytest.mark.parametrize("role", [ASSIGNER, ADMIN, SUPER_ADMIN])
async def test_roles_with_team_view_can_read_the_team(
    client: httpx.AsyncClient, db: AsyncSession, role: str
) -> None:
    boss, headers = await actor(client, db, role)
    report = await make_user(db, FIELD, manager_id=boss.id)
    assert await _ids(client, headers) == [report.id]


@pytest.mark.parametrize("role", [FIELD, OFFICE])
async def test_roles_without_team_view_are_denied(
    client: httpx.AsyncClient, db: AsyncSession, role: str
) -> None:
    user = await make_user(db, role)
    headers = await auth_headers(client, user, kind="mobile")
    response = await client.get(TEAM, headers=headers)
    assert response.status_code == 403
    assert error_code(response) == "FORBIDDEN"


async def test_team_requires_authentication(client: httpx.AsyncClient) -> None:
    assert (await client.get(TEAM)).status_code == 401
