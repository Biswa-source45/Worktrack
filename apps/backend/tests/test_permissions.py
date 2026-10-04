"""Every endpoint x every role (US-1.3).

MATRIX is the single list of protected endpoints with the permission each one needs. A meta-test
fails when a route exists in the app but not here, so a new endpoint cannot ship without a
permission test. Denied calls must answer 403 FORBIDDEN; allowed calls only need to get past the
guard (the request body is empty, so a 404/409/422 from the handler is fine).
"""

from collections.abc import AsyncIterator

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.main import app
from app.modules.auth.permissions import (
    DEVICES_MANAGE,
    EMPLOYEES_MANAGE,
    ROLES_MANAGE,
    TEAM_VIEW,
    WEB_ACCESS,
)
from tests.factories import (
    ADMIN,
    ALL_ROLES,
    ASSIGNER,
    FIELD,
    OFFICE,
    SUPER_ADMIN,
    auth_headers,
    device,
    make_user,
)

P = "/api/v1"
MISSING = 999_999_999

# What migration 0002 seeds. Asserting it here catches an accidental change to a role.
ROLE_PERMISSIONS: dict[str, set[str]] = {
    SUPER_ADMIN: {WEB_ACCESS, EMPLOYEES_MANAGE, DEVICES_MANAGE, ROLES_MANAGE, TEAM_VIEW},
    ADMIN: {WEB_ACCESS, EMPLOYEES_MANAGE, DEVICES_MANAGE, TEAM_VIEW},
    ASSIGNER: {WEB_ACCESS, TEAM_VIEW},
    FIELD: set(),
    OFFICE: set(),
}

# (method, path as registered, concrete path to call, permission needed)
MATRIX: list[tuple[str, str, str, str]] = [
    ("GET", f"{P}/admin/dashboard", f"{P}/admin/dashboard", EMPLOYEES_MANAGE),
    ("GET", f"{P}/admin/employees", f"{P}/admin/employees", EMPLOYEES_MANAGE),
    ("POST", f"{P}/admin/employees", f"{P}/admin/employees", EMPLOYEES_MANAGE),
    (
        "GET",
        f"{P}/admin/employees/import/template",
        f"{P}/admin/employees/import/template",
        EMPLOYEES_MANAGE,
    ),
    ("POST", f"{P}/admin/employees/import", f"{P}/admin/employees/import", EMPLOYEES_MANAGE),
    (
        "GET",
        f"{P}/admin/employees/{{employee_id}}",
        f"{P}/admin/employees/{MISSING}",
        EMPLOYEES_MANAGE,
    ),
    (
        "PATCH",
        f"{P}/admin/employees/{{employee_id}}",
        f"{P}/admin/employees/{MISSING}",
        EMPLOYEES_MANAGE,
    ),
    (
        "POST",
        f"{P}/admin/employees/{{employee_id}}/reset-password",
        f"{P}/admin/employees/{MISSING}/reset-password",
        EMPLOYEES_MANAGE,
    ),
    (
        "POST",
        f"{P}/admin/employees/{{employee_id}}/unlock",
        f"{P}/admin/employees/{MISSING}/unlock",
        EMPLOYEES_MANAGE,
    ),
    ("GET", f"{P}/employees/team", f"{P}/employees/team", TEAM_VIEW),
    ("GET", f"{P}/admin/masters/{{kind}}", f"{P}/admin/masters/departments", EMPLOYEES_MANAGE),
    ("POST", f"{P}/admin/masters/{{kind}}", f"{P}/admin/masters/departments", EMPLOYEES_MANAGE),
    (
        "PATCH",
        f"{P}/admin/masters/{{kind}}/{{item_id}}",
        f"{P}/admin/masters/departments/{MISSING}",
        EMPLOYEES_MANAGE,
    ),
    (
        "DELETE",
        f"{P}/admin/masters/{{kind}}/{{item_id}}",
        f"{P}/admin/masters/departments/{MISSING}",
        EMPLOYEES_MANAGE,
    ),
    ("GET", f"{P}/admin/roles", f"{P}/admin/roles", EMPLOYEES_MANAGE),
    ("POST", f"{P}/admin/roles", f"{P}/admin/roles", ROLES_MANAGE),
    ("PATCH", f"{P}/admin/roles/{{role_id}}", f"{P}/admin/roles/{MISSING}", ROLES_MANAGE),
    ("DELETE", f"{P}/admin/roles/{{role_id}}", f"{P}/admin/roles/{MISSING}", ROLES_MANAGE),
    ("GET", f"{P}/admin/devices", f"{P}/admin/devices", DEVICES_MANAGE),
    ("PATCH", f"{P}/admin/devices/{{device_id}}", f"{P}/admin/devices/{MISSING}", DEVICES_MANAGE),
    ("GET", f"{P}/admin/sessions", f"{P}/admin/sessions", DEVICES_MANAGE),
    (
        "POST",
        f"{P}/admin/sessions/{{session_id}}/revoke",
        f"{P}/admin/sessions/{MISSING}/revoke",
        DEVICES_MANAGE,
    ),
]

