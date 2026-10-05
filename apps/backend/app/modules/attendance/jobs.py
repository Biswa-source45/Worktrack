"""The attendance housekeeping job (SRS FR-PO-05, FR-PO-06, BR-07). Run every few minutes by the
worker; every step is idempotent, so a late or repeated run changes nothing twice and a worker
that was down catches up on its own."""

import datetime as dt
from dataclasses import asdict, dataclass

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import IST
from app.modules.attendance import days
from app.modules.attendance.models import (
    REQUEST_EXPIRED,
    REQUEST_PENDING,
    REQUEST_PENDING_ADMIN,
    WORKING,
    AttendanceDay,
    PunchEvent,
    PunchOutRequest,
)
from app.modules.attendance.rules import status_without_punches
from app.modules.audit import service as audit
from app.modules.audit.service import AuditCtx
from app.modules.employees.models import STATUS_ACTIVE, User
from app.modules.notifications.models import Notification
from app.modules.org_settings.service import get_org_settings
from app.modules.schedule.service import resolve_days
from app.modules.shifts.models import Shift

# A worker that was down for longer than this needs a person, not a catch-up.
CATCH_UP_DAYS = 7
SYSTEM = AuditCtx(None, None)
REMINDER = "punch_out_reminder"


@dataclass
class Counts:
    expired: int = 0
    missed: int = 0
    rows: int = 0
    reminders: int = 0


async def _expire_requests(session: AsyncSession, now: dt.datetime, counts: Counts) -> None:
    """BR-07: a request nobody acted on in time stops waiting; an admin can still decide it."""
    org = await get_org_settings(session)
    due = (
        await session.execute(
            select(PunchOutRequest, PunchEvent)
            .join(PunchEvent, PunchEvent.id == PunchOutRequest.punch_event_id)
            .where(
                PunchOutRequest.status.in_((REQUEST_PENDING, REQUEST_PENDING_ADMIN)),
                PunchOutRequest.expires_at <= now,
            )
            .with_for_update(of=PunchOutRequest)
            .execution_options(populate_existing=True)
        )
    ).all()
    for request, event in due:
        before = request.status
        request.status = REQUEST_EXPIRED
        day = await session.get(AttendanceDay, event.attendance_day_id, populate_existing=True)
        if day is not None:
            await days.recompute(session, day, await days.rules_for_day(session, day), now, org)
        audit.record(
            session, SYSTEM, "punch_out_request.expire", "punch_out_request", request.id,
            before={"status": before}, after={"status": request.status, "user_id": event.user_id},
        )  # fmt: skip
        counts.expired += 1


async def _close_day(session: AsyncSession, day: dt.date, now: dt.datetime, counts: Counts) -> None:
    """Missed punch-outs for people still working, and a row for everyone else (FR-PO-05)."""
    org = await get_org_settings(session)
    open_days = (
        await session.execute(
            select(AttendanceDay)
            .where(AttendanceDay.date == day, AttendanceDay.status == WORKING)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalars()
    for row in open_days:
        await days.recompute(session, row, await days.rules_for_day(session, row), now, org)
        audit.record(
            session, SYSTEM, "attendance.missed_punch_out", "attendance_day", row.id,
            before={"status": WORKING}, after={"status": row.status, "user_id": row.user_id},
        )  # fmt: skip
        counts.missed += 1

    have = set(
        (
            await session.execute(select(AttendanceDay.user_id).where(AttendanceDay.date == day))
        ).scalars()
    )
    people = (
        await session.execute(
            select(User)
            .where(User.status == STATUS_ACTIVE, User.joined_on <= day)
            .order_by(User.id)
        )
    ).scalars()
    created = 0
    for user in people:
        if user.id in have:
            continue
        # ponytail: two queries per person per day; fine for tens of employees, batch if it grows.
        [(_, plan)] = await resolve_days(session, user, day, day)
        await session.execute(
            insert(AttendanceDay)
            .values(
                user_id=user.id,
                date=day,
                status=status_without_punches(plan.kind, plan.reason),
                shift_id=user.shift_id,
                flags=[],
            )
            .on_conflict_do_nothing(constraint="uq_attendance_days_user_id_date")
        )
        created += 1
    if created:
        audit.record(
            session, SYSTEM, "attendance.finalize", "attendance_day", day.isoformat(),
            after={"date": day.isoformat(), "rows_created": created},
        )  # fmt: skip
        counts.rows += created


async def _remind(session: AsyncSession, today: dt.date, now: dt.datetime, counts: Counts) -> None:
    """FR-PO-06: shift end plus the configured minutes, and still not punched out. One record per
    person and day (the unique key), delivered as a push in M8."""
    org = await get_org_settings(session)
    rows = (
        await session.execute(
            select(AttendanceDay.user_id, Shift.end_time)
            .join(Shift, Shift.id == AttendanceDay.shift_id)
            .where(AttendanceDay.date == today, AttendanceDay.status == WORKING)
        )
    ).all()
    for user_id, end_time in rows:
        due = dt.datetime.combine(today, end_time, IST) + dt.timedelta(
            minutes=org.punch_reminder_after_shift_end_min
        )
        if now < due:
            continue
        result = await session.execute(
            insert(Notification)
            .values(
                user_id=user_id,
                type=REMINDER,
                title="Punch out",
                body="Your shift has ended and you have not punched out yet.",
                deep_link="/attendance",
                dedupe_key=f"{REMINDER}:{user_id}:{today.isoformat()}",
            )
            .on_conflict_do_nothing(index_elements=["dedupe_key"])
        )
        counts.reminders += result.rowcount  # type: ignore[attr-defined] # 0 when already sent


async def housekeeping(session: AsyncSession, now: dt.datetime) -> dict[str, int]:
    counts = Counts()
    org = await get_org_settings(session)
    today = now.astimezone(IST).date()
    await _expire_requests(session, now, counts)
    # Never back-fill before the first day anyone has data: on the first run there is no history,
    # and marking last week absent for everyone would be wrong.
    earliest = await session.scalar(select(func.min(AttendanceDay.date)))
    first = max(today - dt.timedelta(days=CATCH_UP_DAYS), earliest or today)
    over = [first + dt.timedelta(days=n) for n in range((today - first).days)]
    # Every earlier date is over; today is over once its cut-off has passed.
    if days.is_closed(today, now, org):
        over.append(today)
    for day in over:
        await _close_day(session, day, now, counts)
    if today not in over:
        await _remind(session, today, now, counts)
    await session.commit()
    return asdict(counts)
