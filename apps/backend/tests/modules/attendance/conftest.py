import datetime as dt
import os
from collections.abc import Callable, Iterator
from dataclasses import dataclass

import boto3
import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import IST
from app.modules.branches.models import Branch
from app.modules.employees.models import User
from app.modules.face.provider import Decision, FaceCheck
from app.modules.shifts.models import Shift
from tests.factories import ADMIN, make_branch, make_shift, role_id
from tests.modules.employees.helpers import actor
from tests.modules.face.test_enrollment import approved

MONDAY = dt.date(2027, 3, 1)
SUNDAY = dt.date(2027, 3, 7)
Headers = dict[str, str]


def ist(hour: int, minute: int, second: int = 0, day: dt.date = MONDAY) -> dt.datetime:
    return dt.datetime(day.year, day.month, day.day, hour, minute, second, tzinfo=IST).astimezone(
        dt.UTC
    )


@pytest.fixture(autouse=True)
def _remove_punch_selfies() -> Iterator[None]:
    """The database rolls back after each test; the test bucket needs the same."""
    yield
    s3 = boto3.client(
        "s3",
        endpoint_url=os.environ["S3_ENDPOINT_URL"],
        aws_access_key_id=os.environ["S3_ACCESS_KEY"],
        aws_secret_access_key=os.environ["S3_SECRET_KEY"],
        region_name=os.environ.get("S3_REGION", "us-east-1"),
    )
    listed = s3.list_objects_v2(Bucket=os.environ["S3_BUCKET"], Prefix="punch/")
    keys = [{"Key": item["Key"]} for item in listed.get("Contents", [])]
    if keys:
        s3.delete_objects(Bucket=os.environ["S3_BUCKET"], Delete={"Objects": keys})
    for prefix in ("face/",):
        listed = s3.list_objects_v2(Bucket=os.environ["S3_BUCKET"], Prefix=prefix)
        keys = [{"Key": item["Key"]} for item in listed.get("Contents", [])]
        if keys:
            s3.delete_objects(Bucket=os.environ["S3_BUCKET"], Delete={"Objects": keys})


class Clock:
    """The server's clock, set by the test. Defaults to Monday 10:05 IST."""

    def __init__(self) -> None:
        self.now = ist(10, 5)

    def at(self, hour: int, minute: int, second: int = 0, day: dt.date = MONDAY) -> None:
        self.now = ist(hour, minute, second, day)


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Clock:
    clock = Clock()
    for name in ("service", "admin"):
        monkeypatch.setattr(f"app.modules.attendance.{name}.utcnow", lambda: clock.now)
    for name in ("history", "admin", "admin_router"):
        monkeypatch.setattr(
            f"app.modules.attendance.{name}.today_ist", lambda: clock.now.astimezone(IST).date()
        )
    return clock


@pytest.fixture
def force_face(monkeypatch: pytest.MonkeyPatch) -> Callable[[Decision, float], None]:
    """Make the face check answer with a given decision (the photo is still really checked)."""
    from app.modules.face import service as face_service

    real = face_service.get_provider()

    class Forced:
        model_version = real.model_version

        def __init__(self, decision: Decision, score: float) -> None:
            self.decision, self.score = decision, score

        def enroll(self, *args, **kwargs):  # type: ignore[no-untyped-def]
            return real.enroll(*args, **kwargs)

        def verify(self, *args, **kwargs):  # type: ignore[no-untyped-def]
            check = real.verify(*args, **kwargs)
            if check.decision == Decision.RETAKE:
                return check
            return FaceCheck(
                self.decision, self.score, None, check.model_version, check.thresholds, check.jpeg
            )

    def force(decision: Decision, score: float = 0.35) -> None:
        monkeypatch.setattr(face_service, "get_provider", lambda: Forced(decision, score))

    return force


@dataclass
class Scene:
    user: User
    headers: Headers
    admin: Headers
    branch: Branch
    shift: Shift


@pytest.fixture
async def scene(client: httpx.AsyncClient, db: AsyncSession, clock: Clock) -> Scene:
    """An employee on the General shift (10:00-18:00, grace 10, half 4 h, full 7 h 30) with an
    approved phone and face, and an active branch."""
    shift = await make_shift(
        db,
        "General",
        start_time=dt.time(10, 0),
        end_time=dt.time(18, 0),
        full_day_hours=7.5,
        weekly_offs=[{"weekday": 6, "weeks": None}],
    )
    branch = await make_branch(db, "Head Office")
    user, headers, _, _ = await approved(client, db, 1, "a")
    user.shift_id = shift.id
    await db.flush()
    await db.refresh(user)
    _, admin = await actor(client, db, ADMIN)
    return Scene(user, headers, admin, branch, shift)


async def employee(
    client: httpx.AsyncClient,
    db: AsyncSession,
    scene: Scene,
    n: int,
    person: str = "b",
    *,
    role: str | None = None,
    manager: User | None = None,
) -> tuple[User, Headers]:
    """Another employee on the same shift with an approved phone (device n) and face (person)."""
    user, headers, _, _ = await approved(client, db, n, person)
    user.shift_id = scene.shift.id
    if manager is not None:
        user.manager_id = manager.id
    if role is not None:
        user.role_id = await role_id(db, role)
    await db.flush()
    await db.refresh(user)
    return user, headers
