"""An employee's home branch, shift and the restrict-to-home-branch switch."""

from typing import Any

import httpx
import pytest
from sqlalchemy import Engine, event
from sqlalchemy.ext.asyncio import AsyncSession

from tests.factories import FIELD, make_branch, make_shift, make_user
from tests.modules.employees.helpers import (
    EMPLOYEES,
    actor,
    audit_rows,
    error_code,
    get_user,
    post_employee,
)
from tests.modules.employees.test_import import csv_file, row, upload, xlsx_file


def url(employee_id: int) -> str:
    return f"{EMPLOYEES}/{employee_id}"


class Statements:
    """Records the SQL the app sends while it is active."""

    def __init__(self) -> None:
        self.sql: list[str] = []

    def _record(self, _conn: object, _cursor: object, statement: str, *_: object) -> None:
        if not statement.startswith(("SAVEPOINT", "RELEASE")):
            self.sql.append(statement)

    def __enter__(self) -> "Statements":
        event.listen(Engine, "before_cursor_execute", self._record)
        return self

    def __exit__(self, *_: object) -> None:
        event.remove(Engine, "before_cursor_execute", self._record)

    def reading(self, table: str) -> list[str]:
        return [s for s in self.sql if s.startswith("SELECT") and f"FROM {table}" in s]


# --- create -----------------------------------------------------------------------------------


