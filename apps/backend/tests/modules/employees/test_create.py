import json
from typing import Any

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from tests.factories import (
    ASSIGNER,
    FIELD,
    OFFICE,
    designation_id,
    employee_payload,
    login,
    make_department,
    make_user,
    role_id,
)
from tests.modules.employees.helpers import (
    EMPLOYEES,
    actor,
    audit_rows,
    error_code,
    get_user,
    post_employee,
)


async def test_create_without_password_returns_temporary_password(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    response = await post_employee(
        client,
        db,
        headers,
        emp_code=" eng-7 ",
        mobile="+91 90000-00007",
        email="New.Hire@Example.com",
    )
    assert response.status_code == 201, response.text
    body = response.json()
    temp = body["temporary_password"]
    assert len(temp) == 12
    employee = body["employee"]
    assert employee["emp_code"] == "ENG-7"
    assert employee["mobile"] == "+919000000007"
    assert employee["email"] == "new.hire@example.com"
    assert employee["must_change_password"] is True
    assert employee["status"] == "active"

    # The generated password works for the first (mobile, Field Employee) login.
    new_user = await get_user(db, employee["id"])
    first_login = await login(client, new_user, password=temp, kind="mobile")
    assert first_login.status_code == 200
    assert first_login.json()["must_change_password"] is True


async def test_create_with_password_returns_no_temporary_password(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    response = await post_employee(client, db, headers, password="Chosen-Password-77")
    assert response.status_code == 201
    body = response.json()
    assert body["temporary_password"] is None
    assert body["employee"]["must_change_password"] is True
    new_user = await get_user(db, body["employee"]["id"])
    assert (
        await login(client, new_user, password="Chosen-Password-77", kind="mobile")
    ).status_code == 200


async def test_create_writes_audit_row_without_secrets(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    admin, headers = await actor(client, db)
    response = await post_employee(client, db, headers, password="Chosen-Password-77")
    employee_id = response.json()["employee"]["id"]

    (row,) = await audit_rows(db, "employee.create")
    assert row.actor_id == admin.id
    assert row.entity == "user"
    assert row.entity_id == str(employee_id)
    assert row.before is None
    assert row.after is not None
    dumped = json.dumps([row.before, row.after]).lower()
    assert "password" not in dumped
    assert "chosen-password-77" not in dumped
    assert "argon2" not in dumped


async def test_create_with_active_manager_and_department(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    manager = await make_user(db, ASSIGNER)
    department = await make_department(db)
    response = await post_employee(
        client, db, headers, manager_id=manager.id, department_id=department.id
    )
    assert response.status_code == 201
    employee = response.json()["employee"]
    assert employee["manager_id"] == manager.id
    assert employee["department"] == {"id": department.id, "name": department.name}


@pytest.mark.parametrize(
    ("overrides", "fields"),
    [
        ({"emp_code": "dup-1"}, ["emp_code"]),
        ({"emp_code": "DUP-1"}, ["emp_code"]),
        ({"mobile": "9000000001"}, ["mobile"]),
        ({"mobile": "90000 00001"}, ["mobile"]),
        ({"email": "dup@example.com"}, ["email"]),
        ({"email": "DUP@Example.com"}, ["email"]),
        (
            {"emp_code": "DUP-1", "mobile": "9000000001", "email": "dup@example.com"},
            ["email", "emp_code", "mobile"],
        ),
    ],
)
async def test_duplicate_is_rejected_with_field_names(
    client: httpx.AsyncClient,
    db: AsyncSession,
    overrides: dict[str, Any],
    fields: list[str],
) -> None:
    _, headers = await actor(client, db)
    await make_user(db, OFFICE, emp_code="DUP-1", mobile="9000000001", email="dup@example.com")
    response = await post_employee(client, db, headers, **overrides)
    assert response.status_code == 409
    assert error_code(response) == "DUPLICATE"
    assert response.json()["error"]["details"] == {"fields": fields}


@pytest.mark.parametrize("field", ["designation_id", "department_id", "role_id", "manager_id"])
async def test_unknown_reference_is_rejected(
    client: httpx.AsyncClient, db: AsyncSession, field: str
) -> None:
    _, headers = await actor(client, db)
    response = await post_employee(client, db, headers, **{field: 999_999})
    assert response.status_code == 422
    assert error_code(response) == "INVALID_REFERENCE"


async def test_inactive_manager_is_rejected(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    manager = await make_user(db, ASSIGNER, status="inactive")
    response = await post_employee(client, db, headers, manager_id=manager.id)
    assert response.status_code == 422
    assert error_code(response) == "INVALID_REFERENCE"


@pytest.mark.parametrize(
    "overrides",
    [
        {"mobile": "12345"},
        {"mobile": "98765abc10"},
        {"email": "not-an-email"},
        {"password": "short"},
        {"emp_code": "bad code!"},
        {"name": "   "},
        {"joined_on": "not-a-date"},
    ],
)
async def test_invalid_input_is_a_validation_error(
    client: httpx.AsyncClient, db: AsyncSession, overrides: dict[str, Any]
) -> None:
    _, headers = await actor(client, db)
    response = await post_employee(client, db, headers, **overrides)
    assert response.status_code == 422
    assert error_code(response) == "VALIDATION_ERROR"


async def test_missing_required_field_is_a_validation_error(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    response = await client.post(EMPLOYEES, json={"name": "Only a name"}, headers=headers)
    assert response.status_code == 422
    assert error_code(response) == "VALIDATION_ERROR"


async def test_create_needs_employees_manage(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db, ASSIGNER)
    response = await post_employee(client, db, headers)
    assert response.status_code == 403
    assert error_code(response) == "FORBIDDEN"


async def test_create_requires_authentication(client: httpx.AsyncClient, db: AsyncSession) -> None:
    payload = employee_payload(await designation_id(db), await role_id(db, FIELD))
    response = await client.post(EMPLOYEES, json=payload)
    assert response.status_code == 401
