import os
from collections.abc import Iterator

import boto3
import pytest


@pytest.fixture(autouse=True)
def _remove_stored_photos() -> Iterator[None]:
    """The database rolls back after each test; the test bucket needs the same."""
    yield
    s3 = boto3.client(
        "s3",
        endpoint_url=os.environ["S3_ENDPOINT_URL"],
        aws_access_key_id=os.environ["S3_ACCESS_KEY"],
        aws_secret_access_key=os.environ["S3_SECRET_KEY"],
        region_name=os.environ.get("S3_REGION", "us-east-1"),
    )
    listed = s3.list_objects_v2(Bucket=os.environ["S3_BUCKET"], Prefix="face/")
    keys = [{"Key": item["Key"]} for item in listed.get("Contents", [])]
    if keys:
        s3.delete_objects(Bucket=os.environ["S3_BUCKET"], Delete={"Objects": keys})
