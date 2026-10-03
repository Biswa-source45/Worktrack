import httpx
import pytest

from app.core.config import Settings
from tests.conftest import running_client


async def test_health_is_ok_when_all_services_are_up(client: httpx.AsyncClient) -> None:
    response = await client.get("/health")
    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "checks": {"database": "ok", "redis": "ok", "storage": "ok"},
    }


async def test_health_is_public_and_exposes_only_statuses(client: httpx.AsyncClient) -> None:
    # No Authorization header is sent: /health is an infra probe, public by design.
    body = (await client.get("/health")).json()
    assert set(body) == {"status", "checks"}
    assert set(body["checks"]) == {"database", "redis", "storage"}


@pytest.mark.parametrize(
    ("component", "override"),
    [
        ("database", {"database_url": "postgresql+asyncpg://x:x@127.0.0.1:1/x"}),
        ("redis", {"redis_url": "redis://127.0.0.1:1/0"}),
        ("storage", {"s3_endpoint_url": "http://127.0.0.1:1"}),
    ],
)
async def test_health_names_the_failed_component(
    settings: Settings, component: str, override: dict[str, str]
) -> None:
    broken = settings.model_copy(update=override)
    async with running_client(broken) as client:
        response = await client.get("/health")
    body = response.json()
    assert response.status_code == 503
    assert body["status"] == "error"
    assert body["checks"][component] == "error"
    assert [name for name, value in body["checks"].items() if value == "ok"] == [
        name for name in ("database", "redis", "storage") if name != component
    ]


async def test_cors_allows_the_configured_origin(settings: Settings) -> None:
    configured = settings.model_copy(update={"cors_origins": ["http://localhost:3000"]})
    async with running_client(configured) as client:
        allowed = await client.get("/health", headers={"Origin": "http://localhost:3000"})
        denied = await client.get("/health", headers={"Origin": "https://evil.example.com"})
    assert allowed.headers["access-control-allow-origin"] == "http://localhost:3000"
    assert "access-control-allow-origin" not in denied.headers
