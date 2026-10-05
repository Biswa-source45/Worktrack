"""Migration 0009: face enrollments, the face.review permission, users.deactivated_at.

Like the earlier migration tests, these move the shared test database down one revision and back,
and delete only the rows they inserted.
"""

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import asyncpg
import pytest

from tests.helpers import run_alembic
from tests.test_migration_0003 import _conn, _fetch

CODES = ["M9-A", "M9-B"]


async def _insert_user(emp_code: str, status: str) -> None:
    async with _conn() as conn:
        await conn.execute(
            "INSERT INTO users (emp_code, name, mobile, password_hash, role_id, designation_id,"
            " joined_on, status, updated_at) SELECT $1, 'Person M9', $2, 'x', r.id, d.id,"
            " '2026-01-01', $3, '2026-03-04T05:06:07+00' FROM roles r, designations d"
            " WHERE r.name = 'Office Employee' AND d.name = 'Engineer'",
            emp_code,
            f"+9198000009{CODES.index(emp_code):02d}",
            status,
        )


@asynccontextmanager
async def _at_0008() -> AsyncIterator[None]:
    try:
        run_alembic("downgrade", "0008")
        yield
    finally:
        async with _conn() as conn:
            await conn.execute("DELETE FROM roles WHERE name = 'M9 Custom'")
            await conn.execute("DELETE FROM users WHERE emp_code = ANY($1)", CODES)
        run_alembic("upgrade", "head")


async def _table_exists() -> bool:
    return bool(await _fetch("SELECT 1 FROM pg_tables WHERE tablename = 'face_enrollments'"))


async def _permissions() -> dict[str, set[str]]:
    rows = await _fetch("SELECT name, permissions FROM roles")
    return {r["name"]: set(json.loads(r["permissions"])) for r in rows}


async def test_upgrade_adds_table_column_and_permission_and_downgrade_removes_them() -> None:
    async with _at_0008():
        assert not await _table_exists()
        before = await _permissions()
        assert not {"face.review"} & set().union(*before.values())
        await _insert_user("M9-A", "inactive")
        await _insert_user("M9-B", "active")

        # Revision 0009, not head: later migrations grant more permissions (same as 0006's test).
        run_alembic("upgrade", "0009")
        assert await _table_exists()
        after = await _permissions()
        assert after["Super Admin"] == before["Super Admin"] | {"face.review"}
        assert after["Admin/HR"] == before["Admin/HR"] | {"face.review"}
        for role in ("Task Assigner", "Field Employee", "Office Employee"):
            assert after[role] == before[role]
        rows = await _fetch(
            "SELECT emp_code, deactivated_at FROM users WHERE emp_code LIKE 'M9-%' ORDER BY 1"
        )
        # An account that was already inactive gets its last change as the start of the clock.
        assert rows[0]["deactivated_at"].isoformat().startswith("2026-03-04T05:06:07")
        assert rows[1]["deactivated_at"] is None

        async with _conn() as conn:
            await conn.execute(
                "INSERT INTO roles (name, permissions) VALUES"
                " ('M9 Custom', '[\"web.access\", \"face.review\"]')"
            )
        run_alembic("downgrade", "0008")
        assert not await _table_exists()
        down = await _permissions()
        assert down.pop("M9 Custom") == {"web.access"}
        assert down == before
        assert not await _fetch(
            "SELECT 1 FROM information_schema.columns"
            " WHERE table_name = 'users' AND column_name = 'deactivated_at'"
        )


async def _expect(error: type[Exception], sql: str, *args: object) -> None:
    async with _conn() as conn:
        transaction = conn.transaction()
        await transaction.start()
        try:
            with pytest.raises(error):
                await conn.execute(sql, *args)
        finally:
            await transaction.rollback()


async def _user_id() -> int:
    async with _conn() as conn:
        return int(
            await conn.fetchval(
                "INSERT INTO users (emp_code, name, mobile, password_hash, role_id,"
                " designation_id, joined_on) SELECT 'M9-A', 'Person M9', '+919800000900', 'x',"
                " r.id, d.id, '2026-01-01' FROM roles r, designations d"
                " WHERE r.name = 'Office Employee' AND d.name = 'Engineer' RETURNING id"
            )
        )


@asynccontextmanager
async def _a_user() -> AsyncIterator[int]:
    user_id = await _user_id()
    try:
        yield user_id
    finally:
        async with _conn() as conn:
            await conn.execute("DELETE FROM face_enrollments WHERE user_id = $1", user_id)
            await conn.execute("DELETE FROM users WHERE id = $1", user_id)


INSERT = (
    "INSERT INTO face_enrollments (user_id, status, consent_at, embeddings, image_keys)"
    " VALUES ($1, $2, now(), $3, $4)"
)


async def test_the_database_keeps_face_data_only_on_pending_and_approved_rows() -> None:
    async with _a_user() as user_id:
        for status in ("pending", "approved"):
            await _expect(asyncpg.CheckViolationError, INSERT, user_id, status, None, None)
            await _expect(asyncpg.CheckViolationError, INSERT, user_id, status, b"x", None)
        for status in ("consented", "rejected", "reset"):
            await _expect(asyncpg.CheckViolationError, INSERT, user_id, status, b"x", ["k"])
        await _expect(asyncpg.CheckViolationError, INSERT, user_id, "bogus", None, None)


async def test_only_one_open_enrollment_per_person_but_closed_ones_pile_up() -> None:
    async with _a_user() as user_id, _conn() as conn:
        await conn.execute(INSERT, user_id, "rejected", None, None)
        await conn.execute(INSERT, user_id, "reset", None, None)
        await conn.execute(INSERT, user_id, "approved", b"x", ["k"])
        for status, data in (("consented", None), ("pending", b"x"), ("approved", b"x")):
            keys = None if data is None else ["k"]
            with pytest.raises(asyncpg.UniqueViolationError):
                await conn.execute(INSERT, user_id, status, data, keys)
        # Closing the open one frees the slot.
        await conn.execute(
            "UPDATE face_enrollments SET status = 'reset', embeddings = NULL, image_keys = NULL"
            " WHERE user_id = $1 AND status = 'approved'",
            user_id,
        )
        await conn.execute(INSERT, user_id, "consented", None, None)
