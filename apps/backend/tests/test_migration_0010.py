"""Migration 0010: attendance tables, notifications and the three attendance permissions.

Like the earlier migration tests, the first one moves the shared test database down one revision
and back; the rest work on the migrated schema and delete only the rows they insert.
"""

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import asyncpg
import pytest

from tests.helpers import run_alembic
from tests.test_migration_0003 import _conn, _fetch

TABLES = {
    "attendance_days",
    "punch_events",
    "punch_out_requests",
    "attendance_overrides",
    "punch_exceptions",
    "notifications",
}
KEYS = {"attendance.view_all", "attendance.override", "punchout.approve"}


async def _tables() -> set[str]:
    names = ", ".join(f"'{name}'" for name in sorted(TABLES))
    rows = await _fetch(f"SELECT tablename FROM pg_tables WHERE tablename IN ({names})")  # noqa: S608 (constants)
    return {r["tablename"] for r in rows}


async def _permissions() -> dict[str, set[str]]:
    rows = await _fetch("SELECT name, permissions FROM roles")
    return {r["name"]: set(json.loads(r["permissions"])) for r in rows}


@asynccontextmanager
async def _at_0009() -> AsyncIterator[None]:
    try:
        run_alembic("downgrade", "0009")
        yield
    finally:
        async with _conn() as conn:
            await conn.execute("DELETE FROM roles WHERE name = 'M10 Custom'")
        run_alembic("upgrade", "head")


async def test_upgrade_creates_the_tables_and_grants_and_downgrade_removes_them() -> None:
    async with _at_0009():
        assert not await _tables()
        before = await _permissions()
        assert not KEYS & set().union(*before.values())

        run_alembic("upgrade", "head")
        assert await _tables() == TABLES
        after = await _permissions()
        assert after["Super Admin"] == before["Super Admin"] | KEYS
        assert after["Admin/HR"] == before["Admin/HR"] | KEYS
        assert after["Task Assigner"] == before["Task Assigner"] | {"punchout.approve"}
        for role in ("Field Employee", "Office Employee"):
            assert after[role] == before[role]

        async with _conn() as conn:
            await conn.execute(
                "INSERT INTO roles (name, permissions) VALUES"
                " ('M10 Custom', '[\"web.access\", \"punchout.approve\"]')"
            )
        run_alembic("downgrade", "0009")
        assert not await _tables()
        down = await _permissions()
        assert down.pop("M10 Custom") == {"web.access"}
        assert down == before


# --- what the database itself enforces ---------------------------------------------------------


@asynccontextmanager
async def _a_day() -> AsyncIterator[tuple[asyncpg.Connection, int, int]]:
    """A user with one attendance day, in a transaction that is rolled back at the end."""
    async with _conn() as conn:
        transaction = conn.transaction()
        await transaction.start()
        try:
            user_id = await conn.fetchval(
                "INSERT INTO users (emp_code, name, mobile, password_hash, role_id,"
                " designation_id, joined_on) SELECT 'M10-A', 'Person M10', '+919800001000', 'x',"
                " r.id, d.id, '2026-01-01' FROM roles r, designations d"
                " WHERE r.name = 'Office Employee' AND d.name = 'Engineer' RETURNING id"
            )
            day_id = await conn.fetchval(
                "INSERT INTO attendance_days (user_id, date, status)"
                " VALUES ($1, '2026-10-05', 'working') RETURNING id",
                user_id,
            )
            yield conn, user_id, day_id
        finally:
            await transaction.rollback()


PUNCH = (
    "INSERT INTO punch_events (attendance_day_id, user_id, type, request_id, effective_time,"
    " location, accuracy_m, location_type, selfie_key, face_score, face_decision,"
    " face_model_version, thresholds_used, review_status)"
    " VALUES ($1, $2, $3, gen_random_uuid(), now(), ST_GeogFromText('POINT(77.2 28.6)'), 10,"
    " 'home', 'k', 0.9, 'VERIFIED', 'm', '{}', $4)"
)


async def _expect(
    conn: asyncpg.Connection, error: type[Exception], sql: str, *args: object
) -> None:
    # A savepoint, so the failed statement does not poison the test's transaction.
    savepoint = conn.transaction()
    await savepoint.start()
    try:
        with pytest.raises(error):
            await conn.execute(sql, *args)
    finally:
        await savepoint.rollback()


async def test_one_attendance_day_per_person_and_date() -> None:
    async with _a_day() as (conn, user_id, _):
        await _expect(
            conn,
            asyncpg.UniqueViolationError,
            "INSERT INTO attendance_days (user_id, date, status)"
            " VALUES ($1, '2026-10-05', 'absent')",
            user_id,
        )
        await _expect(
            conn,
            asyncpg.CheckViolationError,
            "INSERT INTO attendance_days (user_id, date, status)"
            " VALUES ($1, '2026-10-06', 'bogus')",
            user_id,
        )


async def test_one_counting_punch_in_and_out_per_day_and_a_rejected_one_frees_the_slot() -> None:
    async with _a_day() as (conn, user_id, day_id):
        for kind in ("in", "out"):
            await conn.execute(PUNCH, day_id, user_id, kind, "verified")
            await _expect(
                conn, asyncpg.UniqueViolationError, PUNCH, day_id, user_id, kind, "pending"
            )
            await _expect(
                conn, asyncpg.UniqueViolationError, PUNCH, day_id, user_id, kind, "approved"
            )
            # Rejected punches pile up as history and never block a new one.
            await conn.execute(PUNCH, day_id, user_id, kind, "rejected")
            await conn.execute(PUNCH, day_id, user_id, kind, "rejected")
        await conn.execute(
            "UPDATE punch_events SET review_status = 'rejected' WHERE type = 'in' AND"
            " review_status = 'verified'"
        )
        await conn.execute(PUNCH, day_id, user_id, "in", "pending")


async def test_a_punch_has_a_known_type_status_and_place_and_a_branch_only_at_a_branch() -> None:
    async with _a_day() as (conn, user_id, day_id):
        await _expect(conn, asyncpg.CheckViolationError, PUNCH, day_id, user_id, "x", "verified")
        await _expect(conn, asyncpg.CheckViolationError, PUNCH, day_id, user_id, "in", "maybe")
        # The shared statement says location_type 'home' with no branch: fine. 'branch' needs one.
        await _expect(
            conn,
            asyncpg.CheckViolationError,
            PUNCH.replace("'home'", "'branch'"),
            day_id,
            user_id,
            "in",
            "verified",
        )


async def test_the_same_request_id_twice_is_refused_for_one_person() -> None:
    async with _a_day() as (conn, user_id, day_id):
        same = PUNCH.replace("gen_random_uuid()", "'11111111-1111-1111-1111-111111111111'")
        await conn.execute(same, day_id, user_id, "in", "verified")
        await _expect(conn, asyncpg.UniqueViolationError, same, day_id, user_id, "out", "verified")


async def test_a_notification_key_is_used_once() -> None:
    async with _a_day() as (conn, user_id, _):
        insert = (
            "INSERT INTO notifications (user_id, type, title, body, dedupe_key)"
            " VALUES ($1, 'punch_out_reminder', 't', 'b', 'k1')"
        )
        await conn.execute(insert, user_id)
        await _expect(conn, asyncpg.UniqueViolationError, insert, user_id)
