import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.auth.permissions import (
    PUNCHOUT_APPROVE,
    ROLES_MANAGE,
    TASKS_CREATE,
    TEAM_VIEW,
    WEB_ACCESS,
)
from app.modules.employees.models import Role
from tests.factories import (
    ADMIN,
    ALL_ROLES,
    ASSIGNER,
    FIELD,
    SUPER_ADMIN,
    auth_headers,
    make_user,
    role_id,
)
from tests.modules.employees.helpers import API, actor, audit_rows, error_code

ROLES = f"{API}/admin/roles"
TEAM = f"{API}/employees/team"


async def _custom_role(db: AsyncSession, name: str, permissions: list[str]) -> Role:
    role = Role(name=name, permissions=permissions)
    db.add(role)
    await db.flush()
    return role


async def test_list_roles_includes_the_system_roles(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    response = await client.get(ROLES, headers=headers)
    assert response.status_code == 200
    by_name = {r["name"]: r for r in response.json()}
    assert set(ALL_ROLES) <= set(by_name)
    assert all(by_name[name]["is_system"] for name in ALL_ROLES)
    assert set(by_name[ASSIGNER]["permissions"]) == {
        WEB_ACCESS,
        TEAM_VIEW,
        PUNCHOUT_APPROVE,
        TASKS_CREATE,
    }
    assert by_name[FIELD]["permissions"] == []


async def test_super_admin_creates_a_role(client: httpx.AsyncClient, db: AsyncSession) -> None:
    boss, headers = await actor(client, db, SUPER_ADMIN)
    response = await client.post(
        ROLES,
        json={"name": " Supervisor ", "permissions": [TEAM_VIEW, WEB_ACCESS, TEAM_VIEW]},
        headers=headers,
    )
    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "Supervisor"
    assert body["permissions"] == [TEAM_VIEW, WEB_ACCESS]  # de-duplicated and sorted
    assert body["is_system"] is False

    (row,) = await audit_rows(db, "role.create")
    assert row.actor_id == boss.id
    assert row.after == {"name": "Supervisor", "permissions": [TEAM_VIEW, WEB_ACCESS]}


async def test_unknown_permission_key_is_rejected(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db, SUPER_ADMIN)
    create = await client.post(
        ROLES, json={"name": "Bad", "permissions": ["teleport.anywhere"]}, headers=headers
    )
    assert create.status_code == 422
    assert error_code(create) == "VALIDATION_ERROR"

    custom = await _custom_role(db, "Custom", [WEB_ACCESS])
    update = await client.patch(
        f"{ROLES}/{custom.id}", json={"permissions": ["teleport.anywhere"]}, headers=headers
    )
    assert update.status_code == 422
    assert error_code(update) == "VALIDATION_ERROR"


async def test_duplicate_role_name_is_rejected_case_insensitively(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db, SUPER_ADMIN)
    created = await client.post(ROLES, json={"name": "Auditor", "permissions": []}, headers=headers)
    assert created.status_code == 201
    for name in ("auditor", "ADMIN/hr"):
        response = await client.post(ROLES, json={"name": name, "permissions": []}, headers=headers)
        assert response.status_code == 409
        assert error_code(response) == "DUPLICATE"


async def test_invalid_role_payloads_are_rejected(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db, SUPER_ADMIN)
    for body in ({"name": "", "permissions": []}, {"name": "No perms"}):
        response = await client.post(ROLES, json=body, headers=headers)
        assert response.status_code == 422
        assert error_code(response) == "VALIDATION_ERROR"


async def test_a_role_manager_cannot_grant_permissions_it_lacks(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    limited = await _custom_role(db, "Role Keeper", [WEB_ACCESS, ROLES_MANAGE])
    user = await make_user(db, FIELD)
    user.role_id = limited.id
    await db.flush()
    await db.refresh(user)
    headers = await auth_headers(client, user)

    response = await client.post(
        ROLES, json={"name": "Greedy", "permissions": [TEAM_VIEW]}, headers=headers
    )
    assert response.status_code == 403
    assert error_code(response) == "FORBIDDEN"


async def test_update_renames_and_changes_permissions_of_a_custom_role(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    boss, headers = await actor(client, db, SUPER_ADMIN)
    custom = await _custom_role(db, "Old Name", [WEB_ACCESS])
    response = await client.patch(
        f"{ROLES}/{custom.id}",
        json={"name": "New Name", "permissions": [TEAM_VIEW, WEB_ACCESS]},
        headers=headers,
    )
    assert response.status_code == 200
    assert response.json() == {
        "id": custom.id,
        "name": "New Name",
        "permissions": [TEAM_VIEW, WEB_ACCESS],
        "is_system": False,
    }
    (row,) = await audit_rows(db, "role.update")
    assert row.actor_id == boss.id
    assert row.before == {"name": "Old Name", "permissions": [WEB_ACCESS]}
    assert row.after == {"name": "New Name", "permissions": [TEAM_VIEW, WEB_ACCESS]}


async def test_rename_to_an_existing_name_is_rejected(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db, SUPER_ADMIN)
    custom = await _custom_role(db, "Custom", [])
    response = await client.patch(
        f"{ROLES}/{custom.id}", json={"name": "admin/hr"}, headers=headers
    )
    assert response.status_code == 409
    assert error_code(response) == "DUPLICATE"


async def test_super_admin_role_cannot_be_modified_or_deleted(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db, SUPER_ADMIN)
    super_role = await role_id(db, SUPER_ADMIN)
    for body in ({"name": "Boss"}, {"permissions": []}):
        response = await client.patch(f"{ROLES}/{super_role}", json=body, headers=headers)
        assert response.status_code == 409
        assert error_code(response) == "PROTECTED_ROLE"
    response = await client.delete(f"{ROLES}/{super_role}", headers=headers)
    assert response.status_code == 409
    assert error_code(response) == "PROTECTED_ROLE"


async def test_system_roles_cannot_be_renamed_or_deleted(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db, SUPER_ADMIN)
    admin_role = await role_id(db, ADMIN)
    renamed = await client.patch(f"{ROLES}/{admin_role}", json={"name": "HR"}, headers=headers)
    assert renamed.status_code == 409
    assert error_code(renamed) == "PROTECTED_ROLE"
    deleted = await client.delete(f"{ROLES}/{admin_role}", headers=headers)
    assert deleted.status_code == 409
    assert error_code(deleted) == "PROTECTED_ROLE"


async def test_system_role_permissions_can_be_changed(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db, SUPER_ADMIN)
    response = await client.patch(
        f"{ROLES}/{await role_id(db, ASSIGNER)}",
        json={"permissions": [WEB_ACCESS]},
        headers=headers,
    )
    assert response.status_code == 200
    assert response.json()["permissions"] == [WEB_ACCESS]


async def test_delete_unused_custom_role(client: httpx.AsyncClient, db: AsyncSession) -> None:
    boss, headers = await actor(client, db, SUPER_ADMIN)
    custom = await _custom_role(db, "Temp", [])
    response = await client.delete(f"{ROLES}/{custom.id}", headers=headers)
    assert response.status_code == 204
    assert custom.id not in [r["id"] for r in (await client.get(ROLES, headers=headers)).json()]
    (row,) = await audit_rows(db, "role.delete")
    assert row.actor_id == boss.id
    assert row.before == {"name": "Temp"}


async def test_delete_role_in_use_is_rejected(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db, SUPER_ADMIN)
    custom = await _custom_role(db, "Busy", [])
    user = await make_user(db, FIELD)
    user.role_id = custom.id
    await db.flush()
    response = await client.delete(f"{ROLES}/{custom.id}", headers=headers)
    assert response.status_code == 409
    assert error_code(response) == "IN_USE"
    assert await audit_rows(db, "role.delete") == []


async def test_unknown_role_id_is_404(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db, SUPER_ADMIN)
    patch = await client.patch(f"{ROLES}/999999", json={"name": "X"}, headers=headers)
    delete = await client.delete(f"{ROLES}/999999", headers=headers)
    assert patch.status_code == delete.status_code == 404
    assert error_code(patch) == "NOT_FOUND"


async def test_role_changes_need_roles_manage(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db, ADMIN)
    custom = await _custom_role(db, "Custom", [])
    assert (await client.get(ROLES, headers=headers)).status_code == 200  # read: employees.manage
    calls = [
        client.post(ROLES, json={"name": "X", "permissions": []}, headers=headers),
        client.patch(f"{ROLES}/{custom.id}", json={"name": "Y"}, headers=headers),
        client.delete(f"{ROLES}/{custom.id}", headers=headers),
    ]
    for call in calls:
        response = await call
        assert response.status_code == 403
        assert error_code(response) == "FORBIDDEN"
    assert (await client.post(ROLES, json={"name": "X", "permissions": []})).status_code == 401


async def test_permission_change_applies_without_a_new_login(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, boss_headers = await actor(client, db, SUPER_ADMIN)
    _, assigner_headers = await actor(client, db, ASSIGNER)
    assert (await client.get(TEAM, headers=assigner_headers)).status_code == 200

    assigner_role = await role_id(db, ASSIGNER)
    await client.patch(
        f"{ROLES}/{assigner_role}", json={"permissions": [WEB_ACCESS]}, headers=boss_headers
    )
    denied = await client.get(TEAM, headers=assigner_headers)  # the SAME access token
    assert denied.status_code == 403

    await client.patch(
        f"{ROLES}/{assigner_role}",
        json={"permissions": [WEB_ACCESS, TEAM_VIEW]},
        headers=boss_headers,
    )
    assert (await client.get(TEAM, headers=assigner_headers)).status_code == 200
