import os

import asyncpg

from tests.helpers import run_alembic

M1_TABLES = {
    "roles",
    "departments",
    "designations",
    "users",
    "user_devices",
    "refresh_tokens",
    "audit_logs",
}


async def _query(sql: str) -> list[asyncpg.Record]:
    dsn = os.environ["DATABASE_URL"].replace("+asyncpg", "")
    conn = await asyncpg.connect(dsn)
    try:
        return await conn.fetch(sql)
    finally:
        await conn.close()


async def _postgis_installed() -> bool:
    return bool(await _query("SELECT 1 FROM pg_extension WHERE extname = 'postgis'"))


async def _tables() -> set[str]:
    rows = await _query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
    return {r["tablename"] for r in rows}


async def test_upgrade_downgrade_upgrade() -> None:
    try:
        run_alembic("downgrade", "base")
        assert not await _postgis_installed()
        assert not M1_TABLES & await _tables()
        assert not await _query("SELECT 1 FROM pg_proc WHERE proname = 'audit_logs_immutable'")
        run_alembic("upgrade", "head")
        assert await _postgis_installed()
        assert await _tables() >= M1_TABLES
    finally:
        run_alembic("upgrade", "head")


async def test_roles_and_designations_are_seeded() -> None:
    roles = {r["name"] for r in await _query("SELECT name FROM roles")}
    assert roles == {
        "Super Admin",
        "Admin/HR",
        "Task Assigner",
        "Field Employee",
        "Office Employee",
    }
    assert await _query("SELECT 1 FROM designations WHERE name = 'Engineer'")
