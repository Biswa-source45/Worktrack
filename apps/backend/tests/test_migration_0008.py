"""Migration 0008: a home location keeps its coordinates only while it is pending or approved."""

import asyncpg
import pytest

from tests.helpers import run_alembic
from tests.test_migration_0003 import _conn, _fetch

STATUSES = ["approved", "pending", "rejected", "replaced", "removed"]


async def _add_user(conn: asyncpg.Connection) -> int:
    user_id: int = await conn.fetchval(
        "INSERT INTO users (emp_code, name, mobile, password_hash, role_id, designation_id,"
        " joined_on) SELECT 'M8-A', 'Person M8', '+919800000800', 'x', r.id, d.id,"
        " '2026-01-01' FROM roles r, designations d"
        " WHERE r.name = 'Office Employee' AND d.name = 'Engineer' RETURNING id"
    )
    return user_id


async def _cleanup() -> None:
    async with _conn() as conn:
        await conn.execute(
            "DELETE FROM home_locations WHERE user_id IN"
            " (SELECT id FROM users WHERE emp_code = 'M8-A')"
        )
        await conn.execute("DELETE FROM users WHERE emp_code = 'M8-A'")


async def _rows() -> dict[str, bool]:
    rows = await _fetch(
        "SELECT h.status, h.location IS NOT NULL AS kept FROM home_locations h"
        " JOIN users u ON u.id = h.user_id WHERE u.emp_code = 'M8-A'"
    )
    return {r["status"]: r["kept"] for r in rows}


async def test_upgrade_clears_closed_rows_and_downgrade_drops_them() -> None:
    try:
        run_alembic("downgrade", "0007")
        async with _conn() as conn:
            user_id = await _add_user(conn)
            for status in STATUSES:
                await conn.execute(
                    "INSERT INTO home_locations (user_id, location, radius_m, source, status)"
                    " VALUES ($1, ST_GeogFromText('POINT(77.2295 28.6129)'), 100, 'self', $2)",
                    user_id,
                    status,
                )
        run_alembic("upgrade", "head")
        assert await _rows() == {
            "approved": True,
            "pending": True,
            "rejected": False,
            "replaced": False,
            "removed": False,
        }
        # Going back, the column is NOT NULL again, so the rows without coordinates are dropped.
        run_alembic("downgrade", "0007")
        assert await _rows() == {"approved": True, "pending": True}
    finally:
        await _cleanup()
        run_alembic("upgrade", "head")


async def test_the_database_refuses_coordinates_on_a_closed_row_and_none_on_an_open_one() -> None:
    insert = (
        "INSERT INTO home_locations (user_id, location, radius_m, source, status)"
        " VALUES ($1, CASE WHEN $3 THEN ST_GeogFromText('POINT(77.2295 28.6129)') END,"
        " 100, 'self', $2)"
    )
    async with _conn() as conn:
        transaction = conn.transaction()
        await transaction.start()
        try:
            user_id = await _add_user(conn)
            for status, with_location in [
                ("rejected", True),
                ("replaced", True),
                ("removed", True),
                ("approved", False),
                ("pending", False),
            ]:
                with pytest.raises(asyncpg.CheckViolationError):
                    async with conn.transaction():
                        await conn.execute(insert, user_id, status, with_location)
            await conn.execute(insert, user_id, "approved", True)
            await conn.execute(insert, user_id, "removed", False)
        finally:
            await transaction.rollback()
