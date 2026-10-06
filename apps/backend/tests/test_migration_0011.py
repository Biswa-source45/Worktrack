"""Migration 0011: field tasks, the seven task types, field punch-in columns and the permissions.

Like the earlier migration tests, the first one moves the shared test database down one revision
and back; the rest work on the migrated schema and delete only the rows they insert.
"""

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import asyncpg

from tests.helpers import run_alembic
from tests.test_migration_0003 import _conn, _fetch
from tests.test_migration_0010 import _expect

TABLES = {
    "task_types",
    "tasks",
    "task_assignees",
    "task_events",
    "task_attachments",
    "task_comments",
}
KEYS = {"tasks.create", "tasks.view_all"}
TYPES = {
    "Firewall Installation",
    "Support/Issue Fix",
    "Maintenance",
    "EMD/Cheque Submission",
    "Document Submission",
    "Client Meeting",
    "Other",
}


async def _tables() -> set[str]:
    names = ", ".join(f"'{name}'" for name in sorted(TABLES))
    rows = await _fetch(f"SELECT tablename FROM pg_tables WHERE tablename IN ({names})")  # noqa: S608 (constants)
    return {r["tablename"] for r in rows}


async def _permissions() -> dict[str, set[str]]:
    rows = await _fetch("SELECT name, permissions FROM roles")
    return {r["name"]: set(json.loads(r["permissions"])) for r in rows}


async def _columns(table: str) -> set[str]:
    rows = await _fetch(
        f"SELECT column_name FROM information_schema.columns WHERE table_name = '{table}'"  # noqa: S608 (constants)
    )
    return {r["column_name"] for r in rows}


@asynccontextmanager
async def _at_0010() -> AsyncIterator[None]:
    try:
        run_alembic("downgrade", "0010")
        yield
    finally:
        async with _conn() as conn:
            await conn.execute("DELETE FROM roles WHERE name = 'M11 Custom'")
        run_alembic("upgrade", "head")


async def test_upgrade_creates_the_tables_and_grants_and_downgrade_removes_them() -> None:
    async with _at_0010():
        assert not await _tables()
        assert "field_punch_in_allowed" not in await _columns("users")
        assert "task_id" not in await _columns("punch_events")
        before = await _permissions()
        assert not KEYS & set().union(*before.values())

        run_alembic("upgrade", "head")
        assert await _tables() == TABLES
        assert "field_punch_in_allowed" in await _columns("users")
        assert "task_id" in await _columns("punch_events")
        after = await _permissions()
        assert after["Super Admin"] == before["Super Admin"] | KEYS
        assert after["Admin/HR"] == before["Admin/HR"] | KEYS
        assert after["Task Assigner"] == before["Task Assigner"] | {"tasks.create"}
        for role in ("Field Employee", "Office Employee"):
            assert after[role] == before[role]

        async with _conn() as conn:
            await conn.execute(
                "INSERT INTO roles (name, permissions) VALUES"
                " ('M11 Custom', '[\"web.access\", \"tasks.create\"]')"
            )
        run_alembic("downgrade", "0010")
        assert not await _tables()
        assert "field_punch_in_allowed" not in await _columns("users")
        assert "task_id" not in await _columns("punch_events")
        down = await _permissions()
        assert down.pop("M11 Custom") == {"web.access"}
        assert down == before


