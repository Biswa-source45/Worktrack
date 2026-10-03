from typing import Any, ClassVar

from arq.connections import RedisSettings

from app.core.config import get_settings


async def ping(ctx: dict[str, Any]) -> str:
    return "pong"


class WorkerSettings:
    functions: ClassVar[list[Any]] = [ping]
    redis_settings = RedisSettings.from_dsn(get_settings().redis_url)
