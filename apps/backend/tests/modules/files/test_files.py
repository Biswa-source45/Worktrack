"""Signed selfie links: the token is the credential, it expires, and only a file token works."""

import uuid
from datetime import timedelta
from typing import Any

import httpx
import jwt
import pytest

from app.core import security, storage
from app.core.config import Settings
from app.modules.files.router import file_url

JPEG = b"\xff\xd8\xff\xe0 not a real photo, bytes only \xff\xd9"


def _state(client: httpx.AsyncClient) -> Any:
    transport = client._transport
    assert isinstance(transport, httpx.ASGITransport)
    return transport.app.state


@pytest.fixture
async def stored(client: httpx.AsyncClient) -> Any:
    state = _state(client)
    key = f"test-files/{uuid.uuid4()}.jpg"
    await storage.put(state.s3, state.settings.s3_bucket, key, JPEG)
    yield key
    await storage.delete(state.s3, state.settings.s3_bucket, [key])


async def test_a_valid_link_returns_the_bytes_without_caching(
    client: httpx.AsyncClient, settings: Settings, stored: str
) -> None:
    response = await client.get(file_url(security.create_file_token(settings, stored)))
    assert response.status_code == 200
    assert response.content == JPEG
    assert response.headers["content-type"] == "image/jpeg"
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"


async def test_a_plain_object_key_is_not_a_link(
    client: httpx.AsyncClient, settings: Settings, stored: str
) -> None:
    assert (await client.get(f"/api/v1/files/{stored}")).status_code == 404  # a key is not a token


async def test_an_expired_link_is_refused(
    client: httpx.AsyncClient, settings: Settings, stored: str
) -> None:
    old = security.utcnow() - timedelta(seconds=security.FILE_LINK_SECONDS + 5)
    token = jwt.encode(
        {"sub": stored, "typ": "file", "iat": old, "exp": old + timedelta(seconds=1)},
        settings.jwt_secret,
        algorithm="HS256",
    )
    response = await client.get(file_url(token))
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "FILE_LINK_INVALID"


async def test_the_link_lasts_five_minutes(settings: Settings) -> None:
    claims = jwt.decode(
        security.create_file_token(settings, "k"), options={"verify_signature": False}
    )
    assert claims["exp"] - claims["iat"] == 300


@pytest.mark.parametrize("tamper", ["wrong-secret", "other-key", "not a jwt"])
async def test_a_changed_or_foreign_token_is_refused(
    client: httpx.AsyncClient, settings: Settings, stored: str, tamper: str
) -> None:
    now = security.utcnow()
    claims = {"sub": stored, "typ": "file", "iat": now, "exp": now + timedelta(minutes=5)}
    token = {
        "wrong-secret": jwt.encode(claims, "x" * 40, algorithm="HS256"),
        "other-key": security.create_file_token(settings, stored)[:-3] + "abc",
        "not a jwt": "garbage",
    }[tamper]
    assert (await client.get(file_url(token))).status_code == 404


async def test_an_access_token_does_not_open_files_and_a_file_token_is_not_a_login(
    client: httpx.AsyncClient, settings: Settings, stored: str
) -> None:
    access, _ = security.create_access_token(
        settings, user_id=1, device_row_id=None, client="web", session_id="s"
    )
    assert (await client.get(file_url(access))).status_code == 404
    assert (
        security.decode_access_token(settings, security.create_file_token(settings, stored)) is None
    )
    assert security.decode_file_token(settings, access) is None


async def test_a_link_to_a_deleted_file_is_refused(
    client: httpx.AsyncClient, settings: Settings, stored: str
) -> None:
    state = _state(client)
    await storage.delete(state.s3, state.settings.s3_bucket, [stored])
    response = await client.get(file_url(security.create_file_token(settings, stored)))
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "FILE_LINK_INVALID"


async def test_deleting_missing_keys_or_nothing_is_fine(client: httpx.AsyncClient) -> None:
    state = _state(client)
    await storage.delete(state.s3, state.settings.s3_bucket, [])
    await storage.delete(state.s3, state.settings.s3_bucket, ["test-files/never-existed.jpg"])
