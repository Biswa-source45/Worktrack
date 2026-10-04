import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from starlette.concurrency import run_in_threadpool

from app.core.config import Settings

_hasher = PasswordHasher()
# Unambiguous characters only (no 0/O, 1/l/I), so a temporary password survives being read aloud.
_TEMP_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_JWT_ALGORITHM = "HS256"

MIN_PASSWORD_LENGTH = 10
MAX_PASSWORD_LENGTH = 128


def utcnow() -> datetime:
    return datetime.now(UTC)


def _hash_sync(password: str) -> str:
    return _hasher.hash(password)


async def hash_password(password: str) -> str:
    return await run_in_threadpool(_hash_sync, password)


async def hash_passwords(passwords: list[str]) -> list[str]:
    """Hash a batch in one worker thread (used by the bulk import)."""
    return await run_in_threadpool(lambda: [_hash_sync(p) for p in passwords])


def _verify_sync(password_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerificationError, InvalidHashError):
        return False


async def verify_password(password_hash: str, password: str) -> bool:
    return await run_in_threadpool(_verify_sync, password_hash, password)


# Verified when the account does not exist, so a missing user costs the same time as a wrong
# password.
DUMMY_HASH = _hasher.hash(secrets.token_urlsafe(16))


def generate_temp_password() -> str:
    return "".join(secrets.choice(_TEMP_ALPHABET) for _ in range(12))


def new_refresh_token() -> tuple[str, str]:
    """Return (token to give the client, sha256 to store). The raw token is never stored."""
    token = secrets.token_urlsafe(48)
    return token, hash_token(token)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_access_token(
    settings: Settings, *, user_id: int, device_row_id: int | None, client: str
) -> tuple[str, int]:
    """Return (jwt, lifetime in seconds)."""
    now = utcnow()
    lifetime = timedelta(minutes=settings.access_token_minutes)
    claims: dict[str, Any] = {
        "sub": str(user_id),
        "typ": "access",
        "cli": client,
        "iat": now,
        "exp": now + lifetime,
    }
    if device_row_id is not None:
        claims["dev"] = device_row_id
    return jwt.encode(claims, settings.jwt_secret, algorithm=_JWT_ALGORITHM), int(
        lifetime.total_seconds()
    )


def decode_access_token(settings: Settings, token: str) -> dict[str, Any] | None:
    """Return the claims, or None for any invalid, expired or wrong-type token."""
    try:
        claims: dict[str, Any] = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=[_JWT_ALGORITHM],
            options={"require": ["exp", "iat", "sub"]},
        )
    except jwt.InvalidTokenError:
        return None
    return claims if claims.get("typ") == "access" else None
