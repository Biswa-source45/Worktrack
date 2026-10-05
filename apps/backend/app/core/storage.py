"""Object storage (MinIO / S3) for photos. boto3 is blocking, so every call runs in a thread."""

import datetime as dt
from typing import TYPE_CHECKING

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from starlette.concurrency import run_in_threadpool

from app.core.config import Settings

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client


class ObjectMissing(Exception):
    pass


def make_client(settings: Settings) -> "S3Client":
    return boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint_url,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
        region_name=settings.s3_region,
        config=Config(connect_timeout=2, read_timeout=2, retries={"max_attempts": 1}),
    )


async def put(s3: "S3Client", bucket: str, key: str, data: bytes) -> None:
    await run_in_threadpool(
        s3.put_object, Bucket=bucket, Key=key, Body=data, ContentType="image/jpeg"
    )


async def get(s3: "S3Client", bucket: str, key: str) -> bytes:
    try:
        response = await run_in_threadpool(s3.get_object, Bucket=bucket, Key=key)
        return await run_in_threadpool(response["Body"].read)
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") in {"NoSuchKey", "404"}:
            raise ObjectMissing(key) from error
        raise


async def list_keys(s3: "S3Client", bucket: str, prefix: str, older_than: dt.datetime) -> list[str]:
    """Keys under `prefix` last written before `older_than`."""

    def run() -> list[str]:
        keys: list[str] = []
        for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
            keys += [o["Key"] for o in page.get("Contents", []) if o["LastModified"] < older_than]
        return keys

    return await run_in_threadpool(run)


async def delete(s3: "S3Client", bucket: str, keys: list[str]) -> None:
    """Missing keys are fine (S3 deletes are idempotent). One request takes at most 1000 keys."""
    for start in range(0, len(keys), 1000):
        chunk = keys[start : start + 1000]
        await run_in_threadpool(
            s3.delete_objects,
            Bucket=bucket,
            Delete={"Objects": [{"Key": key} for key in chunk], "Quiet": True},
        )
