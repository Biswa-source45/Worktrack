"""Migration 0003: canonical mobile numbers and devices.last_seen_at.

These tests move the shared test database down to 0002 and back, so they always finish with
the schema at head and delete only the users they inserted (audit_logs is append-only, so the
users are inserted with raw SQL and never get audit rows).
"""

import os
import subprocess
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import asyncpg
import pytest

from tests.helpers import run_alembic

# (emp_code, raw mobile, canonical mobile)
DIRTY = [
    ("M3-A", "9876543210", "+919876543210"),
    ("M3-B", "+91 91234 56789", "+919123456789"),
    ("M3-C", "98111-22233", "+919811122233"),
    ("M3-D", "(98222) 33344", "+919822233344"),
    ("M3-E", "09833344455", "+919833344455"),
    ("M3-F", "919844455566", "+919844455566"),
    ("M3-G", "0091 98555 66677", "+919855566677"),
    ("M3-H", "+14155552671", "+14155552671"),
    ("M3-I", "+919866677788", "+919866677788"),  # already canonical
]
CODES = [code for code, _, _ in DIRTY] + ["M3-X", "M3-Y"]


@asynccontextmanager
async def _conn() -> AsyncIterator[asyncpg.Connection]:
    conn = await asyncpg.connect(os.environ["DATABASE_URL"].replace("+asyncpg", ""))
    try:
        yield conn
    finally:
        await conn.close()


async def _insert_users(rows: list[tuple[str, str]]) -> None:
    async with _conn() as conn:
        role = await conn.fetchval("SELECT id FROM roles WHERE name = 'Office Employee'")
        designation = await conn.fetchval("SELECT id FROM designations WHERE name = 'Engineer'")
        for code, mobile in rows:
            await conn.execute(
                "INSERT INTO users (emp_code, name, mobile, password_hash, role_id, designation_id,"
                " joined_on) VALUES ($1, $2, $3, 'x', $4, $5, '2026-01-01')",
                code,
                f"Person {code}",
                mobile,
                role,
                designation,
            )


async def _mobiles() -> dict[str, str]:
    async with _conn() as conn:
        rows = await conn.fetch(
            "SELECT emp_code, mobile FROM users WHERE emp_code = ANY($1)", CODES
        )
    return {r["emp_code"]: r["mobile"] for r in rows}


async def _fetch(sql: str) -> list[Any]:
    async with _conn() as conn:
        return list(await conn.fetch(sql))


@asynccontextmanager
async def _at_0002() -> AsyncIterator[None]:
    """Schema at 0002 for the body; afterwards the test users are gone and the schema is at head."""
    try:
        run_alembic("downgrade", "0002")
        yield
    finally:
        async with _conn() as conn:
            await conn.execute(
                "DELETE FROM user_devices WHERE user_id IN"
                " (SELECT id FROM users WHERE emp_code = ANY($1))",
                CODES,
            )
            await conn.execute("DELETE FROM users WHERE emp_code = ANY($1)", CODES)
        run_alembic("upgrade", "head")


async def test_upgrade_makes_numbers_canonical_and_downgrade_keeps_them() -> None:
    async with _at_0002():
        await _insert_users([(code, raw) for code, raw, _ in DIRTY])
        run_alembic("upgrade", "head")
        assert await _mobiles() == {code: canonical for code, _, canonical in DIRTY}

        run_alembic("downgrade", "0002")
        assert await _mobiles() == {code: canonical for code, _, canonical in DIRTY}
        assert not await _fetch(
            "SELECT 1 FROM information_schema.columns"
            " WHERE table_name = 'user_devices' AND column_name = 'last_seen_at'"
        )
        assert not await _fetch(
            "SELECT 1 FROM pg_constraint WHERE conname = 'ck_users_mobile_e164'"
        )


async def test_the_check_constraint_and_last_seen_column_exist_at_head() -> None:
    assert await _fetch("SELECT 1 FROM pg_constraint WHERE conname = 'ck_users_mobile_e164'")
    column = await _fetch(
        "SELECT is_nullable, column_default FROM information_schema.columns"
        " WHERE table_name = 'user_devices' AND column_name = 'last_seen_at'"
    )
    assert column[0]["is_nullable"] == "NO"
    assert "now()" in column[0]["column_default"]
    async with _conn() as conn:
        with pytest.raises(asyncpg.CheckViolationError):
            await conn.execute(
                "INSERT INTO users (emp_code, name, mobile, password_hash, role_id, designation_id,"
                " joined_on) SELECT 'M3-X', 'x', '9876543210', 'x', r.id, d.id, '2026-01-01'"
                " FROM roles r, designations d LIMIT 1"
            )


async def test_existing_devices_get_a_last_seen_time() -> None:
    async with _at_0002():
        await _insert_users([("M3-X", "9000000001")])
        async with _conn() as conn:
            await conn.execute(
                "INSERT INTO user_devices (user_id, device_id, model, os, app_version, status)"
                " SELECT id, 'dev-m3', 'Pixel', 'Android', '0.1', 'active'"
                " FROM users WHERE emp_code = 'M3-X'"
            )
        run_alembic("upgrade", "head")
        rows = await _fetch("SELECT last_seen_at FROM user_devices WHERE device_id = 'dev-m3'")
        assert rows[0]["last_seen_at"] is not None


def _upgrade_error() -> str:
    with pytest.raises(subprocess.CalledProcessError) as failure:
        run_alembic("upgrade", "head")
    return str(failure.value.stderr)


async def test_a_clash_aborts_the_upgrade_and_lists_both_users() -> None:
    async with _at_0002():
        rows = [("M3-X", "9876543210"), ("M3-Y", "+919876543210"), ("M3-A", "9811122233")]
        await _insert_users(rows)
        message = _upgrade_error()
        assert "RuntimeError" in message
        assert "same number" in message
        assert "emp_code=M3-X" in message
        assert "emp_code=M3-Y" in message
        assert "'9876543210'" in message
        assert "'+919876543210'" in message
        assert "clashes with emp_code=M3-Y" in message
        assert "clashes with emp_code=M3-X" in message
        assert "Nothing was changed" in message
        # The clean row was not touched either, and the schema is still at 0002.
        assert await _mobiles() == dict(rows)
        assert (await _fetch("SELECT version_num FROM alembic_version"))[0][0] == "0002"


async def test_an_unparseable_number_aborts_the_upgrade() -> None:
    async with _at_0002():
        rows = [("M3-X", "not-a-number"), ("M3-Y", "12345"), ("M3-A", "9811122233")]
        await _insert_users(rows)
        message = _upgrade_error()
        assert "not valid" in message
        assert "emp_code=M3-X" in message
        assert "'not-a-number'" in message
        assert "emp_code=M3-Y" in message
        assert "emp_code=M3-A" not in message
        assert await _mobiles() == dict(rows)
        assert (await _fetch("SELECT version_num FROM alembic_version"))[0][0] == "0002"


async def test_models_and_migrations_agree() -> None:
    # `alembic check` fails when autogenerate would still produce changes (schema drift).
    run_alembic("check")
