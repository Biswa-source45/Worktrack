import contextlib
import itertools
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import boto3
import httpx
import pytest
from dotenv import dotenv_values
from fastapi import FastAPI
from redis import Redis
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

# The environment must be ready before app modules are imported (settings are cached).
_root_env = Path(__file__).resolve().parents[3] / ".env"
for _key, _value in {**dotenv_values(_root_env), **os.environ}.items():
    if _value is not None:
        os.environ[_key] = _value
if "TEST_DATABASE_URL" not in os.environ:
    pytest.exit("TEST_DATABASE_URL is not set (see .env.example)", returncode=2)
# Tests drop and recreate tables, so they must never be pointed at the development database.
_test_db_name = os.environ["TEST_DATABASE_URL"].rsplit("/", 1)[-1].split("?")[0]
if not _test_db_name.endswith("_test") or os.environ["TEST_DATABASE_URL"] == os.environ.get(
    "DATABASE_URL"
):
    pytest.exit(
        "TEST_DATABASE_URL must name a database ending in '_test' and differ from DATABASE_URL",
        returncode=2,
    )
os.environ["APP_ENV"] = "test"
os.environ["DATABASE_URL"] = os.environ["TEST_DATABASE_URL"]
# Photo keys are built from row ids, which also exist in the dev database: own bucket.
os.environ["S3_BUCKET"] = "worktrack-test"
os.environ.setdefault("JWT_SECRET", "test-only-jwt-secret-test-only-jwt-secret")
os.environ.setdefault("FACE_ENCRYPTION_KEY", "dGVzdC1vbmx5LWZhY2Uta2V5LXRlc3Qtb25seS0xMjM=")

from argon2 import PasswordHasher  # noqa: E402

from app.core import security  # noqa: E402
from app.core.config import Settings, get_settings  # noqa: E402
from app.core.db import get_session  # noqa: E402
from app.main import create_app  # noqa: E402
from tests.helpers import run_alembic  # noqa: E402

# Tests create hundreds of users: use the cheapest Argon2 parameters (verify reads the hash).
security._hasher = PasswordHasher(time_cost=1, memory_cost=8, parallelism=1)

_ip_counter = itertools.count(1)


def unique_ip() -> str:
    """A fresh client IP per test client, so the per-IP login limit never leaks across tests."""
    n = next(_ip_counter)
    return f"10.{(n >> 16) & 255}.{(n >> 8) & 255}.{n & 255}"


@asynccontextmanager
async def running_client(
    settings: Settings | None = None,
    session: AsyncSession | None = None,
    client_ip: str | None = None,
) -> AsyncIterator[httpx.AsyncClient]:
    """A client against a real app with its lifespan running (no ASGI mocking of services).

    With `session`, every request uses it, so a test can run inside a rolled-back transaction.
    """
    app: FastAPI = create_app(settings)
    if session is not None:

        async def _session() -> AsyncIterator[AsyncSession]:
            yield session

        app.dependency_overrides[get_session] = _session
    transport = httpx.ASGITransport(
        app=app, raise_app_exceptions=False, client=(client_ip or unique_ip(), 50000)
    )
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=transport, base_url="http://test") as client,
    ):
        yield client


@pytest.fixture(scope="session", autouse=True)
def migrated_db() -> None:
    run_alembic("upgrade", "head")
    s3 = boto3.client(
        "s3",
        endpoint_url=os.environ["S3_ENDPOINT_URL"],
        aws_access_key_id=os.environ["S3_ACCESS_KEY"],
        aws_secret_access_key=os.environ["S3_SECRET_KEY"],
        region_name=os.environ.get("S3_REGION", "us-east-1"),
    )
    with contextlib.suppress(s3.exceptions.BucketAlreadyOwnedByYou):
        s3.create_bucket(Bucket=os.environ["S3_BUCKET"])
    # Rate-limit counters live in Redis for 15 minutes; clear those left by earlier runs.
    with Redis.from_url(os.environ["REDIS_URL"]) as redis:
        for key in redis.scan_iter("rl:login:10.*"):
            redis.delete(key)


@pytest.fixture
async def db() -> AsyncIterator[AsyncSession]:
    """A session inside a transaction that is rolled back after the test.

    The app's own commits become savepoint releases, so tests start from the migrated data only.
    """
    engine = create_async_engine(get_settings().database_url)
    async with engine.connect() as connection:
        outer = await connection.begin()
        session = AsyncSession(
            bind=connection, join_transaction_mode="create_savepoint", expire_on_commit=False
        )
        try:
            yield session
        finally:
            await session.close()
            await outer.rollback()
    await engine.dispose()


@pytest.fixture
async def client(db: AsyncSession) -> AsyncIterator[httpx.AsyncClient]:
    async with running_client(session=db) as client:
        yield client


@pytest.fixture
def settings() -> Settings:
    return get_settings()