async def test_create_with_a_branch_and_a_shift(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    branch, shift = await make_branch(db, "Head Office"), await make_shift(db, "General")
    response = await post_employee(
        client,
        db,
        headers,
        home_branch_id=branch.id,
        shift_id=shift.id,
        restrict_to_home_branch=True,
    )
    assert response.status_code == 201, response.text
    employee = response.json()["employee"]
    assert employee["home_branch"] == {"id": branch.id, "name": "Head Office"}
    assert employee["shift"] == {"id": shift.id, "name": "General"}
    assert employee["restrict_to_home_branch"] is True
    assert (await client.get(url(employee["id"]), headers=headers)).json() == employee

    [row_] = await audit_rows(db, "employee.create")
    after = row_.after or {}
    assert (after["home_branch_id"], after["shift_id"]) == (branch.id, shift.id)
    assert after["restrict_to_home_branch"] is True


async def test_branch_and_shift_are_optional(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    employee = (await post_employee(client, db, headers)).json()["employee"]
    assert employee["home_branch"] is None
    assert employee["shift"] is None
    assert employee["restrict_to_home_branch"] is False


async def test_restricting_needs_a_home_branch_on_create(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    response = await post_employee(client, db, headers, restrict_to_home_branch=True)
    assert (response.status_code, error_code(response)) == (422, "VALIDATION_ERROR")
    assert "home branch" in response.json()["error"]["details"][0]["message"]
    assert await audit_rows(db, "employee.create") == []


@pytest.mark.parametrize("field", ["home_branch_id", "shift_id"])
@pytest.mark.parametrize("state", ["missing", "inactive"])
async def test_create_needs_an_existing_active_branch_and_shift(
    client: httpx.AsyncClient, db: AsyncSession, field: str, state: str
) -> None:
    _, headers = await actor(client, db)
    make = make_branch if field == "home_branch_id" else make_shift
    value = 999_999_999 if state == "missing" else (await make(db, is_active=False)).id
    response = await post_employee(client, db, headers, **{field: value})
    assert (response.status_code, error_code(response)) == (422, "INVALID_REFERENCE")
    assert "does not exist or is inactive" in response.json()["error"]["message"]
    assert await audit_rows(db, "employee.create") == []


# --- update -----------------------------------------------------------------------------------


async def test_update_sets_and_clears_the_branch_and_shift(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    target = await make_user(db, FIELD)
    branch, shift = await make_branch(db), await make_shift(db)

    change = {"home_branch_id": branch.id, "shift_id": shift.id, "restrict_to_home_branch": True}
    response = await client.patch(url(target.id), json=change, headers=headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["home_branch"] == {"id": branch.id, "name": branch.name}
    assert body["shift"] == {"id": shift.id, "name": shift.name}
    assert body["restrict_to_home_branch"] is True

    # An unrelated change leaves them alone.
    renamed = await client.patch(url(target.id), json={"name": "Renamed"}, headers=headers)
    assert renamed.json()["home_branch"] == {"id": branch.id, "name": branch.name}
    assert renamed.json()["restrict_to_home_branch"] is True

    cleared = await client.patch(
        url(target.id),
        json={"home_branch_id": None, "shift_id": None, "restrict_to_home_branch": False},
        headers=headers,
    )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["home_branch"] is None
    assert cleared.json()["shift"] is None
    assert cleared.json()["restrict_to_home_branch"] is False
    stored = await get_user(db, target.id)
    assert (stored.home_branch_id, stored.shift_id) == (None, None)

    first, _, last = await audit_rows(db, "employee.update")
    assert (first.before or {})["home_branch_id"] is None
    assert (first.after or {})["home_branch_id"] == branch.id
    assert (first.after or {})["shift_id"] == shift.id
    assert (first.after or {})["restrict_to_home_branch"] is True
    assert (last.after or {})["home_branch_id"] is None
    assert (last.after or {})["restrict_to_home_branch"] is False


@pytest.mark.parametrize(
    "change",
    [
        {"restrict_to_home_branch": True},
        {"restrict_to_home_branch": True, "home_branch_id": None},
    ],
)
async def test_restricting_needs_a_home_branch_on_update(
    client: httpx.AsyncClient, db: AsyncSession, change: dict[str, Any]
) -> None:
    _, headers = await actor(client, db)
    target = await make_user(db, FIELD)
    response = await client.patch(url(target.id), json=change, headers=headers)
    assert (response.status_code, error_code(response)) == (422, "VALIDATION_ERROR")
    assert "home branch" in response.json()["error"]["message"]
    assert (await get_user(db, target.id)).restrict_to_home_branch is False
    assert await audit_rows(db, "employee.update") == []


async def test_the_home_branch_of_a_restricted_employee_cannot_just_be_cleared(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    branch = await make_branch(db)
    target = await make_user(db, FIELD, home_branch_id=branch.id, restrict_to_home_branch=True)
    response = await client.patch(url(target.id), json={"home_branch_id": None}, headers=headers)
    assert (response.status_code, error_code(response)) == (422, "VALIDATION_ERROR")
    assert (await get_user(db, target.id)).home_branch_id == branch.id

    # Moving them to another branch keeps the restriction.
    other = await make_branch(db)
    moved = await client.patch(url(target.id), json={"home_branch_id": other.id}, headers=headers)
    assert moved.status_code == 200
    assert moved.json()["home_branch"]["id"] == other.id
    assert moved.json()["restrict_to_home_branch"] is True


async def test_restrict_to_home_branch_cannot_be_null(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    target = await make_user(db, FIELD)
    response = await client.patch(
        url(target.id), json={"restrict_to_home_branch": None}, headers=headers
    )
    assert (response.status_code, error_code(response)) == (422, "VALIDATION_ERROR")


@pytest.mark.parametrize("field", ["home_branch_id", "shift_id"])
@pytest.mark.parametrize("state", ["missing", "inactive"])
async def test_update_needs_an_existing_active_branch_and_shift(
    client: httpx.AsyncClient, db: AsyncSession, field: str, state: str
) -> None:
    _, headers = await actor(client, db)
    target = await make_user(db, FIELD)
    make = make_branch if field == "home_branch_id" else make_shift
    value = 999_999_999 if state == "missing" else (await make(db, is_active=False)).id
    response = await client.patch(url(target.id), json={field: value}, headers=headers)
    assert (response.status_code, error_code(response)) == (422, "INVALID_REFERENCE")
    assert getattr(await get_user(db, target.id), field) is None


async def test_an_employee_keeps_a_branch_and_shift_that_were_deactivated_later(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    branch, shift = await make_branch(db), await make_shift(db)
    target = await make_user(db, FIELD, home_branch_id=branch.id, shift_id=shift.id)
    branch.is_active = False
    shift.is_active = False
    await db.flush()

    # The edit form sends every field back, including the ones that did not change.
    body = {"name": "Renamed", "home_branch_id": branch.id, "shift_id": shift.id}
    response = await client.patch(url(target.id), json=body, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["home_branch"] == {"id": branch.id, "name": branch.name}
    assert response.json()["shift"] == {"id": shift.id, "name": shift.name}


# --- list -------------------------------------------------------------------------------------


async def test_the_list_reads_branches_and_shifts_in_the_same_query(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    branches = [await make_branch(db) for _ in range(3)]
    shifts = [await make_shift(db) for _ in range(3)]
    people = [
        await make_user(db, FIELD, home_branch_id=branch.id, shift_id=shift.id, name="Listed One")
        for branch, shift in zip(branches, shifts, strict=True)
    ]
    db.expunge_all()  # production opens a fresh session per request
    with Statements() as statements:
        response = await client.get(EMPLOYEES, params={"q": "Listed One"}, headers=headers)
    assert response.status_code == 200
    items = {item["id"]: item for item in response.json()["items"]}
    assert set(items) == {person.id for person in people}
    for person, branch, shift in zip(people, branches, shifts, strict=True):
        assert items[person.id]["home_branch"] == {"id": branch.id, "name": branch.name}
        assert items[person.id]["shift"] == {"id": shift.id, "name": shift.name}
    # One statement authenticates the caller, one reads the page: nothing per row.
    assert len(statements.sql) == 2
    assert "JOIN branches" in statements.sql[1] and "JOIN shifts" in statements.sql[1]


# --- import -----------------------------------------------------------------------------------


@pytest.mark.parametrize("make_file", [csv_file, xlsx_file])
async def test_import_matches_branch_and_shift_by_name_with_one_lookup_each(
    client: httpx.AsyncClient, db: AsyncSession, make_file: Any
) -> None:
    _, headers = await actor(client, db)
    branch, shift = await make_branch(db, "Head Office"), await make_shift(db, "General")
    rows = [
        row(emp_code="BS-1", branch="head office", shift="GENERAL"),
        row(emp_code="BS-2", branch="Head Office"),
        row(emp_code="BS-3", shift="General"),
        row(emp_code="BS-4"),
    ]
    filename = "people.csv" if make_file is csv_file else "people.xlsx"
    with Statements() as statements:
        response = await upload(client, headers, make_file(rows), filename, dry_run=False)
    assert response.status_code == 200, response.text
    assert response.json()["created"] == 4
    assert len(statements.reading("branches")) == 1
    assert len(statements.reading("shifts")) == 1

    page = (await client.get(EMPLOYEES, params={"q": "BS-"}, headers=headers)).json()["items"]
    found = {item["emp_code"]: (item["home_branch"], item["shift"]) for item in page}
    head_office, general = (
        {"id": branch.id, "name": "Head Office"},
        {"id": shift.id, "name": "General"},
    )
    assert found == {
        "BS-1": (head_office, general),
        "BS-2": (head_office, None),
        "BS-3": (None, general),
        "BS-4": (None, None),
    }
    created = await audit_rows(db, "employee.create")
    assert [(r.after or {})["home_branch_id"] for r in created] == [
        branch.id,
        branch.id,
        None,
        None,
    ]


async def test_import_reports_an_unknown_or_inactive_branch_or_shift(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    await make_branch(db, "Head Office")
    await make_branch(db, "Closed Depot", is_active=False)
    await make_shift(db, "Retired", is_active=False)
    rows = [
        row(branch="Nowhere"),
        row(branch="Closed Depot"),
        row(shift="Night"),
        row(shift="Retired"),
        row(branch="Head Office"),
    ]
    response = await upload(client, headers, csv_file(rows), dry_run=False)
    assert response.status_code == 200
    body = response.json()
    assert body["created"] == 0
    assert [(e["row"], e["message"]) for e in body["errors"]] == [
        (2, "branch: unknown or inactive branch 'Nowhere'"),
        (3, "branch: unknown or inactive branch 'Closed Depot'"),
        (4, "shift: unknown or inactive shift 'Night'"),
        (5, "shift: unknown or inactive shift 'Retired'"),
    ]


async def test_a_file_without_the_branch_and_shift_columns_still_imports(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    header = [
        "emp_code",
        "name",
        "mobile",
        "email",
        "designation",
        "department",
        "role",
        "manager_emp_code",
        "joined_on",
        "field_eligible",
    ]
    content = csv_file([row(emp_code="OLD-1")[: len(header)]], header)
    response = await upload(client, headers, content, dry_run=False)
    assert response.status_code == 200, response.text
    assert response.json()["created"] == 1
    [item] = (await client.get(EMPLOYEES, params={"q": "OLD-1"}, headers=headers)).json()["items"]
    assert (item["home_branch"], item["shift"]) == (None, None)


async def test_the_template_has_the_branch_and_shift_columns(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    template = (await client.get(f"{EMPLOYEES}/import/template", headers=headers)).text
    header, example = (line.split(",") for line in template.splitlines())
    assert header[-2:] == ["branch", "shift"]
    assert len(example) == len(header)
