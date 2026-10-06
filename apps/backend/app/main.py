import ssl
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from functools import lru_cache

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core import storage
from app.core.config import Settings, get_settings
from app.core.errors import register_error_handlers
from app.modules.attendance.admin_router import router as attendance_admin_router
from app.modules.attendance.router import router as attendance_router
from app.modules.auth.router import router as auth_router
from app.modules.branches.router import router as branches_router
from app.modules.devices.router import router as devices_router
from app.modules.employees.router import router as employees_router
from app.modules.face.router import router as face_router
from app.modules.files.router import router as files_router
from app.modules.health.router import router as health_router
from app.modules.notifications.router import router as notifications_router
from app.modules.org_settings.router import router as settings_router
from app.modules.schedule.router import router as schedule_router
from app.modules.sessions.router import router as sessions_router
from app.modules.shifts.router import router as shifts_router


@lru_cache
def _tls_context() -> ssl.SSLContext:
    # Loading the CA bundle takes about 0.3 s, so every app in the process shares one context.
    return httpx.create_ssl_context()


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
        app.state.s3 = storage.make_client(settings)
        # Outbound calls (map links, address search). Redirects are followed by hand, hop by hop.
        app.state.http = httpx.AsyncClient(follow_redirects=False, verify=_tls_context())
        yield
        await app.state.http.aclose()
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
    for router in (
        attendance_admin_router,
        attendance_router,
        auth_router,
        branches_router,
        devices_router,
        employees_router,
        face_router,
        files_router,
        notifications_router,
        schedule_router,
        sessions_router,
        settings_router,
        shifts_router,
    ):
        app.include_router(router, prefix="/api/v1")
    return app


app = create_app()
