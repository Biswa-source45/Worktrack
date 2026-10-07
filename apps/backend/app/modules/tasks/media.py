"""Task photos and briefs. Nothing the phone or browser sends is stored as it came: a photo is
decoded and re-encoded (no EXIF, no hidden data, bounded size), a PDF is checked by its first
bytes."""

import logging
import os
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

# A small PNG or JPEG can describe a picture of billions of pixels; OpenCV refuses to decode more
# than this (same limit as the face module). Read when cv2 loads.
os.environ.setdefault("OPENCV_IO_MAX_IMAGE_PIXELS", "50000000")

import cv2
import numpy as np
from fastapi import UploadFile
from starlette.concurrency import run_in_threadpool

from app.core import storage
from app.core.errors import AppError
from app.modules.face.service import MAX_PHOTO_BYTES

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client

logger = logging.getLogger(__name__)

MAX_SIDE_PX = 1600
JPEG_QUALITY = 85
MAX_BRIEF_BYTES = 10 * 1024 * 1024
PDF = "application/pdf"
JPEG = "image/jpeg"


def reencode(data: bytes) -> bytes:
    """Decode (applying the EXIF rotation), shrink to at most 1600 px and save as a plain JPEG."""
    try:
        image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR) if data else None
    except cv2.error:
        image = None
    if image is None or image.size == 0:
        raise AppError("PHOTO_UNREADABLE", "The photo could not be read. Take it again.", 422)
    height, width = image.shape[:2]
    scale = MAX_SIDE_PX / max(height, width)
    if scale < 1:
        image = cv2.resize(
            image, (round(width * scale), round(height * scale)), interpolation=cv2.INTER_AREA
        )
    return cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])[1].tobytes()


async def read_upload(file: UploadFile, limit: int) -> bytes:
    """One byte past the limit is enough to know it is too big, without reading it all."""
    content = await file.read(limit + 1)
    if len(content) > limit:
        raise AppError(
            "PHOTO_TOO_LARGE", f"The file must be {limit // (1024 * 1024)} MB or smaller.", 413
        )
    return content


async def read_photo(file: UploadFile) -> bytes:
    """A checked, re-encoded JPEG from an uploaded photo."""
    return await run_in_threadpool(reencode, await read_upload(file, MAX_PHOTO_BYTES))


async def read_brief(file: UploadFile) -> tuple[bytes, str]:
    """A brief is a PDF (kept as is) or a photo (re-encoded). Returns the bytes and content type."""
    data = await read_upload(file, MAX_BRIEF_BYTES)
    if data.startswith(b"%PDF-"):
        return data, PDF
    return await run_in_threadpool(reencode, data), JPEG


class Uploads:
    """Files stored during one request. If the request then fails, they are deleted again."""

    def __init__(self, s3: "S3Client", bucket: str) -> None:
        self.s3 = s3
        self.bucket = bucket
        self.keys: list[str] = []

    async def put_as(self, key: str, data: bytes, content_type: str = JPEG) -> str:
        await storage.put(self.s3, self.bucket, key, data, content_type)
        self.keys.append(key)
        return key

    async def put(self, prefix: str, data: bytes, content_type: str = JPEG) -> str:
        extension = "pdf" if content_type == PDF else "jpg"
        return await self.put_as(f"{prefix}/{uuid.uuid4()}.{extension}", data, content_type)

    async def discard(self) -> None:
        try:
            await storage.delete(self.s3, self.bucket, self.keys)
        except Exception:  # best effort: the request itself already failed
            logger.exception("could not delete unused task files")


@asynccontextmanager
async def uploads(s3: "S3Client", bucket: str) -> AsyncIterator[Uploads]:
    stored = Uploads(s3, bucket)
    try:
        yield stored
    except BaseException:
        await stored.discard()
        raise
