"""Migration 0006: branches, shifts, holidays, settings, and the links from employees to them.

Like the earlier migration tests, these move the shared test database down one revision and back,
and delete only the rows they inserted.
"""

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import asyncpg
import pytest

from tests.helpers import run_alembic
from tests.test_migration_0003 import _conn, _fetch, _upgrade_error

CODES = ["M6-A", "M6-B", "M6-C"]
TABLES = ["branches", "shifts", "holidays", "settings"]
NEW_KEYS = {"branches.manage", "settings.view", "settings.manage"}


async def _insert_user(emp_code: str, home_branch_id: int | None, shift_id: int | None) -> None:
    async with _conn() as conn:
        await conn.execute(
            "INSERT INTO users (emp_code, name, mobile, password_hash, role_id, designation_id,"
            " joined_on, home_branch_id, shift_id) SELECT $1, 'Person M6', $2, 'x', r.id, d.id,"
            " '2026-01-01', $3, $4 FROM roles r, designations d"
            " WHERE r.name = 'Office Employee' AND d.name = 'Engineer'",
            emp_code,
            f"+9198000006{CODES.index(emp_code):02d}",
            home_branch_id,
            shift_id,
        )


@asynccontextmanager
async def _at_0005() -> AsyncIterator[None]:
    try:
        run_alembic("downgrade", "0005")
        yield
    finally:
        async with _conn() as conn:
            await conn.execute("DELETE FROM roles WHERE name = 'M6 Custom'")
            await conn.execute("DELETE FROM users WHERE emp_code = ANY($1)", CODES)
        run_alembic("upgrade", "head")


