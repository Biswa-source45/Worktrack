import datetime as dt
from typing import Literal

from geoalchemy2 import Geography, WKBElement, WKTElement
from sqlalchemy import CheckConstraint, ForeignKey, Index, String, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.modules.branches.models import RADIUS_MAX_M, RADIUS_MIN_M

DayKind = Literal["office", "home", "off"]

HOME_PENDING = "pending"
HOME_APPROVED = "approved"
HOME_REJECTED = "rejected"
HOME_REPLACED = "replaced"
HOME_REMOVED = "removed"


class WorkSchedule(Base):
    """An employee's weekly plan from `effective_from` on. Rows are history: never edited later."""

    __tablename__ = "work_schedules"
    __table_args__ = (CheckConstraint("jsonb_array_length(days) = 7", name="seven_days"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    effective_from: Mapped[dt.date]
    # Monday first; each "office" | "home" | "off", or null to follow the shift.
    days: Mapped[list[DayKind | None]] = mapped_column(JSONB)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[dt.datetime] = mapped_column(server_default=func.now())


class HomeLocation(Base):
    """Where an employee may punch from on a work-from-home day.

    The coordinates are personal data: they leave the server only through the admin detail
    endpoints, and never appear in lists, audit rows or logs.
    """

    __tablename__ = "home_locations"
    __table_args__ = (
        CheckConstraint(f"radius_m BETWEEN {RADIUS_MIN_M} AND {RADIUS_MAX_M}", name="radius_m"),
        CheckConstraint("source IN ('admin', 'self')", name="source"),
        CheckConstraint(
            "status IN ('pending', 'approved', 'rejected', 'replaced', 'removed')", name="status"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    # Always looked up by user, so no spatial index.
    location: Mapped[WKBElement | WKTElement] = mapped_column(
        Geography("POINT", srid=4326, spatial_index=False)
    )
    radius_m: Mapped[int]
    accuracy_m: Mapped[float | None]
    source: Mapped[str] = mapped_column(String(8))
    status: Mapped[str] = mapped_column(String(16))
    # NULL: set by a script, not by a person.
    requested_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    decided_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    decided_at: Mapped[dt.datetime | None]
    reject_reason: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[dt.datetime] = mapped_column(server_default=func.now())


# Also serves every lookup by user_id.
Index(
    "uq_work_schedules_user_id_effective_from",
    WorkSchedule.user_id,
    WorkSchedule.effective_from,
    unique=True,
)
Index(
    "uq_home_locations_one_approved",
    HomeLocation.user_id,
    unique=True,
    postgresql_where=text("status = 'approved'"),
)
Index(
    "uq_home_locations_one_pending",
    HomeLocation.user_id,
    unique=True,
    postgresql_where=text("status = 'pending'"),
)
Index("ix_home_locations_user_id", HomeLocation.user_id)
