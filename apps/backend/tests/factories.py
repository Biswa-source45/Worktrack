"""Test data helpers shared by every module's tests."""

import itertools
from datetime import date
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import hash_password
from app.modules.employees.models import Department, Designation, Role, User

PASSWORD = "Correct-Horse-1234"
_counter = itertools.count(1)

# Role names seeded by migration 0002.
SUPER_ADMIN = "Super Admin"
ADMIN = "Admin/HR"
ASSIGNER = "Task Assigner"
FIELD = "Field Employee"
OFFICE = "Office Employee"
ALL_ROLES = (SUPER_ADMIN, ADMIN, ASSIGNER, FIELD, OFFICE)


def device(n: int = 1, **overrides: str) -> dict[str, str]:
    return {
        "device_id": f"device-{n:04d}-abcdefgh",
        "model": "Pixel 8",
        "os": "Android 14",
        "app_version": "0.1.0",
        **overrides,
    }


async def role_id(session: AsyncSession, name: str) -> int:
    return (await session.execute(select(Role.id).where(Role.name == name))).scalar_one()


async def designation_id(session: AsyncSession, name: str = "Engineer") -> int:
    return (
        await session.execute(select(Designation.id).where(Designation.name == name))
    ).scalar_one()


async def make_department(session: AsyncSession, name: str | None = None) -> Department:
    row = Department(name=name or f"Dept {next(_counter)}")
    session.add(row)
    await session.flush()
    return row


async def make_user(
    session: AsyncSession,
    role: str = OFFICE,
    *,
    password: str = PASSWORD,
    must_change: bool = False,
    status: str = "active",
    manager_id: int | None = None,
    **fields: Any,
) -> User:
    """Insert a user directly (fast). `must_change=False` skips the first-login password change."""
    n = next(_counter)
    user = User(
        emp_code=fields.pop("emp_code", f"T{n:05d}"),
        name=fields.pop("name", f"Test User {n}"),
        mobile=fields.pop("mobile", f"9{n:09d}"),
        email=fields.pop("email", None),
        password_hash=await hash_password(password),
        role_id=await role_id(session, role),
        designation_id=await designation_id(session),
        manager_id=manager_id,
        joined_on=date(2026, 1, 1),
        status=status,
        must_change_password=must_change,
        **fields,
    )
    session.add(user)
    await session.flush()
    await session.refresh(user)
    return user


async def login(
    client: httpx.AsyncClient,
    user: User,
    *,
    password: str = PASSWORD,
    kind: str = "web",
    device_info: dict[str, str] | None = None,
) -> httpx.Response:
    body: dict[str, Any] = {"identifier": user.emp_code, "password": password, "client": kind}
    if kind == "mobile":
        body["device"] = device_info or device()
    return await client.post("/api/v1/auth/login", json=body)


async def auth_headers(
    client: httpx.AsyncClient,
    user: User,
    *,
    kind: str = "web",
    device_info: dict[str, str] | None = None,
) -> dict[str, str]:
    response = await login(client, user, kind=kind, device_info=device_info)
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def employee_payload(designation: int, role: int, **overrides: Any) -> dict[str, Any]:
    n = next(_counter)
    return {
        "emp_code": f"E{n:05d}",
        "name": f"New Person {n}",
        "mobile": f"8{n:09d}",
        "designation_id": designation,
        "role_id": role,
        "joined_on": "2026-02-01",
        **overrides,
    }
