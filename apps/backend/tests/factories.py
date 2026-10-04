"""Test data helpers shared by every module's tests."""

import itertools
from datetime import date, time
from typing import Any

import httpx
from geoalchemy2 import WKTElement
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import hash_password
from app.modules.branches.models import Branch
from app.modules.employees.models import Department, Designation, Role, User
from app.modules.employees.schemas import normalize_mobile
from app.modules.shifts.models import Shift

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


async def make_branch(
    session: AsyncSession,
    name: str | None = None,
    *,
    lat: float = 20.2961,
    lng: float = 85.8245,
    radius_m: int = 100,
    is_active: bool = True,
) -> Branch:
    branch = Branch(
        name=name or f"Branch {next(_counter)}",
        location=WKTElement(f"POINT({lng} {lat})", srid=4326),
        radius_m=radius_m,
        is_active=is_active,
    )
    session.add(branch)
    await session.flush()
    await session.refresh(branch)
    return branch


async def make_shift(
    session: AsyncSession, name: str | None = None, *, is_active: bool = True, **fields: Any
) -> Shift:
    shift = Shift(
        name=name or f"Shift {next(_counter)}",
        start_time=time(9, 30),
        end_time=time(18, 30),
        grace_min=10,
        half_day_hours=4,
        full_day_hours=8,
        weekly_offs=[{"weekday": 6, "weeks": None}],
        is_active=is_active,
        **fields,
    )
    session.add(shift)
    await session.flush()
    return shift


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
        mobile=normalize_mobile(fields.pop("mobile", f"9{n:09d}")),
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


async def make_user_with(session: AsyncSession, *permissions: str) -> User:
    """A user whose custom role holds exactly these permissions."""
    role = Role(name=f"Custom {next(_counter)}", permissions=sorted(permissions))
    session.add(role)
    await session.flush()
    user = await make_user(session)
    user.role_id = role.id
    await session.flush()
    await session.refresh(user)
    return user


async def headers_with(
    client: httpx.AsyncClient, session: AsyncSession, *permissions: str
) -> dict[str, str]:
    """A signed-in user holding exactly these permissions (on a phone: web needs web.access)."""
    user = await make_user_with(session, *permissions)
    return await auth_headers(client, user, kind="mobile", device_info=device(next(_counter)))


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