async def test_a_field_punch_in_becomes_an_outside_punch_on_downgrade() -> None:
    async with _conn() as conn:
        user_id = await conn.fetchval(
            "INSERT INTO users (emp_code, name, mobile, password_hash, role_id, designation_id,"
            " joined_on) SELECT 'M11-D', 'Person M11D', '+919800001100', 'x', r.id, d.id,"
            " '2026-01-01' FROM roles r, designations d"
            " WHERE r.name = 'Office Employee' AND d.name = 'Engineer' RETURNING id"
        )
        try:
            task_id = await conn.fetchval(
                "INSERT INTO tasks (title, type_id, client_name, site_address, site_location,"
                " site_radius_m, scheduled_at, status, created_by, request_id)"
                " SELECT 'T', t.id, 'C', 'A', ST_GeogFromText('POINT(77.2 28.6)'), 200, now(),"
                " 'assigned', $1, gen_random_uuid() FROM task_types t WHERE t.name = 'Other'"
                " RETURNING id",
                user_id,
            )
            day_id = await conn.fetchval(
                "INSERT INTO attendance_days (user_id, date, status)"
                " VALUES ($1, '2026-10-05', 'working') RETURNING id",
                user_id,
            )
            await conn.execute(
                "INSERT INTO punch_events (attendance_day_id, user_id, type, request_id,"
                " effective_time, location, accuracy_m, location_type, task_id, selfie_key,"
                " face_score, face_decision, face_model_version, thresholds_used, review_status)"
                " VALUES ($1, $2, 'in', gen_random_uuid(), now(),"
                " ST_GeogFromText('POINT(77.2 28.6)'), 10, 'task', $3, 'k', 0.9, 'VERIFIED',"
                " 'm', '{}', 'verified')",
                day_id,
                user_id,
                task_id,
            )
            run_alembic("downgrade", "0010")
            try:
                async with _conn() as check:
                    kinds = await check.fetch(
                        "SELECT location_type FROM punch_events WHERE user_id = $1", user_id
                    )
                assert [r["location_type"] for r in kinds] == ["outside"]
            finally:
                run_alembic("upgrade", "head")
        finally:
            await conn.execute("DELETE FROM punch_events WHERE user_id = $1", user_id)
            await conn.execute("DELETE FROM attendance_days WHERE user_id = $1", user_id)
            await conn.execute("DELETE FROM tasks WHERE created_by = $1", user_id)
            await conn.execute("DELETE FROM users WHERE id = $1", user_id)


# --- what the database itself enforces ---------------------------------------------------------


@asynccontextmanager
async def _a_task() -> AsyncIterator[tuple[asyncpg.Connection, int, int]]:
    """A user and a task, in a transaction that is rolled back at the end."""
    async with _conn() as conn:
        transaction = conn.transaction()
        await transaction.start()
        try:
            user_id = await conn.fetchval(
                "INSERT INTO users (emp_code, name, mobile, password_hash, role_id,"
                " designation_id, joined_on) SELECT 'M11-A', 'Person M11', '+919800001101', 'x',"
                " r.id, d.id, '2026-01-01' FROM roles r, designations d"
                " WHERE r.name = 'Office Employee' AND d.name = 'Engineer' RETURNING id"
            )
            task_id = await conn.fetchval(TASK, user_id, "assigned", 200)
            yield conn, user_id, task_id
        finally:
            await transaction.rollback()


TASK = (
    "INSERT INTO tasks (title, type_id, client_name, site_address, site_location, site_radius_m,"
    " scheduled_at, status, created_by, request_id) SELECT 'T', t.id, 'C', 'A',"
    " ST_GeogFromText('POINT(77.2 28.6)'), $3, now(), $2, $1, gen_random_uuid()"
    " FROM task_types t WHERE t.name = 'Other' RETURNING id"
)


async def test_the_seven_task_types_are_seeded_and_two_need_a_receipt() -> None:
    rows = await _fetch("SELECT name, proof_kind, proof_photo_required, is_active FROM task_types")
    assert {r["name"] for r in rows} == TYPES
    assert {r["name"] for r in rows if r["proof_kind"] == "receipt"} == {
        "EMD/Cheque Submission",
        "Document Submission",
    }
    assert all(r["proof_photo_required"] and r["is_active"] for r in rows)


async def test_task_codes_count_up_from_a_sequence() -> None:
    async with _a_task() as (conn, user_id, task_id):
        other = await conn.fetchval(TASK, user_id, "assigned", 200)
        codes = [
            r["code"]
            for r in await conn.fetch(
                "SELECT code FROM tasks WHERE id = ANY($1) ORDER BY id", [task_id, other]
            )
        ]
        numbers = [int(code.removeprefix("T-")) for code in codes]
        assert all(code.startswith("T-") and len(code) >= 7 for code in codes)
        assert numbers[1] == numbers[0] + 1


