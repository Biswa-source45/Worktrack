import os
from collections.abc import Iterator

import boto3
import pytest

from app.core.clock import IST
from tests.modules.attendance.conftest import (  # noqa: F401 (fixtures used by the task tests)
    Clock,
    _remove_punch_selfies,
    force_face,
    scene,
)


@pytest.fixture(autouse=True)
def _remove_task_files() -> Iterator[None]:
    """The database rolls back after each test; the test bucket needs the same."""
    yield
    s3 = boto3.client(
        "s3",
        endpoint_url=os.environ["S3_ENDPOINT_URL"],
        aws_access_key_id=os.environ["S3_ACCESS_KEY"],
        aws_secret_access_key=os.environ["S3_SECRET_KEY"],
        region_name=os.environ.get("S3_REGION", "us-east-1"),
    )
    listed = s3.list_objects_v2(Bucket=os.environ["S3_BUCKET"], Prefix="task/")
    keys = [{"Key": item["Key"]} for item in listed.get("Contents", [])]
    if keys:
        s3.delete_objects(Bucket=os.environ["S3_BUCKET"], Delete={"Objects": keys})


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Clock:
    """The server clock for the attendance and task modules (Monday 10:05 IST unless set)."""
    clock = Clock()
    for name in ("attendance.service", "attendance.admin", "tasks.service", "tasks.actions",
                 "tasks.views", "tasks.reach"):  # fmt: skip
        monkeypatch.setattr(f"app.modules.{name}.utcnow", lambda: clock.now, raising=False)
    for name in ("history", "admin", "admin_router"):
        monkeypatch.setattr(
            f"app.modules.attendance.{name}.today_ist", lambda: clock.now.astimezone(IST).date()
        )
    return clock
