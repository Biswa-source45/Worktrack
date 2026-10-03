import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest
from dotenv import dotenv_values
from fastapi import FastAPI

# The environment must be ready before app modules are imported (settings are cached).
_root_env = Path(__file__).resolve().parents[3] / ".env"
for _key, _value in {**dotenv_values(_root_env), **os.environ}.items():
    if _value is not None:
        os.environ[_key] = _value
if "TEST_DATABASE_URL" not in os.environ:
    pytest.exit("TEST_DATABASE_URL is not set (see .env.example)", returncode=2)
os.environ["APP_ENV"] = "test"
os.environ["DATABASE_URL"] = os.environ["TEST_DATABASE_URL"]

from app.core.config import Settings, get_settings  # noqa: E402
from app.main import create_app  # noqa: E402
from tests.helpers import run_alembic  # noqa: E402


@asynccontextmanager
async def running_client(settings: Settings | None = None) -> AsyncIterator[httpx.AsyncClient]:
    """A client against a real app with its lifespan running (no ASGI mocking of services)."""
    app: FastAPI = create_app(settings)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=transport, base_url="http://test") as client,
    ):
        yield client


@pytest.fixture(scope="session", autouse=True)
def migrated_db() -> None:
    run_alembic("upgrade", "head")


@pytest.fixture
async def client() -> AsyncIterator[httpx.AsyncClient]:
    async with running_client() as client:
        yield client


@pytest.fixture
def settings() -> Settings:
    return get_settings()
