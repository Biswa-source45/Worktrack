"""Small helpers shared by the employee and device test files."""

from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.audit.models import AuditLog
from app.modules.employees.models import User
from tests.factories import (
    ADMIN,
    FIELD,
    auth_headers,
    designation_id,
    employee_payload,
    make_user,
    role_id,
)

API = "/api/v1"
EMPLOYEES = f"{API}/admin/employees"

Headers = dict[str, str]


async def actor(
    client: httpx.AsyncClient, db: AsyncSession, role: str = ADMIN, **fields: Any
) -> tuple[User, Headers]:
    """A signed-in user of the given role (web login)."""
    user = await make_user(db, role, **fields)
    return user, await auth_headers(client, user)


async def post_employee(
    client: httpx.AsyncClient,
    db: AsyncSession,
    headers: Headers,
    role: str = FIELD,
    **overrides: Any,
) -> httpx.Response:
    payload = employee_payload(await designation_id(db), await role_id(db, role), **overrides)
    return await client.post(EMPLOYEES, json=payload, headers=headers)


async def audit_rows(db: AsyncSession, action: str) -> list[AuditLog]:
    return list((await db.execute(select(AuditLog).where(AuditLog.action == action))).scalars())


def error_code(response: httpx.Response) -> str:
    code: str = response.json()["error"]["code"]
    return code


async def get_user(db: AsyncSession, user_id: int) -> User:
    """The user as stored now (re-read, so changes made by requests are visible)."""
    user = await db.get(User, user_id)
    assert user is not None
    await db.refresh(user)
    return user
