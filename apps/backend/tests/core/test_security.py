from datetime import timedelta

import jwt
import pytest

from app.core.config import Settings
from app.core.security import (
    create_access_token,
    decode_access_token,
    generate_temp_password,
    hash_password,
    hash_token,
    new_refresh_token,
    utcnow,
    verify_password,
)


async def test_password_round_trip_and_wrong_password() -> None:
    hashed = await hash_password("Correct-Horse-1234")
    assert hashed.startswith("$argon2")
    assert await verify_password(hashed, "Correct-Horse-1234")
    assert not await verify_password(hashed, "wrong")


async def test_verify_rejects_a_malformed_hash_instead_of_raising() -> None:
    assert not await verify_password("not-a-hash", "whatever")


def test_temp_passwords_are_long_unambiguous_and_unique() -> None:
    passwords = {generate_temp_password() for _ in range(200)}
    assert len(passwords) == 200
    assert all(len(p) == 12 and not set(p) & set("0O1lI") for p in passwords)


def test_refresh_tokens_are_stored_hashed() -> None:
    token, stored = new_refresh_token()
    assert stored == hash_token(token) and token not in stored
    assert new_refresh_token()[0] != token


def test_access_token_lifetime_is_fifteen_minutes(settings: Settings) -> None:
    token, lifetime = create_access_token(settings, user_id=7, device_row_id=3, client="mobile")
    claims = decode_access_token(settings, token)
    assert claims is not None
    assert lifetime == 900 and claims["exp"] - claims["iat"] == 900
    assert (claims["sub"], claims["dev"], claims["cli"]) == ("7", 3, "mobile")


def test_access_token_without_device_has_no_dev_claim(settings: Settings) -> None:
    token, _ = create_access_token(settings, user_id=7, device_row_id=None, client="web")
    claims = decode_access_token(settings, token)
    assert claims is not None and "dev" not in claims


def _forge(settings: Settings, secret: str | None = None, **claims: object) -> str:
    now = utcnow()
    base = {
        "sub": "1",
        "typ": "access",
        "cli": "web",
        "iat": now,
        "exp": now + timedelta(minutes=5),
    }
    return jwt.encode({**base, **claims}, secret or settings.jwt_secret, algorithm="HS256")


@pytest.mark.parametrize(
    "overrides",
    [
        {"exp": utcnow() - timedelta(seconds=5)},
        {"typ": "refresh"},
        {"typ": None},
    ],
)
def test_bad_claims_are_rejected(settings: Settings, overrides: dict[str, object]) -> None:
    assert decode_access_token(settings, _forge(settings, **overrides)) is None


def test_wrong_signature_garbage_and_alg_none_are_rejected(settings: Settings) -> None:
    assert decode_access_token(settings, _forge(settings, secret="x" * 40)) is None
    assert decode_access_token(settings, "not.a.jwt") is None
    unsigned = jwt.encode({"sub": "1", "typ": "access"}, key="", algorithm="none")
    assert decode_access_token(settings, unsigned) is None
