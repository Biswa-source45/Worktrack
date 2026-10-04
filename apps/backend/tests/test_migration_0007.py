"""Migration 0007: weekly work schedules and home work locations."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import asyncpg
import pytest

from tests.helpers import run_alembic
from tests.test_migration_0003 import _conn, _fetch

TABLES = ["home_locations", "work_schedules"]


async def _existing_tables() -> list[str]:
    rows = await _fetch("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
    return sorted({r["tablename"] for r in rows} & set(TABLES))


async def test_upgrade_creates_the_tables_and_downgrade_removes_them() -> None:
    try:
        run_alembic("downgrade", "0006")
        assert await _existing_tables() == []
        # The tables of 0006 are untouched.
        assert await _fetch("SELECT 1 FROM pg_tables WHERE tablename = 'branches'")
        run_alembic("upgrade", "head")
        assert await _existing_tables() == TABLES
    finally:
        run_alembic("upgrade", "head")


async def test_home_locations_have_no_spatial_index() -> None:
    rows = await _fetch("SELECT indexdef FROM pg_indexes WHERE tablename = 'home_locations'")
    assert rows
    assert not [r for r in rows if "gist" in r["indexdef"].lower()]


@asynccontextmanager
async def _user() -> AsyncIterator[tuple[asyncpg.Connection, int]]:
    """A connection with one user, inside a transaction that is rolled back."""
    async with _conn() as conn:
        transaction = conn.transaction()
        await transaction.start()
        try:
            user_id = await conn.fetchval(
                "INSERT INTO users (emp_code, name, mobile, password_hash, role_id, designation_id,"
                " joined_on) SELECT 'M7-A', 'Person M7', '+919800000700', 'x', r.id, d.id,"
                " '2026-01-01' FROM roles r, designations d"
                " WHERE r.name = 'Office Employee' AND d.name = 'Engineer' RETURNING id"
            )
            yield conn, user_id
        finally:
            await transaction.rollback()


async def _refused(
    conn: asyncpg.Connection, error: type[Exception], sql: str, *args: object
) -> None:
    with pytest.raises(error):
        async with conn.transaction():
            await conn.execute(sql, *args)


async def test_one_schedule_per_employee_and_date_with_exactly_seven_days() -> None:
    insert = (
        "INSERT INTO work_schedules (user_id, effective_from, days)"
        " VALUES ($1, $2::text::date, $3::text::jsonb)"
    )
    week = '["office", "office", "home", "office", "office", "off", null]'
    async with _user() as (conn, user_id):
        await conn.execute(insert, user_id, "2027-01-04", week)
        await conn.execute(insert, user_id, "2027-02-01", week)
        await _refused(conn, asyncpg.UniqueViolationError, insert, user_id, "2027-01-04", week)
        for days in ('["office"]', "[]", '["a", "b", "c", "d", "e", "f", "g", "h"]'):
            await _refused(conn, asyncpg.CheckViolationError, insert, user_id, "2027-03-01", days)


async def test_one_approved_and_one_pending_home_location_per_employee() -> None:
    insert = (
        "INSERT INTO home_locations (user_id, location, radius_m, source, status)"
        " VALUES ($1, ST_GeogFromText('POINT(77.2295 28.6129)'), $2, $3, $4)"
    )
    async with _user() as (conn, user_id):
        for status in ("approved", "pending", "rejected", "rejected", "replaced", "removed"):
            await conn.execute(insert, user_id, 100, "self", status)
        for status in ("approved", "pending"):
            await _refused(conn, asyncpg.UniqueViolationError, insert, user_id, 100, "self", status)
        for radius, source, status in [
            (29, "self", "rejected"),
            (501, "self", "rejected"),
            (100, "import", "rejected"),
            (100, "self", "deleted"),
        ]:
            await _refused(
                conn, asyncpg.CheckViolationError, insert, user_id, radius, source, status
            )
