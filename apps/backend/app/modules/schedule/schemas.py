import datetime as dt
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.modules.branches.schemas import Lat, Lng, Radius
from app.modules.schedule.models import DayKind

DayReason = Literal["holiday", "schedule", "weekly_off", "shift"]
# Monday first; null follows the shift.
Days = Annotated[list[DayKind | None], Field(min_length=7, max_length=7)]


class ScheduleSet(BaseModel):
    effective_from: dt.date
    days: Days


class ScheduleRowOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    effective_from: dt.date
    days: Days
    created_at: dt.datetime


class ResolvedDay(BaseModel):
    date: dt.date
    kind: DayKind
    reason: DayReason


class ScheduleOut(BaseModel):
    rows: list[ScheduleRowOut]
    resolved: list[ResolvedDay]


# --- home work location -----------------------------------------------------------------------


class HomeSet(BaseModel):
    lat: Lat
    lng: Lng
    # Omit to use the organisation's default home radius (Settings).
    radius_m: Radius | None = None


class HomeRequestIn(BaseModel):
    lat: Lat
    lng: Lng
    accuracy_m: float = Field(ge=0)


class HomeApprove(BaseModel):
    radius_m: Radius | None = None


class HomeReject(BaseModel):
    reason: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255)]


class ApprovedHome(BaseModel):
    id: int
    lat: float
    lng: float
    radius_m: int
    source: str
    decided_at: dt.datetime | None


class PendingHome(BaseModel):
    id: int
    lat: float
    lng: float
    radius_m: int
    accuracy_m: float | None
    created_at: dt.datetime


class AdminHomeOut(BaseModel):
    approved: ApprovedHome | None
    pending: PendingHome | None


class EmployeeBrief(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    emp_code: str
    name: str


class HomeRequestItem(BaseModel):
    """A request as listed: who and when, never where."""

    id: int
    employee: EmployeeBrief
    status: str
    accuracy_m: float | None
    created_at: dt.datetime


class HomeRequestPage(BaseModel):
    items: list[HomeRequestItem]
    next_cursor: str | None


class HomeRequestDetail(HomeRequestItem):
    lat: float
    lng: float
    radius_m: int
    decided_at: dt.datetime | None
    reject_reason: str | None


class HomeRequested(BaseModel):
    status: str
    radius_m: int
    created_at: dt.datetime


class MyApprovedHome(BaseModel):
    radius_m: int
    decided_at: dt.datetime | None


class MyPendingHome(BaseModel):
    created_at: dt.datetime


class MyRejectedHome(BaseModel):
    reason: str | None
    decided_at: dt.datetime | None


class MyHomeOut(BaseModel):
    approved: MyApprovedHome | None
    pending: MyPendingHome | None
    last_rejected: MyRejectedHome | None
