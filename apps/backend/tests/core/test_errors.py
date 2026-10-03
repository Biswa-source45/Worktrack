from collections.abc import AsyncIterator

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from app.core.errors import AppError, register_error_handlers


class Login(BaseModel):
    password: str


@pytest.fixture
async def client() -> AsyncIterator[httpx.AsyncClient]:
    app = FastAPI()
    register_error_handlers(app)

    @app.get("/app-error")
    async def app_error() -> None:
        raise AppError("TASK_INVALID_TRANSITION", "Cannot do that", 409, {"from": "a"})

    @app.get("/forbidden")
    async def forbidden() -> None:
        raise HTTPException(status_code=403, detail="Not allowed")

    @app.get("/boom")
    async def boom() -> None:
        raise RuntimeError("secret internal detail")

    @app.post("/login")
    async def login(body: Login) -> None:
        return None

    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


async def test_app_error_uses_standard_format(client: httpx.AsyncClient) -> None:
    response = await client.get("/app-error")
    assert response.status_code == 409
    assert response.json() == {
        "error": {
            "code": "TASK_INVALID_TRANSITION",
            "message": "Cannot do that",
            "details": {"from": "a"},
        }
    }


async def test_http_exception_uses_standard_format(client: httpx.AsyncClient) -> None:
    response = await client.get("/forbidden")
    assert response.status_code == 403
    assert response.json() == {
        "error": {"code": "FORBIDDEN", "message": "Not allowed", "details": None}
    }


async def test_unknown_route_is_not_found(client: httpx.AsyncClient) -> None:
    response = await client.get("/nope")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"


async def test_wrong_method_is_405(client: httpx.AsyncClient) -> None:
    response = await client.post("/forbidden")
    assert response.status_code == 405
    assert response.json()["error"]["code"] == "METHOD_NOT_ALLOWED"


async def test_validation_error_hides_the_submitted_input(client: httpx.AsyncClient) -> None:
    response = await client.post("/login", json={"password": 12345678, "extra": "hunter2"})
    body = response.json()
    assert response.status_code == 422
    assert body["error"]["code"] == "VALIDATION_ERROR"
    assert body["error"]["details"][0]["loc"] == ["body", "password"]
    assert "12345678" not in response.text


async def test_unhandled_exception_does_not_leak_internals(client: httpx.AsyncClient) -> None:
    response = await client.get("/boom")
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "INTERNAL_ERROR"
    assert "secret internal detail" not in response.text
