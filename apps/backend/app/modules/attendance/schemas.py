import datetime as dt
from typing import Annotated, Any, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints

from app.modules.branches.schemas import Lat, Lng
from app.modules.schedule.models import DayKind
from app.modules.schedule.schemas import DayReason

Reason = Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=200)]
Note = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]


class Fix(BaseModel):
    """Where the phone says it is. The server re-checks it (invariant 2)."""

    model_config = ConfigDict(extra="forbid")

    lat: Lat
    lng: Lng
    accuracy_m: float = Field(ge=0, le=100_000)


class PunchForm(Fix):
    """The text fields of a punch (the selfie travels as a file next to them)."""

    # Audit only: the server's own clock decides the time (invariant 1).
    device_time: AwareDatetime | None = None
    # What the phone reports about itself: Android's mock flag, emulator, root.
    mocked: bool = False
    emulator: bool = False
    rooted: bool = False
    # Taken without a connection and sent later.
    offline: bool = False


class RequestForm(PunchForm):
    reason: Reason
    note: Note | None = None


class PlaceOut(BaseModel):
    """Where a punch was made. A home punch names no place at all (privacy)."""

    type: Literal["branch", "home", "outside", "task"]
    branch: str | None = None
    # The code of the task whose site accepted a field punch-in (FR-ATT-10).
    task: str | None = None
    distance_m: int | None = None


class PunchBrief(BaseModel):
    id: int
    type: Literal["in", "out"]
    time: dt.datetime
    review_status: Literal["verified", "pending", "approved", "rejected"]
    # In review for a reason the employee may see: never the face score.
    in_review: bool
    out_of_office: bool
    offline: bool
    place: PlaceOut


class DayOut(BaseModel):
    id: int
    date: dt.date
    status: str
    first_in_at: dt.datetime | None
    last_out_at: dt.datetime | None
    worked_minutes: int
    late_minutes: int
    overtime_minutes: int
    flags: list[str]


class PunchResult(BaseModel):
    punch: PunchBrief
    day: DayOut
    # verified: counted; in_review: stored and waiting for a person; (a refused punch is an error).
    result: Literal["verified", "in_review"]
    replayed: bool = False


class TodayOut(BaseModel):
    server_time: dt.datetime
    date: dt.date
    kind: DayKind
    reason: DayReason
    shift: str | None
    shift_start: dt.time | None
    shift_end: dt.time | None
    day: DayOut | None
    punches: list[PunchBrief]
    action: Literal["punch_in", "punch_out", "none"]
    # Why `action` is none: off_day, no_shift, face_not_approved, day_closed, request_pending, done.
    blocked: str | None
    # While punched in and not yet out.
    minutes_so_far: int | None


class PrecheckOut(BaseModel):
    allowed: bool
    # What the person can do from here: punch in, punch out, or ask for a punch-out (outside).
    action: Literal["punch_in", "punch_out", "request_punch_out", "none"]
    place: PlaceOut | None
    nearest_branch: str | None
    distance_m: int | None
    # Why not allowed: the error code and the same message a punch would get.
    code: str | None = None
    message: str | None = None
    details: Any | None = None
