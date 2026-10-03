from typing import Any

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.auth.permissions import ALL_PERMISSIONS
from app.modules.employees.models import Role
from tests.factories import (
    ADMIN,
    ASSIGNER,
    FIELD,
    OFFICE,
    SUPER_ADMIN,
    auth_headers,
    login,
    make_department,
    make_user,
    role_id,
)
from tests.modules.employees.helpers import (
    API,
    EMPLOYEES,
    actor,
    audit_rows,
    error_code,
    get_user,
)


def url(user_id: int) -> str:
    return f"{EMPLOYEES}/{user_id}"


async def test_update_changes_only_the_fields_sent(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    dept = await make_department(db)
    target = await make_user(db, FIELD, email="old@example.com")
    original_code, original_email = target.emp_code, target.email

    response = await client.patch(
        url(target.id),
        json={
            "name": "  Brand New Name ",
            "mobile": "+91 98765-43210",
            "department_id": dept.id,
            "field_eligible": True,
            "joined_on": "2025-12-31",
            "role_id": await role_id(db, OFFICE),
        },
        headers=headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == "Brand New Name"
    assert body["mobile"] == "+919876543210"
    assert body["department"]["id"] == dept.id
    assert body["field_eligible"] is True
    assert body["joined_on"] == "2025-12-31"
    assert body["role"]["name"] == OFFICE
    assert body["emp_code"] == original_code
    assert body["email"] == original_email


async def test_explicit_null_clears_optional_fields(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    dept = await make_department(db)
    manager = await make_user(db, ASSIGNER)
    target = await make_user(
        db, FIELD, email="clear@example.com", department_id=dept.id, manager_id=manager.id
    )
    response = await client.patch(
        url(target.id),
        json={"email": None, "department_id": None, "manager_id": None},
        headers=headers,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["email"] is None
    assert body["department"] is None
    assert body["manager_id"] is None


@pytest.mark.parametrize(
    "field",
    ["name", "mobile", "designation_id", "role_id", "joined_on", "field_eligible", "status"],
)
async def test_null_for_a_required_field_is_rejected(
    client: httpx.AsyncClient, db: AsyncSession, field: str
) -> None:
    _, headers = await actor(client, db)
    target = await make_user(db, FIELD)
    response = await client.patch(url(target.id), json={field: None}, headers=headers)
    assert response.status_code == 422
    assert error_code(response) == "VALIDATION_ERROR"


@pytest.mark.parametrize(
    "body",
    [{"mobile": "123"}, {"email": "nope"}, {"status": "banned"}, {"name": ""}],
)
async def test_invalid_values_are_rejected(
    client: httpx.AsyncClient, db: AsyncSession, body: dict[str, Any]
) -> None:
    _, headers = await actor(client, db)
    target = await make_user(db, FIELD)
    response = await client.patch(url(target.id), json=body, headers=headers)
    assert response.status_code == 422
    assert error_code(response) == "VALIDATION_ERROR"


async def test_update_unknown_employee_is_404(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    response = await client.patch(url(999_999), json={"name": "X"}, headers=headers)
    assert response.status_code == 404
    assert error_code(response) == "NOT_FOUND"


async def test_update_needs_employees_manage(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db, ASSIGNER)
    target = await make_user(db, FIELD)
    response = await client.patch(url(target.id), json={"name": "X"}, headers=headers)
    assert response.status_code == 403


async def test_duplicate_mobile_or_email_is_rejected_but_own_values_are_fine(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    other = await make_user(db, FIELD, mobile="9000000002", email="taken@example.com")
    target = await make_user(db, FIELD, mobile="9000000003", email="mine@example.com")

    for body, field in (
        ({"mobile": other.mobile}, "mobile"),
        ({"email": "TAKEN@example.com"}, "email"),
    ):
        response = await client.patch(url(target.id), json=body, headers=headers)
        assert response.status_code == 409
        assert error_code(response) == "DUPLICATE"
        assert response.json()["error"]["details"] == {"fields": [field]}

    same = await client.patch(
        url(target.id), json={"mobile": "9000000003", "email": "mine@example.com"}, headers=headers
    )
    assert same.status_code == 200


@pytest.mark.parametrize("field", ["designation_id", "department_id", "manager_id"])
async def test_unknown_reference_is_rejected(
    client: httpx.AsyncClient, db: AsyncSession, field: str
) -> None:
    _, headers = await actor(client, db)
    target = await make_user(db, FIELD)
    response = await client.patch(url(target.id), json={field: 999_999}, headers=headers)
    assert response.status_code == 422
    assert error_code(response) == "INVALID_REFERENCE"


async def test_unknown_role_is_rejected(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    target = await make_user(db, FIELD)
    response = await client.patch(url(target.id), json={"role_id": 999_999}, headers=headers)
    assert response.status_code == 422
    assert error_code(response) == "INVALID_REFERENCE"


async def test_inactive_manager_is_rejected(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    manager = await make_user(db, ASSIGNER, status="inactive")
    target = await make_user(db, FIELD)
    response = await client.patch(url(target.id), json={"manager_id": manager.id}, headers=headers)
    assert response.status_code == 422
    assert error_code(response) == "INVALID_REFERENCE"


# --- own account -----------------------------------------------------------------------------


@pytest.mark.parametrize("change", ["other_role", "same_role", "inactive", "active"])
async def test_cannot_change_own_role_or_status(
    client: httpx.AsyncClient, db: AsyncSession, change: str
) -> None:
    me, headers = await actor(client, db)
    body = {
        "other_role": {"role_id": await role_id(db, FIELD)},
        "same_role": {"role_id": me.role_id},
        "inactive": {"status": "inactive"},
        "active": {"status": "active"},
    }[change]
    response = await client.patch(url(me.id), json=body, headers=headers)
    assert response.status_code == 403
    assert error_code(response) == "FORBIDDEN"
    await db.refresh(me)
    assert me.status == "active"
    assert me.role.name == ADMIN


async def test_can_change_own_name(client: httpx.AsyncClient, db: AsyncSession) -> None:
    me, headers = await actor(client, db)
    response = await client.patch(url(me.id), json={"name": "Me Again"}, headers=headers)
    assert response.status_code == 200
    assert response.json()["name"] == "Me Again"


# --- manager hierarchy -----------------------------------------------------------------------


@pytest.mark.parametrize("new_manager", ["self", "report", "grand_report"])
async def test_manager_cycle_is_rejected(
    client: httpx.AsyncClient, db: AsyncSession, new_manager: str
) -> None:
    _, headers = await actor(client, db)
    top = await make_user(db, ASSIGNER)
    report = await make_user(db, ASSIGNER, manager_id=top.id)
    grand_report = await make_user(db, ASSIGNER, manager_id=report.id)
    chosen = {"self": top, "report": report, "grand_report": grand_report}[new_manager]

    response = await client.patch(url(top.id), json={"manager_id": chosen.id}, headers=headers)
    assert response.status_code == 409
    assert error_code(response) == "MANAGER_CYCLE"
    await db.refresh(top)
    assert top.manager_id is None


async def test_moving_down_the_tree_without_a_cycle_is_allowed(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    top = await make_user(db, ASSIGNER)
    report = await make_user(db, ASSIGNER, manager_id=top.id)
    sibling = await make_user(db, ASSIGNER, manager_id=top.id)
    response = await client.patch(url(report.id), json={"manager_id": sibling.id}, headers=headers)
    assert response.status_code == 200
    assert response.json()["manager_id"] == sibling.id


async def test_cannot_deactivate_a_manager_with_active_reports(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    manager = await make_user(db, ASSIGNER)
    await make_user(db, FIELD, manager_id=manager.id)
    await make_user(db, FIELD, manager_id=manager.id, status="inactive")

    response = await client.patch(url(manager.id), json={"status": "inactive"}, headers=headers)
    assert response.status_code == 409
    assert error_code(response) == "HAS_REPORTS"
    assert response.json()["error"]["details"] == {"active_reports": 1}
    await db.refresh(manager)
    assert manager.status == "active"


async def test_manager_with_only_inactive_reports_can_be_deactivated(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    manager = await make_user(db, ASSIGNER)
    await make_user(db, FIELD, manager_id=manager.id, status="inactive")
    response = await client.patch(url(manager.id), json={"status": "inactive"}, headers=headers)
    assert response.status_code == 200


# --- last Super Admin ------------------------------------------------------------------------


async def _everything_actor(
    client: httpx.AsyncClient, db: AsyncSession
) -> tuple[Any, dict[str, str]]:
    """An active user whose custom role holds every permission, so they may manage Super Admins."""
    role = Role(name="Everything", permissions=sorted(ALL_PERMISSIONS))
    db.add(role)
    await db.flush()
    user = await make_user(db, FIELD)
    user.role_id = role.id
    await db.flush()
    await db.refresh(user)
    return user, await auth_headers(client, user)


async def test_cannot_deactivate_the_last_active_super_admin(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await _everything_actor(client, db)
    only_super = await make_user(db, SUPER_ADMIN)
    response = await client.patch(url(only_super.id), json={"status": "inactive"}, headers=headers)
    assert response.status_code == 409
    assert error_code(response) == "LAST_SUPER_ADMIN"


async def test_cannot_change_the_role_of_the_last_super_admin(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await _everything_actor(client, db)
    only_super = await make_user(db, SUPER_ADMIN)
    response = await client.patch(
        url(only_super.id), json={"role_id": await role_id(db, FIELD)}, headers=headers
    )
    assert response.status_code == 409
    assert error_code(response) == "LAST_SUPER_ADMIN"
    await db.refresh(only_super)
    assert only_super.role.name == SUPER_ADMIN


async def test_one_of_two_super_admins_can_be_deactivated(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db, SUPER_ADMIN)
    other = await make_user(db, SUPER_ADMIN)
    response = await client.patch(url(other.id), json={"status": "inactive"}, headers=headers)
    assert response.status_code == 200
    assert response.json()["status"] == "inactive"


# --- sessions and reactivation ---------------------------------------------------------------


async def test_deactivation_revokes_sessions_and_reactivation_restores_login(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    target = await make_user(db, ASSIGNER)
    tokens = (await login(client, target)).json()
    bearer = {"Authorization": f"Bearer {tokens['access_token']}"}
    assert (await client.get(f"{API}/me", headers=bearer)).status_code == 200

    response = await client.patch(url(target.id), json={"status": "inactive"}, headers=headers)
    assert response.status_code == 200

    assert (await client.get(f"{API}/me", headers=bearer)).status_code == 401
    refresh = await client.post(
        f"{API}/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
    )
    assert refresh.status_code == 401
    assert (await login(client, target)).status_code == 401

    response = await client.patch(url(target.id), json={"status": "active"}, headers=headers)
    assert response.status_code == 200
    assert response.json()["status"] == "active"
    assert (await login(client, target)).status_code == 200


async def test_update_writes_before_and_after_to_the_audit_log(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    admin, headers = await actor(client, db)
    target = await make_user(db, FIELD, name="Before Name")
    await client.patch(url(target.id), json={"name": "After Name"}, headers=headers)

    (row,) = await audit_rows(db, "employee.update")
    assert row.actor_id == admin.id
    assert row.entity_id == str(target.id)
    assert row.before is not None
    assert row.after is not None
    assert row.before["name"] == "Before Name"
    assert row.after["name"] == "After Name"
    assert "password_hash" not in row.before
    assert "password_hash" not in row.after


async def test_failed_update_leaves_no_audit_row(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    target = await make_user(db, ASSIGNER)
    await make_user(db, FIELD, manager_id=target.id)
    await client.patch(url(target.id), json={"status": "inactive"}, headers=headers)
    assert await audit_rows(db, "employee.update") == []
    assert (await get_user(db, target.id)).status == "active"
