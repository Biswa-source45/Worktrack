"""AES-256-GCM for data that must be unreadable in the database (face embeddings)."""

import base64
import os
from functools import lru_cache

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import get_settings

NONCE_BYTES = 12


def encrypt(key: bytes, plaintext: bytes, aad: bytes) -> bytes:
    """`nonce || ciphertext+tag`. `aad` binds the blob to its owner: it must match on decrypt."""
    nonce = os.urandom(NONCE_BYTES)
    return nonce + AESGCM(key).encrypt(nonce, plaintext, aad)


def decrypt(key: bytes, blob: bytes, aad: bytes) -> bytes:
    """Raises `cryptography.exceptions.InvalidTag` for a wrong key, wrong `aad` or changed bytes."""
    return AESGCM(key).decrypt(blob[:NONCE_BYTES], blob[NONCE_BYTES:], aad)


@lru_cache
def face_key() -> bytes:
    return base64.b64decode(get_settings().face_encryption_key)
