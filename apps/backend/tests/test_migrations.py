import os

import asyncpg

from tests.helpers import run_alembic


async def _postgis_installed() -> bool:
    dsn = os.environ["DATABASE_URL"].replace("+asyncpg", "")
    conn = await asyncpg.connect(dsn)
    try:
        installed = await conn.fetchval("SELECT 1 FROM pg_extension WHERE extname = 'postgis'")
        return installed == 1
    finally:
        await conn.close()


async def test_baseline_upgrade_downgrade_upgrade() -> None:
    try:
        run_alembic("downgrade", "base")
        assert not await _postgis_installed()
        run_alembic("upgrade", "head")
        assert await _postgis_installed()
    finally:
        run_alembic("upgrade", "head")