async def _existing_tables() -> list[str]:
    rows = await _fetch("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
    return sorted({r["tablename"] for r in rows} & set(TABLES))


async def _permissions() -> dict[str, set[str]]:
    rows = await _fetch("SELECT name, permissions FROM roles")
    return {r["name"]: set(json.loads(r["permissions"])) for r in rows}


async def test_upgrade_creates_the_tables_and_downgrade_removes_them() -> None:
    async with _at_0005():
        assert await _existing_tables() == []
        before = await _permissions()
        assert not NEW_KEYS & set().union(*before.values())
        await _insert_user("M6-A", None, None)

        # To 0006 itself, not to head: later migrations (0009) grant more permissions.
        run_alembic("upgrade", "0006")
        assert await _existing_tables() == sorted(TABLES)
        after = await _permissions()
        assert after["Super Admin"] == before["Super Admin"] | NEW_KEYS
        assert after["Admin/HR"] == before["Admin/HR"] | {"branches.manage", "settings.view"}
        for role in ("Task Assigner", "Field Employee", "Office Employee"):
            assert after[role] == before[role]
        users = await _fetch("SELECT restrict_to_home_branch FROM users WHERE emp_code = 'M6-A'")
        assert users[0]["restrict_to_home_branch"] is False

        # A custom role given a new key loses it on the way down, like the system roles.
        async with _conn() as conn:
            await conn.execute(
                "INSERT INTO roles (name, permissions) VALUES"
                " ('M6 Custom', '[\"web.access\", \"branches.manage\"]')"
            )
            await conn.execute(
                "INSERT INTO branches (name, location, radius_m) VALUES"
                " ('M6 Branch', ST_GeogFromText('POINT(85.82 20.29)'), 100)"
            )
            await conn.execute(
                "UPDATE users SET home_branch_id = (SELECT id FROM branches WHERE name ="
                " 'M6 Branch') WHERE emp_code = 'M6-A'"
            )
        run_alembic("downgrade", "0005")
        assert await _existing_tables() == []
        down = await _permissions()
        assert down.pop("M6 Custom") == {"web.access"}
        assert down == before
        assert not await _fetch(
            "SELECT 1 FROM information_schema.columns"
            " WHERE table_name = 'users' AND column_name = 'restrict_to_home_branch'"
        )
        assert not await _fetch(
            "SELECT 1 FROM pg_constraint WHERE conname LIKE 'fk_users_%_shifts'"
        )
        # The branch is gone, so the employee no longer points at it and the upgrade works again.
        users = await _fetch("SELECT home_branch_id FROM users WHERE emp_code = 'M6-A'")
        assert users[0]["home_branch_id"] is None
        assert await _fetch("SELECT 1 FROM pg_extension WHERE extname = 'postgis'")


async def test_a_stray_branch_or_shift_id_aborts_the_upgrade_and_lists_the_employees() -> None:
    async with _at_0005():
        await _insert_user("M6-A", 7, None)
        await _insert_user("M6-B", None, 3)
        await _insert_user("M6-C", None, None)
        message = _upgrade_error()
        assert "RuntimeError" in message
        assert "emp_code=M6-A: home_branch_id=7, shift_id=None" in message
        assert "emp_code=M6-B: home_branch_id=None, shift_id=3" in message
        assert "emp_code=M6-C" not in message
        assert "Nothing was changed" in message
        # Nothing was cleared, and the schema is still at 0005.
        rows = await _fetch(
            "SELECT emp_code, home_branch_id, shift_id FROM users WHERE emp_code LIKE 'M6-%'"
            " ORDER BY emp_code"
        )
        assert [tuple(r) for r in rows] == [
            ("M6-A", 7, None),
            ("M6-B", None, 3),
            ("M6-C", None, None),
        ]
        assert (await _fetch("SELECT version_num FROM alembic_version"))[0][0] == "0005"
        assert await _existing_tables() == []


async def test_branches_have_exactly_one_gist_index_on_the_location() -> None:
    rows = await _fetch("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'branches'")
    gist = [r["indexname"] for r in rows if "USING gist" in r["indexdef"]]
    assert gist == ["idx_branches_location"]


async def _expect(error: type[Exception], sql: str, *args: object) -> None:
    async with _conn() as conn:
        transaction = conn.transaction()
        await transaction.start()
        try:
            with pytest.raises(error):
                await conn.execute(sql, *args)
        finally:
            await transaction.rollback()


@pytest.mark.parametrize("radius", [29, 501])
async def test_the_database_refuses_a_radius_out_of_range(radius: int) -> None:
    await _expect(
        asyncpg.CheckViolationError,
        "INSERT INTO branches (name, location, radius_m) VALUES"
        " ('M6 Radius', ST_GeogFromText('POINT(85.82 20.29)'), $1)",
        radius,
    )


@pytest.mark.parametrize(
    ("grace", "half", "full"),
    [(121, "4", "8"), (-1, "4", "8"), (10, "0", "8"), (10, "9", "8"), (10, "4", "24.5")],
)
async def test_the_database_refuses_impossible_shift_numbers(
    grace: int, half: str, full: str
) -> None:
    await _expect(
        asyncpg.CheckViolationError,
        "INSERT INTO shifts (name, start_time, end_time, grace_min, half_day_hours,"
        " full_day_hours, weekly_offs) VALUES ('M6 Shift', '09:00', '18:00', $1,"
        " $2::text::numeric, $3::text::numeric, '[]')",
        grace,
        half,
        full,
    )


async def test_one_holiday_per_date_for_all_branches_and_one_per_branch() -> None:
    async with _conn() as conn:
        transaction = conn.transaction()
        await transaction.start()
        try:
            branch = await conn.fetchval(
                "INSERT INTO branches (name, location, radius_m) VALUES"
                " ('M6 Holiday', ST_GeogFromText('POINT(85.82 20.29)'), 100) RETURNING id"
            )
            insert = "INSERT INTO holidays (date, name, branch_id) VALUES ('2027-01-26', 'x', $1)"
            await conn.execute(insert, None)
            await conn.execute(insert, branch)
            for branch_id in (None, branch):
                with pytest.raises(asyncpg.UniqueViolationError, match="uq_holidays_date_branch"):
                    async with conn.transaction():
                        await conn.execute(insert, branch_id)
        finally:
            await transaction.rollback()
