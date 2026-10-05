"""Object storage (MinIO / S3) for photos. boto3 is blocking, so every call runs in a thread."""

from typing import TYPE_CHECKING

from botocore.exceptions import ClientError
from starlette.concurrency import run_in_threadpool

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client


class ObjectMissing(Exception):
    pass


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


async def delete(s3: "S3Client", bucket: str, keys: list[str]) -> None:
    """Missing keys are fine (S3 deletes are idempotent)."""
    if keys:
        await run_in_threadpool(
            s3.delete_objects,
            Bucket=bucket,
            Delete={"Objects": [{"Key": key} for key in keys], "Quiet": True},
        )
