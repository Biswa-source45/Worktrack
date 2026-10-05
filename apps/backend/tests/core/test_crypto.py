import os

import numpy as np
import pytest
from cryptography.exceptions import InvalidTag

from app.core import crypto

KEY = bytes(range(32))
AAD = b"face:7:3"


def test_round_trip_returns_the_same_embeddings_exactly() -> None:
    embeddings = np.random.default_rng(0).standard_normal((3, 128)).astype("<f4")
    blob = crypto.encrypt(KEY, embeddings.tobytes(), AAD)
    restored = np.frombuffer(crypto.decrypt(KEY, blob, AAD), dtype="<f4").reshape(3, 128)
    assert np.array_equal(restored, embeddings)


def test_the_blob_does_not_contain_the_plaintext() -> None:
    secret = b"sensitive-face-template" * 10
    assert secret[:23] not in crypto.encrypt(KEY, secret, AAD)


def test_a_wrong_key_fails() -> None:
    blob = crypto.encrypt(KEY, b"template", AAD)
    with pytest.raises(InvalidTag):
        crypto.decrypt(os.urandom(32), blob, AAD)


def test_a_blob_copied_to_another_owner_fails() -> None:
    blob = crypto.encrypt(KEY, b"template", b"face:7:3")
    with pytest.raises(InvalidTag):
        crypto.decrypt(KEY, blob, b"face:8:3")


def test_changed_bytes_fail() -> None:
    blob = bytearray(crypto.encrypt(KEY, b"template", AAD))
    blob[-1] ^= 1
    with pytest.raises(InvalidTag):
        crypto.decrypt(KEY, bytes(blob), AAD)


def test_every_encryption_uses_a_new_nonce() -> None:
    first, second = crypto.encrypt(KEY, b"x", AAD), crypto.encrypt(KEY, b"x", AAD)
    assert first[: crypto.NONCE_BYTES] != second[: crypto.NONCE_BYTES]
    assert first != second


def test_the_configured_key_is_32_bytes() -> None:
    assert len(crypto.face_key()) == 32
