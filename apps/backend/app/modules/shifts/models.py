import datetime as dt
from decimal import Decimal
from typing import Any

from sqlalchemy import CheckConstraint, ForeignKey, Index, Numeric, String, func, true
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class Shift(Base):
    __tablename__ = "shifts"
    __table_args__ = (
        CheckConstraint("grace_min BETWEEN 0 AND 120", name="grace_min"),
        CheckConstraint(
            "half_day_hours > 0 AND half_day_hours <= full_day_hours AND full_day_hours <= 24",
            name="day_hours",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(64))
    start_time: Mapped[dt.time]
    end_time: Mapped[dt.time]
    grace_min: Mapped[int]
    half_day_hours: Mapped[Decimal] = mapped_column(Numeric(4, 2))
    full_day_hours: Mapped[Decimal] = mapped_column(Numeric(4, 2))
    # [{"weekday": 0-6 (0 = Monday), "weeks": null | [1..5]}]; null means every week.
    weekly_offs: Mapped[list[dict[str, Any]]] = mapped_column(JSONB)
    is_active: Mapped[bool] = mapped_column(default=True, server_default=true())
    created_at: Mapped[dt.datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[dt.datetime] = mapped_column(server_default=func.now(), onupdate=func.now())


class Holiday(Base):
    __tablename__ = "holidays"

    id: Mapped[int] = mapped_column(primary_key=True)
    date: Mapped[dt.date]
    name: Mapped[str] = mapped_column(String(120))
    # NULL = every branch.
    branch_id: Mapped[int | None] = mapped_column(ForeignKey("branches.id"))


Index("uq_shifts_name_lower", func.lower(Shift.name), unique=True)
# coalesce: NULLs never collide in a plain unique index, and one all-branch holiday per date is
# the rule.
Index("uq_holidays_date_branch", Holiday.date, func.coalesce(Holiday.branch_id, 0), unique=True)
