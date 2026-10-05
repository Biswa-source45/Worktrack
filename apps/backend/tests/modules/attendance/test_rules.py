"""BR-01..BR-10 as pure functions: no database."""

import datetime as dt
from decimal import Decimal

import pytest

from app.core.clock import IST
from app.modules.attendance.models import (
    ABSENT,
    HALF_DAY,
    HOLIDAY,
    LEAVE,
    MISSED_PUNCH_OUT,
    PENDING,
    PRESENT,
    SHORT_HOURS,
    WEEKLY_OFF,
    WORKING,
)
from app.modules.attendance.rules import (
    DayResult,
    ShiftRules,
    compute_day,
    late_minutes,
    status_without_punches,
)

# The seeded "General" shift: 10:00-18:00, grace 10 min, half day 4 h, full day 7 h 30 min.
GENERAL = ShiftRules(dt.time(10, 0), dt.time(18, 0), 10, Decimal("4"), Decimal("7.5"))
DAY = dt.date(2026, 10, 5)


def at(hour: int, minute: int, second: int = 0) -> dt.datetime:
    return dt.datetime(2026, 10, 5, hour, minute, second, tzinfo=IST)


def day(
    first_in: dt.datetime | None,
    last_out: dt.datetime | None = None,
    *,
    out_awaiting_approval: bool = False,
    closed: bool = False,
    override: str | None = None,
) -> DayResult:
    return compute_day(
        GENERAL,
        DAY,
        first_in=first_in,
        last_out=last_out,
        out_awaiting_approval=out_awaiting_approval,
        closed=closed,
        override=override,
    )


def test_arriving_five_minutes_after_start_and_leaving_at_the_end_is_a_full_day_and_not_late() -> (
    None
):
    # The scenario from M2 (D48): within the grace period, 7 h 55 min worked.
    result = day(at(10, 5), at(18, 0))
    assert result.status == PRESENT
    assert result.late_minutes == 0
    assert result.worked_minutes == 7 * 60 + 55


@pytest.mark.parametrize(
    ("punch_in", "expected"),
    [
        (at(9, 30), 0),
        (at(10, 0), 0),
        (at(10, 10), 0),  # exactly the end of the grace period is not late (BR-02: "after")
        (at(10, 10, 1), 10),  # one second later is; lateness counts from the shift start
        (at(10, 11), 11),
        (at(11, 30), 90),
    ],
)
def test_late_mark_and_late_minutes(punch_in: dt.datetime, expected: int) -> None:
    assert late_minutes(GENERAL, DAY, punch_in) == expected


def test_late_uses_the_ist_clock_whatever_the_zone_of_the_value() -> None:
    utc = dt.datetime(2026, 10, 5, 4, 41, tzinfo=dt.UTC)  # 10:11 IST
    assert late_minutes(GENERAL, DAY, utc) == 11


@pytest.mark.parametrize(
    ("worked_min", "expected"),
    [
        (7 * 60 + 30, PRESENT),  # exactly the full-day threshold
        (7 * 60 + 29, HALF_DAY),
        (4 * 60, HALF_DAY),  # exactly the half-day threshold
        (4 * 60 - 1, SHORT_HOURS),
        (1, SHORT_HOURS),
        (0, SHORT_HOURS),
    ],
)
def test_status_from_hours_worked(worked_min: int, expected: str) -> None:
    start = at(10, 0)
    result = day(start, start + dt.timedelta(minutes=worked_min))
    assert result.status == expected
    assert result.worked_minutes == worked_min


def test_seconds_do_not_round_up_into_a_threshold() -> None:
    assert day(at(10, 0), at(17, 29, 59)).status == HALF_DAY
    result = day(at(10, 0, 30), at(17, 30, 29))  # 7 h 29 min 59 s
    assert (result.status, result.worked_minutes) == (HALF_DAY, 7 * 60 + 29)


def test_a_punch_out_before_the_punch_in_never_counts_negative_hours() -> None:
    assert day(at(11, 0), at(10, 0)).worked_minutes == 0


def test_working_until_a_punch_out_arrives() -> None:
    assert day(at(10, 0)).status == WORKING


def test_pending_while_an_out_of_office_request_waits() -> None:
    result = day(at(10, 0), None, out_awaiting_approval=True)
    assert result.status == PENDING
    assert result.worked_minutes == 0  # hours count only after approval (FR-PO-04)


def test_a_day_closed_without_a_punch_out_is_missed_and_has_no_hours() -> None:
    result = day(at(10, 0), None, closed=True)
    assert result.status == MISSED_PUNCH_OUT
    assert result.worked_minutes == 0


def test_a_pending_request_beats_the_cut_off() -> None:
    assert day(at(10, 0), None, closed=True, out_awaiting_approval=True).status == PENDING


def test_overtime_is_the_time_beyond_the_shift_length_and_reported_only() -> None:
    assert day(at(10, 0), at(19, 15)).overtime_minutes == 75
    assert day(at(10, 0), at(18, 0)).overtime_minutes == 0
    assert day(at(10, 0), at(17, 0)).overtime_minutes == 0


def test_an_override_replaces_the_status_but_keeps_the_punch_totals() -> None:
    result = day(at(10, 0), at(12, 0), override=LEAVE)
    assert result.status == LEAVE
    assert result.worked_minutes == 120


def test_an_override_works_on_a_day_without_punches() -> None:
    assert day(None, override=LEAVE).status == LEAVE


def test_when_the_only_punch_in_was_rejected_nothing_counts() -> None:
    result = day(None)
    assert (result.status, result.worked_minutes, result.late_minutes) == (ABSENT, 0, 0)


@pytest.mark.parametrize(
    ("kind", "reason", "expected"),
    [
        ("off", "holiday", HOLIDAY),
        ("off", "weekly_off", WEEKLY_OFF),
        ("off", "schedule", WEEKLY_OFF),
        ("office", "shift", ABSENT),
        ("home", "schedule", ABSENT),
    ],
)
def test_a_day_without_punches(kind: str, reason: str, expected: str) -> None:
    assert status_without_punches(kind, reason) == expected  # type: ignore[arg-type]
