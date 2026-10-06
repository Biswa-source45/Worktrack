from typing import Any, ClassVar

from arq import cron
from arq.connections import RedisSettings
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core import storage
from app.core.config import get_settings
from app.core.security import utcnow
from app.modules.attendance.jobs import housekeeping
from app.modules.audit.service import AuditCtx
from app.modules.face.service import purge_departed, sweep_orphans
from app.modules.sessions.service import purge_ended
from app.modules.tasks.escalation import escalate_unaccepted


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
    """Delete the face data of people who left long enough ago, and photos nothing refers to."""
    settings = get_settings()
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            s3 = storage.make_client(settings)
            purged = await purge_departed(session, s3, settings.s3_bucket, AuditCtx(None, None))
            # Photos whose earlier delete failed (storage down for a moment).
            return purged + await sweep_orphans(session, s3, settings.s3_bucket)
    finally:
        await engine.dispose()


async def attendance_housekeeping(ctx: dict[str, Any]) -> dict[str, int]:
    """Missed punch-outs, absent and off-day rows, expired requests, shift-end reminders."""
    settings = get_settings()
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            return await housekeeping(session, utcnow())
    finally:
        await engine.dispose()


async def task_escalation(ctx: dict[str, Any]) -> int:
    """Tell the assigner about tasks nobody accepted in time."""
    settings = get_settings()
    engine = create_async_engine(settings.database_url)
    try:
        async with AsyncSession(engine) as session:
            return await escalate_unaccepted(session, utcnow())
    finally:
        await engine.dispose()


class WorkerSettings:
    functions: ClassVar[list[Any]] = [
        ping,
        purge_sessions,
        purge_faces,
        attendance_housekeeping,
        task_escalation,
    ]
    # 21:30 UTC is 03:00 IST, when nobody is signing in.
    cron_jobs: ClassVar[list[Any]] = [
        cron(purge_sessions, hour=21, minute=30),
        cron(purge_faces, hour=21, minute=35),
        # Every ten minutes: the cut-off and the reminders are wall-clock times from Settings.
        cron(attendance_housekeeping, minute={0, 10, 20, 30, 40, 50}),
        # Every five minutes: the wait before escalating is a setting, in minutes.
        cron(task_escalation, minute=set(range(0, 60, 5))),
    ]
    redis_settings = RedisSettings.from_dsn(get_settings().redis_url)