# Signed-in users of any role, scoped to themselves.
SELF_ONLY = [
    ("GET", f"{P}/me"),
    ("POST", f"{P}/auth/change-password"),
    ("GET", f"{P}/me/sessions"),
    ("POST", f"{P}/me/sessions/revoke-others"),
]
# Authenticated by the credential in the request itself, or open by design.
PUBLIC = [
    ("POST", f"{P}/auth/login"),
    ("POST", f"{P}/auth/refresh"),
    ("POST", f"{P}/auth/logout"),
    ("GET", "/health"),
]


@pytest.fixture
async def tokens(
    client: httpx.AsyncClient, db: AsyncSession
) -> AsyncIterator[dict[str, dict[str, str]]]:
    headers: dict[str, dict[str, str]] = {}
    for n, role in enumerate(ALL_ROLES, start=1):
        user = await make_user(db, role)
        headers[role] = await auth_headers(client, user, kind="mobile", device_info=device(n))
    yield headers


def _registered_routes() -> set[tuple[str, str]]:
    # The OpenAPI schema lists every real endpoint (and none of the framework's own pages).
    return {
        (method.upper(), path)
        for path, operations in app.openapi()["paths"].items()
        for method in operations
    }


def test_every_route_is_listed_in_the_permission_matrix() -> None:
    covered = {(method, path) for method, path, _, _ in MATRIX} | set(SELF_ONLY) | set(PUBLIC)
    assert _registered_routes() == covered


@pytest.mark.parametrize("role", ALL_ROLES)
async def test_seeded_role_permissions_match_the_database(
    client: httpx.AsyncClient, tokens: dict[str, dict[str, str]], role: str
) -> None:
    body = (await client.get(f"{P}/me", headers=tokens[role])).json()
    assert set(body["permissions"]) == ROLE_PERMISSIONS[role]


@pytest.mark.parametrize(("method", "pattern", "path", "needed"), MATRIX)
async def test_endpoint_permissions_for_every_role(
    client: httpx.AsyncClient,
    tokens: dict[str, dict[str, str]],
    method: str,
    pattern: str,
    path: str,
    needed: str,
) -> None:
    anonymous = await client.request(method, path)
    assert anonymous.status_code == 401
    for role in ALL_ROLES:
        response = await client.request(method, path, headers=tokens[role])
        if needed in ROLE_PERMISSIONS[role]:
            assert response.status_code not in (401, 403), (role, response.text)
        else:
            assert response.status_code == 403, (role, response.text)
            assert response.json()["error"]["code"] == "FORBIDDEN"


@pytest.mark.parametrize(("method", "path"), SELF_ONLY)
async def test_self_only_endpoints_need_a_session_but_no_permission(
    client: httpx.AsyncClient, tokens: dict[str, dict[str, str]], method: str, path: str
) -> None:
    assert (await client.request(method, path)).status_code == 401
    for role in ALL_ROLES:
        response = await client.request(method, path, headers=tokens[role])
        assert response.status_code not in (401, 403), (role, response.text)


@pytest.mark.parametrize(("method", "pattern", "path", "needed"), MATRIX)
async def test_password_change_is_enforced_on_every_protected_endpoint(
    client: httpx.AsyncClient,
    db: AsyncSession,
    method: str,
    pattern: str,
    path: str,
    needed: str,
) -> None:
    admin = await make_user(db, SUPER_ADMIN, must_change=True)
    headers = await auth_headers(client, admin)
    response = await client.request(method, path, headers=headers)
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "PASSWORD_CHANGE_REQUIRED"


@pytest.mark.parametrize(("method", "pattern", "path", "needed"), MATRIX)
async def test_an_inactive_employees_token_is_refused_everywhere(
    client: httpx.AsyncClient,
    db: AsyncSession,
    method: str,
    pattern: str,
    path: str,
    needed: str,
) -> None:
    admin = await make_user(db, SUPER_ADMIN)
    headers = await auth_headers(client, admin)
    admin.status = "inactive"
    await db.flush()
    assert (await client.request(method, path, headers=headers)).status_code == 401
