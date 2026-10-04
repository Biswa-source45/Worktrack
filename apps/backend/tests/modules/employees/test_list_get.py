from typing import Any

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from tests.factories import ASSIGNER, FIELD, OFFICE, make_department, make_user, role_id
from tests.modules.employees.helpers import EMPLOYEES, actor, error_code


async def _page(
    client: httpx.AsyncClient, headers: dict[str, str], **params: Any
) -> dict[str, Any]:
    response = await client.get(EMPLOYEES, params=params, headers=headers)
    assert response.status_code == 200, response.text
    page: dict[str, Any] = response.json()
    return page


async def test_pagination_walks_every_row_once(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    dept = await make_department(db)
    created = [(await make_user(db, OFFICE, department_id=dept.id)).id for _ in range(5)]

    seen: list[int] = []
    cursor: str | None = None
    sizes: list[int] = []
    while True:
        params = {"department_id": dept.id, "limit": 2, **({"cursor": cursor} if cursor else {})}
        page = await _page(client, headers, **params)
        sizes.append(len(page["items"]))
        seen += [item["id"] for item in page["items"]]
        cursor = page["next_cursor"]
        if cursor is None:
            break
    assert sizes == [2, 2, 1]
    assert seen == created


async def test_exact_fit_last_page_has_no_cursor(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    dept = await make_department(db)
    for _ in range(2):
        await make_user(db, OFFICE, department_id=dept.id)
    page = await _page(client, headers, department_id=dept.id, limit=2)
    assert len(page["items"]) == 2
    assert page["next_cursor"] is None


async def test_invalid_cursor_is_rejected(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    response = await client.get(EMPLOYEES, params={"cursor": "abc"}, headers=headers)
    assert response.status_code == 422
    assert error_code(response) == "INVALID_CURSOR"


@pytest.mark.parametrize("limit", [0, 201])
async def test_limit_out_of_range_is_rejected(
    client: httpx.AsyncClient, db: AsyncSession, limit: int
) -> None:
    _, headers = await actor(client, db)
    response = await client.get(EMPLOYEES, params={"limit": limit}, headers=headers)
    assert response.status_code == 422
    assert error_code(response) == "VALIDATION_ERROR"


async def test_search_matches_name_code_and_mobile(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    target = await make_user(
        db, OFFICE, name="Zyxwv Quentin", emp_code="QQ-4242", mobile="9123456780"
    )
    await make_user(db, OFFICE, name="Someone Else", emp_code="OTHER-1", mobile="9123450000")

    for q in ("zyxwv", "QUENTIN", "qq-42", "9123456780", "56780"):
        page = await _page(client, headers, q=q)
        assert [i["id"] for i in page["items"]] == [target.id], q


@pytest.mark.parametrize(
    ("query", "expected_name"),
    [("ZQ50%", "ZQ50% off"), ("ZQ_a", "ZQ_a one"), ("ZQ\\", "ZQ\\ slash")],
)
async def test_search_treats_like_wildcards_literally(
    client: httpx.AsyncClient, db: AsyncSession, query: str, expected_name: str
) -> None:
    _, headers = await actor(client, db)
    for name in ("ZQ50% off", "ZQ500 off", "ZQ_a one", "ZQxa one", "ZQ\\ slash", "ZQ slash"):
        await make_user(db, OFFICE, name=name)
    page = await _page(client, headers, q=query)
    assert [i["name"] for i in page["items"]] == [expected_name]


async def test_search_with_no_match_is_empty(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    page = await _page(client, headers, q="nobody-has-this-name")
    assert page == {"items": [], "next_cursor": None}


async def test_filters_by_status_role_and_department(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    dept = await make_department(db)
    field = await make_user(db, FIELD, department_id=dept.id)
    inactive = await make_user(db, FIELD, department_id=dept.id, status="inactive")
    office = await make_user(db, OFFICE, department_id=dept.id)

    def ids(page: dict[str, Any]) -> set[int]:
        return {i["id"] for i in page["items"]}

    assert ids(await _page(client, headers, department_id=dept.id)) == {
        field.id,
        inactive.id,
        office.id,
    }
    assert ids(await _page(client, headers, department_id=dept.id, status="inactive")) == {
        inactive.id
    }
    assert ids(await _page(client, headers, department_id=dept.id, status="active")) == {
        field.id,
        office.id,
    }
    assert ids(
        await _page(client, headers, department_id=dept.id, role_id=await role_id(db, FIELD))
    ) == {field.id, inactive.id}


async def test_invalid_status_filter_is_rejected(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    response = await client.get(EMPLOYEES, params={"status": "banana"}, headers=headers)
    assert response.status_code == 422


async def test_list_never_exposes_credentials(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    page = await _page(client, headers)
    keys = set(page["items"][0])
    assert {"id", "emp_code", "role", "designation", "must_change_password"} <= keys
    assert not keys & {"password_hash", "failed_attempts"}


async def test_get_one_returns_the_employee(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    dept = await make_department(db)
    target = await make_user(db, FIELD, department_id=dept.id, email="get.one@example.com")
    response = await client.get(f"{EMPLOYEES}/{target.id}", headers=headers)
    assert response.status_code == 200
    body = response.json()
    assert body["id"] == target.id
    assert body["emp_code"] == target.emp_code
    assert body["role"]["name"] == FIELD
    assert body["department"]["id"] == dept.id
    assert body["email"] == "get.one@example.com"


async def test_get_unknown_employee_is_404(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    response = await client.get(f"{EMPLOYEES}/999999", headers=headers)
    assert response.status_code == 404
    assert error_code(response) == "NOT_FOUND"


async def test_get_non_numeric_id_is_a_validation_error(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    response = await client.get(f"{EMPLOYEES}/abc", headers=headers)
    assert response.status_code == 422


async def test_list_and_get_need_employees_manage(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db, ASSIGNER)
    target = await make_user(db, FIELD)
    assert (await client.get(EMPLOYEES, headers=headers)).status_code == 403
    assert (await client.get(f"{EMPLOYEES}/{target.id}", headers=headers)).status_code == 403
    assert (await client.get(EMPLOYEES)).status_code == 401
