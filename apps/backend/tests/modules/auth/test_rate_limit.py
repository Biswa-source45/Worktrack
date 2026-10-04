from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.modules.auth.service import _check_ip_limit
from tests.conftest import running_client, unique_ip
from tests.factories import ADMIN, login, make_user


def _limited(settings: Settings, limit: int) -> Settings:
    return settings.model_copy(update={"login_ip_limit": limit})


async def test_login_attempts_are_limited_per_ip(db: AsyncSession, settings: Settings) -> None:
    user = await make_user(db, ADMIN)
    async with running_client(_limited(settings, 3), db, unique_ip()) as client:
        # Successful and failed attempts both count toward the per-IP budget.
        assert (await login(client, user)).status_code == 200
        assert (await login(client, user, password="bad-password")).status_code == 401
        assert (await login(client, user)).status_code == 200
        blocked = await login(client, user)
    assert blocked.status_code == 429
    error = blocked.json()["error"]
    assert error["code"] == "RATE_LIMITED"
    assert 0 < error["details"]["retry_after_seconds"] <= 15 * 60


async def test_the_limit_is_per_ip_not_global(db: AsyncSession, settings: Settings) -> None:
    user = await make_user(db, ADMIN)
    limited = _limited(settings, 1)
    async with running_client(limited, db, unique_ip()) as first:
        await login(first, user)
        assert (await login(first, user)).status_code == 429
    async with running_client(limited, db, unique_ip()) as other:
        assert (await login(other, user)).status_code == 200


async def test_the_window_is_never_extended_by_further_attempts(
    db: AsyncSession, settings: Settings
) -> None:
    user = await make_user(db, ADMIN)
    ip = unique_ip()
    async with running_client(_limited(settings, 1), db, ip) as client:
        await login(client, user)
        first = (await login(client, user)).json()["error"]["details"]["retry_after_seconds"]
        second = (await login(client, user)).json()["error"]["details"]["retry_after_seconds"]
    assert second <= first <= 15 * 60


async def test_a_higher_limit_from_settings_lets_more_attempts_through(
    db: AsyncSession, settings: Settings
) -> None:
    user = await make_user(db, ADMIN)
    async with running_client(_limited(settings, 25), db, unique_ip()) as client:
        responses = [await login(client, user, password="bad-password") for _ in range(6)]
    assert [r.status_code for r in responses[:5]] == [401] * 5
    # The sixth is answered by the per-account lock, not by the IP limit.
    assert responses[5].json()["error"]["code"] == "ACCOUNT_LOCKED"


async def test_the_limiter_fails_open_when_redis_is_down(settings: Settings) -> None:
    dead = Redis(host="127.0.0.1", port=1, socket_connect_timeout=0.2)
    try:
        await _check_ip_limit(dead, settings, "10.9.9.9")  # must not raise
    finally:
        await dead.aclose()
