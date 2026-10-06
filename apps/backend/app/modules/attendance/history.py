"""The employee's own month (SRS 11: GET /attendance/me?month=)."""

import calendar
import datetime as dt

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import today_ist
from app.modules.attendance.admin_schemas import MonthDay, MonthOut, MonthSummary
from app.modules.attendance.models import (
    ABSENT,
    HALF_DAY,
    MISSED_PUNCH_OUT,
    PRESENT,
    SHORT_HOURS,
    AttendanceDay,
)
from app.modules.attendance.rules import status_without_punches
from app.modules.employees.models import User
from app.modules.schedule.service import resolve_days

COUNTED = (PRESENT, HALF_DAY, SHORT_HOURS, ABSENT, MISSED_PUNCH_OUT)


async def my_month(session: AsyncSession, user: User, month: str) -> MonthOut:
    """Every day of the month with its plan and outcome, in three queries.

    A past day nobody punched on is derived from the plan (absent, holiday, weekly off) even if
    the nightly job has not written its row yet; today and later have no outcome until a punch.
    """
    year, number = (int(part) for part in month.split("-"))
    first = dt.date(year, number, 1)
    last = first.replace(day=calendar.monthrange(year, number)[1])
    today = today_ist()
    plans = await resolve_days(session, user, first, last)
    rows = {
        row.date: row
        for row in (
            await session.execute(
                select(AttendanceDay)
                .where(
                    AttendanceDay.user_id == user.id,
                    AttendanceDay.date >= first,
                    AttendanceDay.date <= last,
                )
                .execution_options(populate_existing=True)
            )
        ).scalars()
    }
    out: list[MonthDay] = []
    for day, plan in plans:
        row = rows.get(day)
        if row is not None:
            status: str | None = row.status
        elif user.joined_on <= day < today:
            status = status_without_punches(plan.kind, plan.reason)
        else:
            status = None
        out.append(
            MonthDay(
                date=day,
                kind=plan.kind,
                reason=plan.reason,
                status=status,
                first_in_at=None if row is None else row.first_in_at,
                last_out_at=None if row is None else row.last_out_at,
                worked_minutes=0 if row is None else row.worked_minutes,
                late_minutes=0 if row is None else row.late_minutes,
                flags=[] if row is None else list(row.flags),
            )
        )
    count = {key: sum(1 for d in out if d.status == key) for key in COUNTED}
    return MonthOut(
        month=month,
        today=today,
        days=out,
        summary=MonthSummary(
            present=count[PRESENT],
            half_day=count[HALF_DAY],
            short_hours=count[SHORT_HOURS],
            absent=count[ABSENT],
            late=sum(1 for d in out if d.late_minutes > 0),
            missed_punch_out=count[MISSED_PUNCH_OUT],
            worked_minutes=sum(d.worked_minutes for d in out),
        ),
    )
