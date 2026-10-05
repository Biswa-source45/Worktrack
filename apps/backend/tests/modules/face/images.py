"""Test photos built from the four public-domain fixtures (see tests/fixtures/face/SOURCES.md)."""

from functools import cache
from pathlib import Path

import cv2
import numpy as np
from numpy.typing import NDArray

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "face"
PEOPLE = ("a", "b", "c", "d")

Image = NDArray[np.uint8]


def jpeg(image: Image, quality: int = 90) -> bytes:
    return cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, quality])[1].tobytes()


@cache
def _load(person: str) -> Image:
    image = cv2.imread(str(FIXTURES / f"person_{person}.jpg"))
    assert image is not None, f"missing fixture person_{person}.jpg"
    image.setflags(write=False)
    return image  # type: ignore[no-any-return]


def person(name: str) -> Image:
    return _load(name).copy()


def photo(name: str) -> bytes:
    return jpeg(person(name))


def same_person(name: str, variant: int = 0) -> bytes:
    """A different photo of the same (generated) person: turned, cropped, re-lit, re-compressed."""
    image = person(name)
    height, width = image.shape[:2]
    angle = (7, -9, 5)[variant % 3]
    matrix = cv2.getRotationMatrix2D((width / 2, height / 2), angle, 1.0)
    turned = cv2.warpAffine(image, matrix, (width, height), borderMode=cv2.BORDER_REPLICATE)
    cropped = turned[20 + 5 * variant : 480, 20 : 480 - 5 * variant]
    lit = cv2.convertScaleAbs(cropped, alpha=0.8 + 0.1 * variant, beta=15)
    return jpeg(lit, quality=70)


def blurred(name: str, sigma: float = 5) -> bytes:
    return jpeg(cv2.GaussianBlur(person(name), (0, 0), sigma))


def darkened(name: str, factor: float = 0.3) -> bytes:
    return jpeg((person(name) * factor).astype(np.uint8))


def brightened(name: str, add: int = 70) -> bytes:
    return jpeg(np.clip(person(name).astype(np.int16) + add, 0, 255).astype(np.uint8))


def two_faces(first: str = "a", second: str = "b") -> bytes:
    return jpeg(np.hstack([person(first), person(second)]))


def empty_wall() -> bytes:
    return jpeg(np.full((480, 480, 3), 127, np.uint8))


def noise() -> bytes:
    rng = np.random.default_rng(1)
    return jpeg(rng.integers(0, 256, (480, 480, 3), dtype=np.uint8))


def large(name: str) -> bytes:
    """The face on a big canvas (1600 x 1200) so the decoder has to shrink it."""
    canvas = np.full((1200, 1600, 3), 90, np.uint8)
    canvas[100:1100, 300:1300] = cv2.resize(person(name), (1000, 1000))
    return jpeg(canvas)


def exif_rotated(name: str) -> bytes:
    """The face turned on its side with an EXIF 'rotate 90 clockwise' tag, as phones save it."""
    sideways = cv2.rotate(person(name), cv2.ROTATE_90_COUNTERCLOCKWISE)
    data = jpeg(sideways)
    orientation = (
        b"MM\x00\x2a\x00\x00\x00\x08\x00\x01\x01\x12\x00\x03\x00\x00\x00\x01\x00\x06\x00\x00"
    )
    exif = b"Exif\x00\x00" + orientation + b"\x00\x00\x00\x00"
    segment = b"\xff\xe1" + (len(exif) + 2).to_bytes(2, "big") + exif
    return data[:2] + segment + data[2:]
