"""What the approvers, reviewers and admins see. Face scores and selfie links appear only here."""

import datetime as dt
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, StringConstraints

from app.modules.attendance.schemas import DayOut, PlaceOut
from app.modules.schedule.schemas import EmployeeBrief

Remarks = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255)]
OverrideReason = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=5, max_length=255)
]
OverrideKind = Literal["leave", "work_from_home", "on_duty"]

# --- register ----------------------------------------------------------------------------------


class RegisterRow(BaseModel):
    employee: EmployeeBrief
    # "no_record" when nobody has punched and the day has not been closed.
    status: str
    day_id: int | None
    branch: str | None
    first_in_at: dt.datetime | None
    last_out_at: dt.datetime | None
    worked_minutes: int
    late_minutes: int
    flags: list[str]


class RegisterPage(BaseModel):
    items: list[RegisterRow]
    next_cursor: str | None


class PunchDetail(BaseModel):
    id: int
    type: Literal["in", "out"]
    time: dt.datetime
    server_time: dt.datetime
    device_time: dt.datetime | None
    review_status: str
    review_reasons: list[str]
    face_decision: str
    face_score: float
    place: PlaceOut
    accuracy_m: float
    offline: bool
    integrity_flags: list[str]
    # A short-lived signed link (relative: each client adds its own base).
    selfie_url: str
    reviewed_by: int | None
    review_remarks: str | None


class OverrideOut(BaseModel):
    kind: str
    reason: str
    created_by: int
    created_at: dt.datetime


class DayTask(BaseModel):
    """A task the person had for this day (scheduled on it), with their own status on it."""

    id: int
    code: str
    title: str
    status: str
    reached_at: dt.datetime | None
    completed_at: dt.datetime | None


class DayDetail(BaseModel):
    employee: EmployeeBrief
    day: DayOut
    punches: list[PunchDetail]
    overrides: list[OverrideOut]
    tasks: list[DayTask]


class OverrideIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: int
    date: dt.date
    kind: OverrideKind
    reason: OverrideReason


class OverrideResult(BaseModel):
    employee: EmployeeBrief
    day: DayOut


# --- punch-out requests ------------------------------------------------------------------------


class RequestItem(BaseModel):
    id: int
    employee: EmployeeBrief
    date: dt.date
    status: str
    requested_time: dt.datetime
    reason: str
    created_at: dt.datetime
    expires_at: dt.datetime


class RequestPage(BaseModel):
    items: list[RequestItem]
    next_cursor: str | None


class RequestDetail(RequestItem):
    note: str | None
    punched_in_at: dt.datetime | None
    # The one place coordinates leave the server: where the request was made (FR-PO-03).
    lat: float
    lng: float
    nearest_branch: str | None
    distance_m: int | None
    accuracy_m: float
    face_decision: str
    face_score: float
    offline: bool
    review_reasons: list[str]
    selfie_url: str
    first_approver: EmployeeBrief | None
    approver: EmployeeBrief | None
    approved_time: dt.datetime | None
    remarks: str | None
    decided_at: dt.datetime | None
    # Whether the viewer may decide it right now (scope, stage, not their own).
    can_decide: bool
    # Level 2: a team approver may only pass it on; only an admin decides finally.
    final_by_admin: bool


class RequestDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision: Literal["approve", "reject"]
    # Approve with an edited time. Omit to accept the time the employee asked for.
    approved_time: dt.datetime | None = None
    remarks: Remarks | None = None


# --- punch reviews -----------------------------------------------------------------------------


class ReviewItem(BaseModel):
    id: int
    employee: EmployeeBrief
    date: dt.date
    type: Literal["in", "out"]
    time: dt.datetime
    review_status: str
    review_reasons: list[str]
    face_decision: str
    face_score: float
    offline: bool


class ReviewPage(BaseModel):
    items: list[ReviewItem]
    next_cursor: str | None


class ReviewDetail(ReviewItem):
    server_time: dt.datetime
    device_time: dt.datetime | None
    place: PlaceOut
    accuracy_m: float
    integrity_flags: list[str]
    thresholds: dict[str, Any]
    model_version: str
    selfie_url: str
    reviewed_by: int | None
    review_remarks: str | None
    can_decide: bool


class ReviewDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision: Literal["approve", "reject"]
    # Mandatory for a rejection, optional note for an approval.
    remarks: Remarks | None = None
    # Only for an offline punch: the time the admin accepts instead of the receipt time.
    effective_time: dt.datetime | None = None


# --- exceptions --------------------------------------------------------------------------------


class ExceptionItem(BaseModel):
    id: int
    at: dt.datetime
    employee: EmployeeBrief
    kind: str
    nearest_branch: str | None
    distance_m: float | None
    punch_event_id: int | None
    details: dict[str, Any] | None


class ExceptionPage(BaseModel):
    items: list[ExceptionItem]
    next_cursor: str | None


# --- the employee's own month ------------------------------------------------------------------


class MonthDay(BaseModel):
    date: dt.date
    kind: Literal["office", "home", "off"]
    reason: str
    # None for a day that has no outcome yet (today before punching, the future, before joining).
    status: str | None
    first_in_at: dt.datetime | None
    last_out_at: dt.datetime | None
    worked_minutes: int
    late_minutes: int
    flags: list[str]


class MonthSummary(BaseModel):
    present: int
    half_day: int
    short_hours: int
    absent: int
    late: int
    missed_punch_out: int
    worked_minutes: int


class MonthOut(BaseModel):
    month: str
    today: dt.date
    days: list[MonthDay]
    summary: MonthSummary
