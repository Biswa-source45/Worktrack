"""AES-256-GCM for data that must be unreadable in the database (face embeddings)."""

import base64
import os
from functools import lru_cache

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import get_settings

NONCE_BYTES = 12
# Which key sealed a blob. A rotation then knows which key to try instead of guessing.
KEY_VERSION = 1


def encrypt(key: bytes, plaintext: bytes, aad: bytes) -> bytes:
    """`version || nonce || ciphertext+tag`. `aad` binds the blob to its owner."""
    nonce = os.urandom(NONCE_BYTES)
    return bytes([KEY_VERSION]) + nonce + AESGCM(key).encrypt(nonce, plaintext, aad)


def decrypt(key: bytes, blob: bytes, aad: bytes) -> bytes:
    """Raises `InvalidTag` for a wrong key, wrong `aad` or changed bytes, ValueError for a blob
    that is not ours (empty, or sealed by a key version this code does not know)."""
    if not blob or blob[0] != KEY_VERSION:
        raise ValueError("unknown key version")
    body = blob[1:]
    return AESGCM(key).decrypt(body[:NONCE_BYTES], body[NONCE_BYTES:], aad)


@lru_cache
def face_key() -> bytes:
    return base64.b64decode(get_settings().face_encryption_key)
