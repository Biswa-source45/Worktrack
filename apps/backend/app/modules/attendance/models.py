import datetime as dt
import uuid
from typing import Any

from geoalchemy2 import Geography, WKBElement, WKTElement
from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    ForeignKey,
    Index,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base

# Day status (BR-03 plus the states a day passes through).
WORKING = "working"
PRESENT = "present"
HALF_DAY = "half_day"
SHORT_HOURS = "short_hours"
ABSENT = "absent"
HOLIDAY = "holiday"
WEEKLY_OFF = "weekly_off"
PENDING = "pending"
MISSED_PUNCH_OUT = "missed_punch_out"
LEAVE = "leave"
WORK_FROM_HOME = "work_from_home"
ON_DUTY = "on_duty"
DAY_STATUSES = (
    WORKING, PRESENT, HALF_DAY, SHORT_HOURS, ABSENT, HOLIDAY, WEEKLY_OFF, PENDING,
    MISSED_PUNCH_OUT, LEAVE, WORK_FROM_HOME, ON_DUTY,
)  # fmt: skip
# What an admin may set by hand (FR-SET-05).
OVERRIDE_KINDS = (LEAVE, WORK_FROM_HOME, ON_DUTY)

IN = "in"
OUT = "out"

# Where a punch was accepted. "outside" only exists for out-of-office punch-out requests.
AT_BRANCH = "branch"
AT_HOME = "home"
OUTSIDE = "outside"

# review_status of a punch: verified = nothing to review, pending = waits for an admin (or, for an
# out-of-office request, for the approver), approved / rejected = the decision. Rejected does
# not count.
VERIFIED = "verified"
REVIEW_PENDING = "pending"
APPROVED = "approved"
REJECTED = "rejected"
REVIEW_STATUSES = (VERIFIED, REVIEW_PENDING, APPROVED, REJECTED)

# Why a punch waits for review.
FACE_BORDERLINE = "face_borderline"
FACE_MISMATCH = "face_mismatch"
OFFLINE = "offline"
IMPOSSIBLE_JUMP = "impossible_jump"
OUT_OF_OFFICE = "out_of_office"

# Request statuses.
REQUEST_PENDING = "pending"
REQUEST_PENDING_ADMIN = "pending_admin"
REQUEST_APPROVED = "approved"
REQUEST_REJECTED = "rejected"
REQUEST_EXPIRED = "expired"
REQUEST_STATUSES = (
    REQUEST_PENDING, REQUEST_PENDING_ADMIN, REQUEST_APPROVED, REQUEST_REJECTED, REQUEST_EXPIRED
)  # fmt: skip

EXCEPTION_KINDS = (
    "MOCK_LOCATION",
    "ROOTED_DEVICE",
    "EMULATOR",
    "OUTSIDE_GEOFENCE",
    "GPS_ACCURACY_POOR",
    "IMPOSSIBLE_JUMP",
    "FACE_MISMATCH",
)


