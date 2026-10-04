import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from tests.factories import ASSIGNER, FIELD, designation_id, make_department, make_user
from tests.modules.employees.helpers import API, actor, audit_rows, error_code

KINDS = ["departments", "designations"]


def url(kind: str, item_id: int | None = None) -> str:
    return f"{API}/admin/masters/{kind}" + ("" if item_id is None else f"/{item_id}")


@pytest.mark.parametrize("kind", KINDS)
async def test_create_list_rename_delete(
    client: httpx.AsyncClient, db: AsyncSession, kind: str
) -> None:
    admin, headers = await actor(client, db)

    created = await client.post(url(kind), json={"name": "  Zeta Unit  "}, headers=headers)
    assert created.status_code == 201
    item = created.json()
    assert item["name"] == "Zeta Unit"

    listed = await client.get(url(kind), headers=headers)
    assert listed.status_code == 200
    assert item in listed.json()

    renamed = await client.patch(
        url(kind, item["id"]), json={"name": "Zeta Prime"}, headers=headers
    )
    assert renamed.status_code == 200
    assert renamed.json() == {"id": item["id"], "name": "Zeta Prime"}

    deleted = await client.delete(url(kind, item["id"]), headers=headers)
    assert deleted.status_code == 204
    assert deleted.content == b""
    assert item["id"] not in [
        i["id"] for i in (await client.get(url(kind), headers=headers)).json()
    ]

    for action in ("create", "update", "delete"):
        (row,) = await audit_rows(db, f"{kind}.{action}")
        assert row.actor_id == admin.id
        assert row.entity_id == str(item["id"])
    (update_row,) = await audit_rows(db, f"{kind}.update")
    assert update_row.before == {"name": "Zeta Unit"}
    assert update_row.after == {"name": "Zeta Prime"}


@pytest.mark.parametrize("kind", KINDS)
async def test_duplicate_name_is_rejected_case_insensitively(
    client: httpx.AsyncClient, db: AsyncSession, kind: str
) -> None:
    _, headers = await actor(client, db)
    first = (await client.post(url(kind), json={"name": "Dupe Name"}, headers=headers)).json()
    other = (await client.post(url(kind), json={"name": "Another"}, headers=headers)).json()

    again = await client.post(url(kind), json={"name": "dUPE nAME"}, headers=headers)
    assert again.status_code == 409
    assert error_code(again) == "DUPLICATE"

    clash = await client.patch(url(kind, other["id"]), json={"name": "DUPE NAME"}, headers=headers)
    assert clash.status_code == 409
    assert error_code(clash) == "DUPLICATE"

    # Renaming to its own name (different case) is not a clash.
    own = await client.patch(url(kind, first["id"]), json={"name": "DUPE name"}, headers=headers)
    assert own.status_code == 200


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("name", ["", "   ", "x" * 65])
async def test_invalid_name_is_rejected(
    client: httpx.AsyncClient, db: AsyncSession, kind: str, name: str
) -> None:
    _, headers = await actor(client, db)
    response = await client.post(url(kind), json={"name": name}, headers=headers)
    assert response.status_code == 422
    assert error_code(response) == "VALIDATION_ERROR"


@pytest.mark.parametrize("kind", KINDS)
async def test_unknown_id_is_404(client: httpx.AsyncClient, db: AsyncSession, kind: str) -> None:
    _, headers = await actor(client, db)
    patch = await client.patch(url(kind, 999_999), json={"name": "Nope"}, headers=headers)
    delete = await client.delete(url(kind, 999_999), headers=headers)
    assert patch.status_code == delete.status_code == 404
    assert error_code(delete) == "NOT_FOUND"


async def test_unknown_kind_is_rejected(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    response = await client.get(url("branches"), headers=headers)
    assert response.status_code == 422
    assert error_code(response) == "VALIDATION_ERROR"


async def test_department_in_use_cannot_be_deleted(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    dept = await make_department(db)
    await make_user(db, FIELD, department_id=dept.id)
    response = await client.delete(url("departments", dept.id), headers=headers)
    assert response.status_code == 409
    assert error_code(response) == "IN_USE"
    assert await audit_rows(db, "departments.delete") == []


async def test_designation_in_use_cannot_be_deleted(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    in_use = await designation_id(db)
    response = await client.delete(url("designations", in_use), headers=headers)
    assert response.status_code == 409
    assert error_code(response) == "IN_USE"


@pytest.mark.parametrize("kind", KINDS)
async def test_masters_need_employees_manage(
    client: httpx.AsyncClient, db: AsyncSession, kind: str
) -> None:
    _, headers = await actor(client, db, ASSIGNER)
    assert (await client.get(url(kind), headers=headers)).status_code == 403
    assert (await client.post(url(kind), json={"name": "X"}, headers=headers)).status_code == 403
    assert (
        await client.patch(url(kind, 1), json={"name": "X"}, headers=headers)
    ).status_code == 403
    assert (await client.delete(url(kind, 1), headers=headers)).status_code == 403
    assert (await client.get(url(kind))).status_code == 401
