import datetime as dt
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import today_ist
from app.core.errors import AppError
from app.modules.audit import service as audit
from app.modules.audit.service import AuditCtx
from app.modules.employees.models import User
from app.modules.schedule.models import DayKind, WorkSchedule
from app.modules.schedule.schemas import DayReason, ScheduleSet
from app.modules.shifts.models import Holiday
from app.modules.shifts.service import is_weekly_off

MAX_RANGE_DAYS = 62
DEFAULT_RANGE_DAYS = 14


@dataclass(frozen=True)
class DayPlan:
    kind: DayKind
    reason: DayReason


def plan_day(
    day: dt.date,
    *,
    holidays: set[dt.date],
    schedules: Sequence[tuple[dt.date, Sequence[DayKind | None]]],
    weekly_offs: list[dict[str, Any]],
) -> DayPlan:
    """What one day is for an employee. Pure: everything it needs is passed in.

    `holidays` are the dates that apply to the employee; `schedules` are (effective_from, days),
    newest first.
    """
    # M7: an approved request for this very date (leave, work from home) is checked here, first.
    if day in holidays:
        return DayPlan("off", "holiday")
    current = next((days for effective_from, days in schedules if effective_from <= day), None)
    if current is not None:
        kind = current[day.weekday()]
        if kind is not None:
            return DayPlan(kind, "schedule")
    if is_weekly_off(weekly_offs, day):
        return DayPlan("off", "weekly_off")
    return DayPlan("office", "shift")


async def schedule_rows(
    session: AsyncSession, user_id: int, until: dt.date | None = None
) -> list[WorkSchedule]:
    """The employee's schedule rows, newest first (optionally only those in force by `until`)."""
    stmt = select(WorkSchedule).where(WorkSchedule.user_id == user_id)
    if until is not None:
        stmt = stmt.where(WorkSchedule.effective_from <= until)
    return list(
        (await session.execute(stmt.order_by(WorkSchedule.effective_from.desc()))).scalars()
    )


async def resolve_days(
    session: AsyncSession, user: User, start: dt.date, end: dt.date
) -> list[tuple[dt.date, DayPlan]]:
    """The plan for every day from `start` to `end`, in two queries however long the range."""
    rows = await schedule_rows(session, user.id, end)
    holidays = set(
        (
            await session.execute(
                select(Holiday.date).where(
                    Holiday.date >= start,
                    Holiday.date <= end,
                    # user.home_branch_id may be NULL; then only all-branch holidays match.
                    or_(Holiday.branch_id.is_(None), Holiday.branch_id == user.home_branch_id),
                )
            )
        ).scalars()
    )
    schedules = [(row.effective_from, row.days) for row in rows]
    weekly_offs = user.shift.weekly_offs if user.shift is not None else []
    days = (start + dt.timedelta(days=n) for n in range((end - start).days + 1))
    return [
        (day, plan_day(day, holidays=holidays, schedules=schedules, weekly_offs=weekly_offs))
        for day in days
    ]


async def resolve_day(session: AsyncSession, user: User, day: dt.date) -> DayPlan:
    [(_, plan)] = await resolve_days(session, user, day, day)
    return plan


def check_range(start: dt.date | None, end: dt.date | None) -> tuple[dt.date, dt.date]:
    """The requested range, or the next two weeks. At most MAX_RANGE_DAYS days."""
    start = start or today_ist()
    end = end or start + dt.timedelta(days=DEFAULT_RANGE_DAYS - 1)
    if end < start or (end - start).days >= MAX_RANGE_DAYS:
        raise AppError(
            "VALIDATION_ERROR",
            f"Choose a range of 1 to {MAX_RANGE_DAYS} days, with 'to' on or after 'from'.",
            422,
        )
    return start, end


async def set_schedule(
    session: AsyncSession, ctx: AuditCtx, user: User, data: ScheduleSet
) -> WorkSchedule:
    """Set the weekly plan from a date on. Earlier rows are history and are never touched."""
    if data.effective_from < today_ist():
        raise AppError(
            "SCHEDULE_BACKDATED", "A schedule cannot start in the past. Choose today or later.", 422
        )
    row = await session.scalar(
        select(WorkSchedule).where(
            WorkSchedule.user_id == user.id, WorkSchedule.effective_from == data.effective_from
        )
    )
    after = {
        "user_id": user.id,
        "effective_from": data.effective_from.isoformat(),
        "days": list(data.days),
    }
    before = None
    if row is None:
        row = WorkSchedule(user_id=user.id, effective_from=data.effective_from)
        session.add(row)
    else:
        before = {**after, "days": row.days}
    row.days = list(data.days)
    row.created_by = ctx.actor_id
    await session.flush()
    audit.record(session, ctx, "schedule.set", "work_schedule", row.id, before=before, after=after)
    await session.commit()
    return row
