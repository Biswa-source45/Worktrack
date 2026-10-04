"""Migration 0004: one active employee per phone.

Like the 0003 tests, these move the shared test database down one revision and back, and delete
only the rows they inserted.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import asyncpg
import pytest

from tests.helpers import run_alembic
from tests.test_migration_0003 import _conn, _fetch, _upgrade_error

INDEX = "uq_user_devices_one_active_per_phone"
CODES = ["M4-A", "M4-B", "M4-C"]


async def _bind(emp_code: str, device_id: str, status: str = "active") -> None:
    """Insert the user (once) and a phone for them."""
    async with _conn() as conn:
        await conn.execute(
            "INSERT INTO users (emp_code, name, mobile, password_hash, role_id, designation_id,"
            " joined_on) SELECT $1::text, $2, $3, 'x', r.id, d.id, '2026-01-01'"
            " FROM roles r, designations d WHERE r.name = 'Office Employee'"
            " AND d.name = 'Engineer'"
            " AND NOT EXISTS (SELECT 1 FROM users WHERE emp_code = $1::text)",
            emp_code,
            f"Person {emp_code}",
            f"+9198000000{CODES.index(emp_code):02d}",
        )
        await conn.execute(
            "INSERT INTO user_devices (user_id, device_id, model, os, app_version, status)"
            " SELECT id, $2, 'Pixel 8', 'Android 14', '0.1.0', $3 FROM users WHERE emp_code = $1",
            emp_code,
            device_id,
            status,
        )


async def _cleanup() -> None:
    async with _conn() as conn:
        await conn.execute(
            "DELETE FROM user_devices WHERE user_id IN"
            " (SELECT id FROM users WHERE emp_code = ANY($1))",
            CODES,
        )
        await conn.execute("DELETE FROM users WHERE emp_code = ANY($1)", CODES)


@asynccontextmanager
async def _at_0003() -> AsyncIterator[None]:
    """Schema at 0003 for the body; afterwards the test rows are gone and the schema is at head."""
    try:
        run_alembic("downgrade", "0003")
        yield
    finally:
        await _cleanup()
        run_alembic("upgrade", "head")


async def _index_exists() -> bool:
    return bool(
        await _fetch(
            "SELECT 1 FROM pg_indexes WHERE indexname = 'uq_user_devices_one_active_per_phone'"
        )
    )


async def test_upgrade_adds_the_index_and_downgrade_removes_it() -> None:
    async with _at_0003():
        assert not await _index_exists()
        # Legal data: one active employee per phone; revoked and pending rows may share a phone.
        await _bind("M4-A", "m4-phone-1")
        await _bind("M4-B", "m4-phone-1", "revoked")
        await _bind("M4-C", "m4-phone-1", "pending")
        run_alembic("upgrade", "head")
        assert await _index_exists()
        run_alembic("downgrade", "0003")
        assert not await _index_exists()


async def test_the_index_refuses_a_second_active_employee_at_head() -> None:
    try:
        await _bind("M4-A", "m4-phone-1")
        with pytest.raises(asyncpg.UniqueViolationError, match=INDEX):
            await _bind("M4-B", "m4-phone-1")
    finally:
        await _cleanup()


async def test_a_phone_active_for_two_employees_aborts_the_upgrade_and_lists_them() -> None:
    async with _at_0003():
        await _bind("M4-A", "m4-phone-1")
        await _bind("M4-B", "m4-phone-1")
        await _bind("M4-C", "m4-phone-2")
        message = _upgrade_error()
        assert "RuntimeError" in message
        assert "active for more than one employee" in message
        assert "device_id=m4-phone-1" in message
        assert "emp_code=M4-A" in message
        assert "emp_code=M4-B" in message
        assert "emp_code=M4-C" not in message
        assert "Nothing was changed" in message
        # Nobody was revoked, and the schema is still at 0003.
        statuses = await _fetch("SELECT status FROM user_devices WHERE device_id LIKE 'm4-phone-%'")
        assert [row["status"] for row in statuses] == ["active"] * 3
        assert (await _fetch("SELECT version_num FROM alembic_version"))[0][0] == "0003"
        assert not await _index_exists()