async def test_a_task_has_a_known_status_and_a_radius_within_bounds() -> None:
    async with _a_task() as (conn, user_id, _):
        await _expect(conn, asyncpg.CheckViolationError, TASK, user_id, "bogus", 200)
        await _expect(conn, asyncpg.CheckViolationError, TASK, user_id, "assigned", 29)
        await _expect(conn, asyncpg.CheckViolationError, TASK, user_id, "assigned", 501)
        for status in ("closed", "in_progress", "declined", "cancelled"):
            await conn.execute(TASK, user_id, status, 200)


async def test_one_task_per_creator_and_request_id() -> None:
    async with _a_task() as (conn, user_id, _):
        same = TASK.replace("gen_random_uuid()", "'11111111-1111-1111-1111-111111111111'")
        await conn.execute(same, user_id, "assigned", 200)
        await _expect(conn, asyncpg.UniqueViolationError, same, user_id, "assigned", 200)


async def test_a_person_is_on_a_task_once_and_the_assignee_status_is_checked() -> None:
    async with _a_task() as (conn, user_id, task_id):
        await conn.execute(
            "INSERT INTO task_assignees (task_id, user_id) VALUES ($1, $2)", task_id, user_id
        )
        await _expect(
            conn,
            asyncpg.UniqueViolationError,
            "INSERT INTO task_assignees (task_id, user_id) VALUES ($1, $2)",
            task_id,
            user_id,
        )
        await _expect(
            conn,
            asyncpg.CheckViolationError,
            "UPDATE task_assignees SET status = 'closed' WHERE task_id = $1",
            task_id,
        )
        await _expect(
            conn,
            asyncpg.CheckViolationError,
            "UPDATE task_assignees SET reach_review = 'maybe' WHERE task_id = $1",
            task_id,
        )


async def test_a_task_request_id_acts_once_per_actor_and_the_timeline_has_known_events() -> None:
    async with _a_task() as (conn, user_id, task_id):
        insert = (
            "INSERT INTO task_events (task_id, actor_id, event, request_id)"
            " VALUES ($1, $2, $3, '22222222-2222-2222-2222-222222222222')"
        )
        await conn.execute(insert, task_id, user_id, "accepted")
        await _expect(conn, asyncpg.UniqueViolationError, insert, task_id, user_id, "started")
        await _expect(conn, asyncpg.CheckViolationError, insert, task_id, None, "teleported")
        # The system (no actor) may write many events without a key.
        system = "INSERT INTO task_events (task_id, event) VALUES ($1, 'escalated')"
        await conn.execute(system, task_id)
        await conn.execute(system, task_id)


async def test_a_punch_may_be_made_at_a_task_site_and_a_user_defaults_to_no_field_punch() -> None:
    async with _a_task() as (conn, user_id, task_id):
        assert (
            await conn.fetchval("SELECT field_punch_in_allowed FROM users WHERE id = $1", user_id)
            is False
        )
        day_id = await conn.fetchval(
            "INSERT INTO attendance_days (user_id, date, status)"
            " VALUES ($1, '2026-10-05', 'working') RETURNING id",
            user_id,
        )
        punch = (
            "INSERT INTO punch_events (attendance_day_id, user_id, type, request_id,"
            " effective_time, location, accuracy_m, location_type, task_id, selfie_key,"
            " face_score, face_decision, face_model_version, thresholds_used, review_status)"
            " VALUES ($1, $2, 'in', gen_random_uuid(), now(),"
            " ST_GeogFromText('POINT(77.2 28.6)'), 10, $3, $4, 'k', 0.9, 'VERIFIED', 'm', '{}',"
            " 'verified')"
        )
        await _expect(conn, asyncpg.CheckViolationError, punch, day_id, user_id, "mars", task_id)
        await conn.execute(punch, day_id, user_id, "task", task_id)
