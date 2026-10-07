"""The review queue: what is waiting comes first-come first-served, what was decided comes newest
first, so the person an admin has just approved is on the first page however long the history."""

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from tests.factories import ADMIN
from tests.modules.employees.helpers import actor, error_code
from tests.modules.face.test_enrollment import QUEUE, approved


async def three_approved(client: httpx.AsyncClient, db: AsyncSession) -> tuple[list[int], dict]:
    ids = []
    for n, name in ((1, "a"), (2, "b"), (3, "c")):
        ids.append((await approved(client, db, n, name))[2])
    _, admin = await actor(client, db, ADMIN)
    return ids, admin


async def test_decided_enrollments_are_listed_newest_first(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    ids, admin = await three_approved(client, db)
    body = (await client.get(QUEUE, params={"status": "approved"}, headers=admin)).json()
    assert [i["id"] for i in body["items"]] == ids[::-1]


async def test_decided_enrollments_page_by_cursor_newest_first(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    ids, admin = await three_approved(client, db)
    params = {"status": "approved", "limit": 2}
    first = (await client.get(QUEUE, params=params, headers=admin)).json()
    assert [i["id"] for i in first["items"]] == [ids[2], ids[1]]
    assert first["next_cursor"] is not None
    rest = (
        await client.get(QUEUE, params={**params, "cursor": first["next_cursor"]}, headers=admin)
    ).json()
    assert [i["id"] for i in rest["items"]] == [ids[0]]
    assert rest["next_cursor"] is None


async def test_a_bad_cursor_on_a_decided_list_is_refused(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, admin = await actor(client, db, ADMIN)
    bad = await client.get(QUEUE, params={"status": "approved", "cursor": "x"}, headers=admin)
    assert (bad.status_code, error_code(bad)) == (422, "INVALID_CURSOR")
