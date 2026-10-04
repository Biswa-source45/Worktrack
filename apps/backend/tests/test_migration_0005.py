"""Migration 0005: sign-in sessions, with one session for every login that already exists."""

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from tests.helpers import run_alembic
from tests.test_migration_0003 import _conn, _fetch

CODE = "M5-A"
LIVE, OVER = uuid.uuid4(), uuid.uuid4()


async def _cleanup() -> None:
    async with _conn() as conn:
        exists = await conn.fetchval("SELECT to_regclass('auth_sessions') IS NOT NULL")
        if exists:
            await conn.execute(
                "DELETE FROM auth_sessions WHERE user_id IN"
                " (SELECT id FROM users WHERE emp_code = $1)",
                CODE,
            )
        await conn.execute(
            "DELETE FROM refresh_tokens WHERE user_id IN"
            " (SELECT id FROM users WHERE emp_code = $1)",
            CODE,
        )
        await conn.execute("DELETE FROM users WHERE emp_code = $1", CODE)


@asynccontextmanager
async def _at_0004() -> AsyncIterator[None]:
    try:
        run_alembic("downgrade", "0004")
        yield
    finally:
        await _cleanup()
        run_alembic("upgrade", "head")


async def _token(family: uuid.UUID, name: str, created: str, revoked: str | None) -> None:
    async with _conn() as conn:
        await conn.execute(
            "INSERT INTO refresh_tokens (user_id, family_id, token_hash, client, expires_at,"
            " revoked_at, created_at) SELECT id, $2, $3, 'web',"
            " $4::text::timestamptz + interval '30 days', $5::text::timestamptz,"
            " $4::text::timestamptz FROM users WHERE emp_code = $1",
            CODE,
            family,
            name,
            created,
            revoked,
        )


async def test_upgrade_creates_a_session_per_existing_login_and_downgrade_drops_the_table() -> None:
    async with _at_0004():
        assert not await _fetch("SELECT 1 WHERE to_regclass('auth_sessions') IS NOT NULL")
        async with _conn() as conn:
            await conn.execute(
                "INSERT INTO users (emp_code, name, mobile, password_hash, role_id, designation_id,"
                " joined_on) SELECT $1, 'Person M5', '+919800000500', 'x', r.id, d.id, '2026-01-01'"
                " FROM roles r, designations d WHERE r.name = 'Admin/HR' AND d.name = 'Engineer'",
                CODE,
            )
        # A login rotated once and still live; a login whose every token is revoked.
        await _token(LIVE, "m5-live-1", "2026-10-01T10:00:00Z", "2026-10-02T10:00:00Z")
        await _token(LIVE, "m5-live-2", "2026-10-02T10:00:00Z", None)
        await _token(OVER, "m5-over-1", "2026-09-01T10:00:00Z", "2026-09-03T10:00:00Z")

        run_alembic("upgrade", "head")
        async with _conn() as conn:
            found = await conn.fetch(
                "SELECT s.* FROM auth_sessions s JOIN users u ON u.id = s.user_id"
                " WHERE u.emp_code = $1",
                CODE,
            )
        rows = {r["family_id"]: r for r in found}
        assert set(rows) == {LIVE, OVER}
        live, over = rows[LIVE], rows[OVER]
        assert (live["client"], live["ended_at"], live["end_reason"]) == ("web", None, None)
        assert live["created_at"].isoformat() == "2026-10-01T10:00:00+00:00"
        assert live["last_seen_at"].isoformat() == "2026-10-02T10:00:00+00:00"
        assert live["expires_at"].isoformat() == "2026-11-01T10:00:00+00:00"
        assert (live["browser"], live["ip"]) == (None, None)
        assert over["ended_at"].isoformat() == "2026-09-03T10:00:00+00:00"
        assert over["end_reason"] == "before_tracking"

        run_alembic("downgrade", "0004")
        assert not await _fetch("SELECT 1 WHERE to_regclass('auth_sessions') IS NOT NULL")
        # The logins themselves are untouched by the downgrade.
        assert len(await _fetch("SELECT 1 FROM refresh_tokens WHERE token_hash LIKE 'm5-%'")) == 3
