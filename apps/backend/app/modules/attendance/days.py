"""Shared by punches, approvals, overrides and the worker: how a day is read and rewritten."""

import datetime as dt

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import IST
from app.modules.attendance.models import (
    ABSENT,
    APPROVED,
    FACE_BORDERLINE,
    FACE_MISMATCH,
    IMPOSSIBLE_JUMP,
    IN,
    OUT,
    OUT_OF_OFFICE,
    REQUEST_PENDING,
    REQUEST_PENDING_ADMIN,
    REVIEW_PENDING,
    VERIFIED,
    AttendanceDay,
    AttendanceOverride,
    PunchEvent,
    PunchOutRequest,
)
from app.modules.attendance.rules import ShiftRules, compute_day
from app.modules.org_settings.schemas import OrgSettings
from app.modules.shifts.models import Shift

FACE_REASONS = {FACE_BORDERLINE, FACE_MISMATCH}


def shift_rules(shift: Shift) -> ShiftRules:
    return ShiftRules(
        shift.start_time,
        shift.end_time,
        shift.grace_min,
        shift.half_day_hours,
        shift.full_day_hours,
    )


def counts(event: PunchEvent) -> bool:
    """Does this punch count towards hours? A rejected one never does; an out-of-office punch-out
    only once an approver has agreed; everything else counts while it waits for review."""
    if event.review_status in (VERIFIED, APPROVED):
        return True
    return event.review_status == REVIEW_PENDING and OUT_OF_OFFICE not in event.review_reasons


def cutoff_time(settings: OrgSettings) -> dt.time:
    return dt.time.fromisoformat(settings.attendance_cutoff_time)


def is_closed(day: dt.date, now: dt.datetime, settings: OrgSettings) -> bool:
    """True once the cut-off of `day` (IST) has passed: no more punches, a missing out is missed."""
    local = now.astimezone(IST)
    return local.date() > day or (local.date() == day and local.time() >= cutoff_time(settings))


async def lock_day(
    session: AsyncSession, user_id: int, day: dt.date, shift_id: int | None
) -> AttendanceDay:
    """The person's row for `day`, created if missing, locked until the transaction ends.

    Two punches of one person queue up here, so "one punch-in per day" holds under a race.
    """
    await session.execute(
        insert(AttendanceDay)
        .values(user_id=user_id, date=day, status=ABSENT, shift_id=shift_id, flags=[])
        .on_conflict_do_nothing(constraint="uq_attendance_days_user_id_date")
    )
    return (
        await session.execute(
            select(AttendanceDay)
            .where(AttendanceDay.user_id == user_id, AttendanceDay.date == day)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalar_one()


async def day_events(session: AsyncSession, day_id: int) -> list[PunchEvent]:
    return list(
        (
            await session.execute(
                select(PunchEvent)
                .where(PunchEvent.attendance_day_id == day_id)
                .order_by(PunchEvent.id)
                .execution_options(populate_existing=True)
            )
        ).scalars()
    )


async def recompute(
    session: AsyncSession,
    day: AttendanceDay,
    shift: ShiftRules,
    now: dt.datetime,
    settings: OrgSettings,
) -> AttendanceDay:
    """Rewrite the day's status and totals from its punches (and the latest manual override)."""
    events = await day_events(session, day.id)
    waiting = {
        r.punch_event_id
        for r in (
            await session.execute(
                select(PunchOutRequest).where(
                    PunchOutRequest.punch_event_id.in_([e.id for e in events]),
                    PunchOutRequest.status.in_((REQUEST_PENDING, REQUEST_PENDING_ADMIN)),
                )
            )
        ).scalars()
    }
    override = await session.scalar(
        select(AttendanceOverride.kind)
        .where(AttendanceOverride.attendance_day_id == day.id)
        .order_by(AttendanceOverride.id.desc())
        .limit(1)
    )
    counted = [e for e in events if counts(e)]
    ins = [e for e in counted if e.type == IN]
    outs = [e for e in counted if e.type == OUT]
    first_in = min(ins, key=lambda e: e.effective_time) if ins else None
    last_out = max(outs, key=lambda e: e.effective_time) if outs else None
    result = compute_day(
        shift,
        day.date,
        first_in=first_in.effective_time if first_in else None,
        last_out=last_out.effective_time if last_out else None,
        out_awaiting_approval=any(e.id in waiting for e in events if e.type == OUT),
        closed=is_closed(day.date, now, settings),
        override=override,
    )
    day.status = result.status
    day.worked_minutes = result.worked_minutes
    day.late_minutes = result.late_minutes
    day.overtime_minutes = result.overtime_minutes
    day.first_in_at = first_in.effective_time if first_in else None
    day.last_out_at = last_out.effective_time if last_out else None
    day.branch_id = first_in.branch_id if first_in else None
    day.flags = sorted(_flags(counted + [e for e in events if e.id in waiting]))
    await session.flush()
    return day


def _flags(events: list[PunchEvent]) -> set[str]:
    flags: set[str] = set()
    for e in events:
        if e.offline:
            flags.add("offline")
        if e.integrity_flags:
            flags.add("mock")
        if e.review_status == REVIEW_PENDING:
            if FACE_REASONS & set(e.review_reasons):
                flags.add("face_review")
            if IMPOSSIBLE_JUMP in e.review_reasons:
                flags.add("jump")
    return flags
