from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import boto3
from botocore.config import Config
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import Settings, get_settings
from app.core.errors import register_error_handlers
from app.modules.auth.router import router as auth_router
from app.modules.devices.router import router as devices_router
from app.modules.employees.router import router as employees_router
from app.modules.health.router import router as health_router
from app.modules.sessions.router import router as sessions_router


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # Clients connect lazily, so the API starts even when a dependency is down;
        # /health reports it.
        engine = create_async_engine(settings.database_url, pool_pre_ping=True)
        app.state.settings = settings
        app.state.session_factory = async_sessionmaker(engine, expire_on_commit=False)
        app.state.redis = Redis.from_url(settings.redis_url)
        app.state.s3 = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint_url,
            aws_access_key_id=settings.s3_access_key,
            aws_secret_access_key=settings.s3_secret_key,
            region_name=settings.s3_region,
            config=Config(connect_timeout=2, read_timeout=2, retries={"max_attempts": 1}),
        )
        yield
        await app.state.redis.aclose()
        await engine.dispose()

    app = FastAPI(title="WorkTrack API", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    register_error_handlers(app)
    app.include_router(health_router)
    for router in (auth_router, devices_router, employees_router, sessions_router):
        app.include_router(router, prefix="/api/v1")
    return app


app = create_app()
