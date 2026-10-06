"""Working hours and day status (SRS section 6, BR-01..BR-10). Pure: no database, no clock.

`compute_day` is the single place that turns punches into a status. The service calls it after
every change to a day, so the stored status can never disagree with the punches.
"""

import datetime as dt
from dataclasses import dataclass
from decimal import Decimal

from app.core.clock import IST
from app.modules.attendance.models import (
    ABSENT,
    HALF_DAY,
    HOLIDAY,
    MISSED_PUNCH_OUT,
    PENDING,
    PRESENT,
    SHORT_HOURS,
    WEEKLY_OFF,
    WORKING,
)
from app.modules.schedule.models import DayKind
from app.modules.schedule.schemas import DayReason


@dataclass(frozen=True)
class ShiftRules:
    start: dt.time
    end: dt.time
    grace_min: int
    half_day_hours: Decimal
    full_day_hours: Decimal

    @property
    def duration_min(self) -> int:
        start = dt.datetime.combine(dt.date.min, self.start)
        return int((dt.datetime.combine(dt.date.min, self.end) - start).total_seconds() // 60)


@dataclass(frozen=True)
class DayResult:
    status: str
    worked_minutes: int
    late_minutes: int
    overtime_minutes: int


def late_minutes(shift: ShiftRules, day: dt.date, punched_in: dt.datetime) -> int:
    """BR-02: late when the punch-in is after shift start plus grace; then the lateness counts
    from the shift start itself (the grace only decides whether the mark applies)."""
    start = dt.datetime.combine(day, shift.start, tzinfo=IST)
    if punched_in <= start + dt.timedelta(minutes=shift.grace_min):
        return 0
    return int((punched_in - start).total_seconds() // 60)


def status_without_punches(kind: DayKind, reason: DayReason) -> str:
    """BR-03: a day nobody punched on is a holiday, a weekly off, or an absence."""
    if kind == "off":
        return HOLIDAY if reason == "holiday" else WEEKLY_OFF
    return ABSENT


def compute_day(
    shift: ShiftRules,
    day: dt.date,
    *,
    first_in: dt.datetime | None,
    last_out: dt.datetime | None,
    out_awaiting_approval: bool,
    closed: bool,
    override: str | None = None,
) -> DayResult:
    """Status and totals of a day from the punches that count.

    `last_out` is the counted punch-out (none while an out-of-office request is undecided or when
    the punch was rejected). `closed` means the cut-off has passed, so a missing punch-out is a
    missed one. An admin's override replaces the status; the totals stay as the punches say.
    """
    late = 0 if first_in is None else late_minutes(shift, day, first_in)
    worked = 0
    if first_in is not None and last_out is not None:
        # BR-01: whole minutes between the two times.
        worked = max(0, int((last_out - first_in).total_seconds() // 60))
    overtime = max(0, worked - shift.duration_min)  # BR-10: reported only.

    if first_in is None:
        # Only reached when the one punch-in was rejected: nothing counts yet.
        status = ABSENT
    elif last_out is not None:
        status = (
            PRESENT
            if worked >= shift.full_day_hours * 60
            else HALF_DAY
            if worked >= shift.half_day_hours * 60
            else SHORT_HOURS
        )
    elif out_awaiting_approval:
        status = PENDING
    else:
        status = MISSED_PUNCH_OUT if closed else WORKING
    return DayResult(override or status, worked, late, overtime)
