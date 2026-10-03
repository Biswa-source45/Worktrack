import asyncio
import logging
from collections.abc import Awaitable
from typing import TYPE_CHECKING

from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.modules.health.schemas import HealthChecks, HealthResponse

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client

logger = logging.getLogger(__name__)

PROBE_TIMEOUT_SECONDS = 3


async def _probe(name: str, check: Awaitable[object]) -> bool:
    try:
        await asyncio.wait_for(check, PROBE_TIMEOUT_SECONDS)
    except Exception:
        # Details stay in the log; the public response only says "error".
        logger.warning("health check failed: %s", name, exc_info=True)
        return False
    return True


async def check_health(
    session: AsyncSession, redis: Redis, s3: "S3Client", bucket: str
) -> HealthResponse:
    # postgis_version() proves the extension is installed, not just that Postgres answers.
    database, cache, storage = await asyncio.gather(
        _probe("database", session.execute(text("SELECT postgis_version()"))),
        _probe("redis", redis.ping()),
        _probe("storage", run_in_threadpool(s3.head_bucket, Bucket=bucket)),
    )
    checks = HealthChecks(
        database="ok" if database else "error",
        redis="ok" if cache else "error",
        storage="ok" if storage else "error",
    )
    status = "ok" if database and cache and storage else "error"
    return HealthResponse(status=status, checks=checks)