def _in_list(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


class AttendanceDay(Base):
    """One row per employee and IST date. Status and totals are derived from the punches by
    `attendance.rules` after every change, never edited directly."""

    __tablename__ = "attendance_days"
    __table_args__ = (
        UniqueConstraint("user_id", "date", name="uq_attendance_days_user_id_date"),
        CheckConstraint(_in_list("status", DAY_STATUSES), name="status"),
        CheckConstraint(
            "worked_minutes >= 0 AND late_minutes >= 0 AND overtime_minutes >= 0", name="minutes"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    date: Mapped[dt.date]
    status: Mapped[str] = mapped_column(String(24))
    shift_id: Mapped[int | None] = mapped_column(ForeignKey("shifts.id"))
    # Branch of the first counted punch-in; NULL when it was at home or there is none.
    branch_id: Mapped[int | None] = mapped_column(ForeignKey("branches.id"))
    first_in_at: Mapped[dt.datetime | None]
    last_out_at: Mapped[dt.datetime | None]
    worked_minutes: Mapped[int] = mapped_column(default=0, server_default="0")
    late_minutes: Mapped[int] = mapped_column(default=0, server_default="0")
    overtime_minutes: Mapped[int] = mapped_column(default=0, server_default="0")
    flags: Mapped[list[str]] = mapped_column(ARRAY(String), server_default=text("'{}'"))
    created_at: Mapped[dt.datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[dt.datetime] = mapped_column(server_default=func.now(), onupdate=func.now())


Index("ix_attendance_days_date_status", AttendanceDay.date, AttendanceDay.status)
Index("ix_attendance_days_date_branch_id", AttendanceDay.date, AttendanceDay.branch_id)


class PunchEvent(Base):
    """One punch. Never edited except by a review decision, which is audited.

    `location` is personal data: it is returned only for the map of an out-of-office request,
    and never for a home punch.
    """

    __tablename__ = "punch_events"
    __table_args__ = (
        UniqueConstraint("user_id", "request_id", name="uq_punch_events_user_id_request_id"),
        CheckConstraint(_in_list("type", (IN, OUT)), name="type"),
        CheckConstraint(
            _in_list("location_type", (AT_BRANCH, AT_HOME, OUTSIDE)), name="location_type"
        ),
        CheckConstraint(_in_list("review_status", REVIEW_STATUSES), name="review_status"),
        CheckConstraint(
            _in_list("face_decision", ("VERIFIED", "PENDING_REVIEW", "MISMATCH")),
            name="face_decision",
        ),
        CheckConstraint(
            "(location_type = 'branch') = (branch_id IS NOT NULL)", name="branch_only_at_branch"
        ),
        CheckConstraint("accuracy_m >= 0", name="accuracy_m"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    attendance_day_id: Mapped[int] = mapped_column(ForeignKey("attendance_days.id"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    type: Mapped[str] = mapped_column(String(3))
    # The client's id for this punch: a retry or an offline replay with the same id is the same
    # punch.
    request_id: Mapped[uuid.UUID]
    # Authoritative (invariant 1).
    server_time: Mapped[dt.datetime] = mapped_column(server_default=func.now())
    # The time that counts: server_time, unless an admin edited it (audited).
    effective_time: Mapped[dt.datetime]
    # What the phone said; audit only.
    device_time: Mapped[dt.datetime | None]
    location: Mapped[WKBElement | WKTElement] = mapped_column(
        Geography("POINT", srid=4326, spatial_index=False)
    )
    accuracy_m: Mapped[float]
    location_type: Mapped[str] = mapped_column(String(8))
    branch_id: Mapped[int | None] = mapped_column(ForeignKey("branches.id"))
    distance_m: Mapped[float | None]
    selfie_key: Mapped[str] = mapped_column(String(255))
    face_score: Mapped[float]
    face_decision: Mapped[str] = mapped_column(String(16))
    face_model_version: Mapped[str] = mapped_column(String(64))
    thresholds_used: Mapped[dict[str, Any]] = mapped_column(JSONB)
    integrity_flags: Mapped[list[str]] = mapped_column(ARRAY(String), server_default=text("'{}'"))
    offline: Mapped[bool] = mapped_column(default=False, server_default="false")
    review_status: Mapped[str] = mapped_column(String(16))
    review_reasons: Mapped[list[str]] = mapped_column(ARRAY(String), server_default=text("'{}'"))
    reviewed_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    reviewed_at: Mapped[dt.datetime | None]
    review_remarks: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[dt.datetime] = mapped_column(server_default=func.now())


# One punch-in and one punch-out per day that counts; a rejected one frees the slot.
Index(
    "uq_punch_events_one_active_in",
    PunchEvent.attendance_day_id,
    unique=True,
    postgresql_where=text("type = 'in' AND review_status <> 'rejected'"),
)
Index(
    "uq_punch_events_one_active_out",
    PunchEvent.attendance_day_id,
    unique=True,
    postgresql_where=text("type = 'out' AND review_status <> 'rejected'"),
)
Index("ix_punch_events_review_status_id", PunchEvent.review_status, PunchEvent.id)
Index("ix_punch_events_user_id_id", PunchEvent.user_id, PunchEvent.id)


class PunchOutRequest(Base):
    """A punch-out from outside every fence. Hours count once an approver agrees."""

    __tablename__ = "punch_out_requests"
    __table_args__ = (CheckConstraint(_in_list("status", REQUEST_STATUSES), name="status"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    punch_event_id: Mapped[int] = mapped_column(ForeignKey("punch_events.id"), unique=True)
    reason: Mapped[str] = mapped_column(String(200))
    note: Mapped[str | None] = mapped_column(String(500))
    status: Mapped[str] = mapped_column(String(16))
    # Level 2: the team approver's decision, before the admin's.
    first_approver_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    first_decided_at: Mapped[dt.datetime | None]
    approver_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    approved_time: Mapped[dt.datetime | None]
    remarks: Mapped[str | None] = mapped_column(String(255))
    decided_at: Mapped[dt.datetime | None]
    expires_at: Mapped[dt.datetime]
    created_at: Mapped[dt.datetime] = mapped_column(server_default=func.now())


Index("ix_punch_out_requests_status_id", PunchOutRequest.status, PunchOutRequest.id)


class AttendanceOverride(Base):
    """An admin's manual mark (FR-SET-05). Append-only: the latest wins; punches are untouched."""

    __tablename__ = "attendance_overrides"
    __table_args__ = (CheckConstraint(_in_list("kind", OVERRIDE_KINDS), name="kind"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    attendance_day_id: Mapped[int] = mapped_column(ForeignKey("attendance_days.id"))
    kind: Mapped[str] = mapped_column(String(16))
    reason: Mapped[str] = mapped_column(String(255))
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[dt.datetime] = mapped_column(server_default=func.now())


Index(
    "ix_attendance_overrides_attendance_day_id_id",
    AttendanceOverride.attendance_day_id,
    AttendanceOverride.id,
)


class PunchException(Base):
    """A refused or suspicious attempt, for the exceptions feed. It holds no coordinates."""

    __tablename__ = "punch_exceptions"
    __table_args__ = (CheckConstraint(_in_list("kind", EXCEPTION_KINDS), name="kind"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    kind: Mapped[str] = mapped_column(String(24))
    at: Mapped[dt.datetime] = mapped_column(server_default=func.now())
    nearest_branch: Mapped[str | None] = mapped_column(String(120))
    distance_m: Mapped[float | None]
    punch_event_id: Mapped[int | None] = mapped_column(ForeignKey("punch_events.id"))
    details: Mapped[dict[str, Any] | None]


Index("ix_punch_exceptions_at_id", PunchException.at, PunchException.id)
Index("ix_punch_exceptions_user_id", PunchException.user_id)
