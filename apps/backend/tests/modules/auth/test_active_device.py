"""require_active_device: the guard the punch endpoints (M4) will use."""

from collections.abc import AsyncIterator
from typing import Annotated

import httpx
import pytest
from fastapi import Depends, FastAPI
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.main import create_app
from app.modules.auth.deps import AuthContext, require_active_device
from tests.conftest import unique_ip
from tests.factories import ADMIN, FIELD, auth_headers, device, make_user


@pytest.fixture
async def guarded_client(db: AsyncSession) -> AsyncIterator[httpx.AsyncClient]:
    app: FastAPI = create_app()

    async def _session() -> AsyncIterator[AsyncSession]:
        yield db

    app.dependency_overrides[get_session] = _session

    @app.get("/test/guarded")
    async def guarded(
        ctx: Annotated[AuthContext, Depends(require_active_device)],
    ) -> dict[str, int]:
        return {"user_id": ctx.user.id}

    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False, client=(unique_ip(), 1))
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=transport, base_url="http://test") as client,
    ):
        yield client


async def test_active_phone_passes(guarded_client: httpx.AsyncClient, db: AsyncSession) -> None:
    user = await make_user(db, FIELD)
    headers = await auth_headers(guarded_client, user, kind="mobile", device_info=device(1))
    response = await guarded_client.get("/test/guarded", headers=headers)
    assert response.status_code == 200 and response.json() == {"user_id": user.id}


async def test_pending_phone_is_blocked_until_approved(
    guarded_client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, FIELD)
    await auth_headers(guarded_client, user, kind="mobile", device_info=device(1))
    headers = await auth_headers(guarded_client, user, kind="mobile", device_info=device(2))
    response = await guarded_client.get("/test/guarded", headers=headers)
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "DEVICE_NOT_APPROVED"


async def test_a_session_without_a_device_is_blocked(
    guarded_client: httpx.AsyncClient, db: AsyncSession
) -> None:
    admin = await make_user(db, ADMIN)  # can log in on the web, which binds no device
    headers = await auth_headers(guarded_client, admin, kind="web")
    response = await guarded_client.get("/test/guarded", headers=headers)
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "DEVICE_NOT_APPROVED"


async def test_missing_token_is_unauthenticated(guarded_client: httpx.AsyncClient) -> None:
    assert (await guarded_client.get("/test/guarded")).status_code == 401
