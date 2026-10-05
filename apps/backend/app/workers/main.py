from typing import Any, ClassVar

from arq import cron
from arq.connections import RedisSettings
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core import storage
from app.core.config import get_settings
from app.modules.audit.service import AuditCtx
from app.modules.face.service import purge_departed
from app.modules.sessions.service import purge_ended


async def ping(ctx: dict[str, Any]) -> str:
    return "pong"


async def purge_sessions(ctx: dict[str, Any]) -> int:
    """Drop sign-in sessions that ended longer ago than the retention period."""
    settings = get_settings()
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            return await purge_ended(session, settings.session_retention_days)
    finally:
        await engine.dispose()


async def purge_faces(ctx: dict[str, Any]) -> int:
    """Delete the face photos and templates of people who left long enough ago."""
    settings = get_settings()
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            return await purge_departed(
                session, storage.make_client(settings), settings.s3_bucket, AuditCtx(None, None)
            )
    finally:
        await engine.dispose()


class WorkerSettings:
    functions: ClassVar[list[Any]] = [ping, purge_sessions, purge_faces]
    # 21:30 UTC is 03:00 IST, when nobody is signing in.
    cron_jobs: ClassVar[list[Any]] = [
        cron(purge_sessions, hour=21, minute=30),
        cron(purge_faces, hour=21, minute=35),
    ]
    redis_settings = RedisSettings.from_dsn(get_settings().redis_url)
