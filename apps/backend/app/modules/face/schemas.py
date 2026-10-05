import datetime as dt
from typing import Annotated, Literal

from pydantic import BaseModel, StringConstraints

from app.modules.schedule.schemas import EmployeeBrief

# What the employee sees: "none" before consent. Closed attempts show why.
MyStatus = Literal["none", "consented", "pending", "approved", "rejected", "reset"]


class MyEnrollment(BaseModel):
    status: MyStatus
    consent_at: dt.datetime | None
    submitted_at: dt.datetime | None
    decided_at: dt.datetime | None
    # The admin's reason after a rejection or a reset.
    reason: str | None


class EnrollmentItem(BaseModel):
    """An enrollment as listed: who and when, never the face."""

    id: int
    employee: EmployeeBrief
    status: str
    consent_at: dt.datetime
    submitted_at: dt.datetime | None
    decided_at: dt.datetime | None


class EnrollmentPage(BaseModel):
    items: list[EnrollmentItem]
    next_cursor: str | None


class PhotoQuality(BaseModel):
    confidence: float
    face_px: int
    sharpness: float
    brightness: float


class EnrollmentDetail(EnrollmentItem):
    # Short-lived relative links (GET /files/{token}); empty once the enrollment is closed.
    photos: list[str]
    qualities: list[PhotoQuality]
    # The lowest score between any two of the three photos.
    consistency_score: float | None
    model_version: str | None
    decided_by: int | None
    reason: str | None


class Approve(BaseModel):
    # The `submitted_at` of the detail the reviewer looked at: if the employee sent new photos
    # since, the approval is refused so nobody approves photos they have not seen.
    submitted_at: dt.datetime


class Reason(BaseModel):
    reason: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255)]
