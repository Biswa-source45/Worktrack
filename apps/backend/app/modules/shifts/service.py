import datetime as dt
from collections.abc import Sequence
from typing import Any

from sqlalchemy import Row, Select, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.modules.audit import service as audit
from app.modules.audit.service import AuditCtx
from app.modules.branches.models import Branch
from app.modules.employees.service import parse_cursor
from app.modules.shifts.models import Holiday, Shift
from app.modules.shifts.schemas import (
    HolidayCreate,
    HolidayUpdate,
    ShiftCreate,
    ShiftUpdate,
    check_shift,
)


def is_weekly_off(weekly_offs: list[dict[str, Any]], day: dt.date) -> bool:
    """Whether `day` is a weekly off: its weekday is listed, for every week or for this one.

    Weeks count occurrences of the weekday in the month, so the 8th to the 14th is the 2nd.
    """
    occurrence = (day.day - 1) // 7 + 1
    return any(
        off["weekday"] == day.weekday() and (off["weeks"] is None or occurrence in off["weeks"])
        for off in weekly_offs
    )


async def _page[T: (Shift, Holiday)](
    session: AsyncSession, stmt: Select[T], model: type[T], limit: int, cursor: str | None
) -> tuple[list[T], str | None]:
    stmt = stmt.where(model.id > parse_cursor(cursor)).order_by(model.id).limit(limit + 1)
    rows = list((await session.execute(stmt)).scalars())
    if len(rows) > limit:
        return rows[:limit], str(rows[limit - 1].id)
    return rows, None


# --- shifts -------------------------------------------------------------------------------


def shift_snapshot(shift: Shift) -> dict[str, Any]:
    return {
        "name": shift.name,
        "start_time": shift.start_time.isoformat(),
        "end_time": shift.end_time.isoformat(),
        "grace_min": shift.grace_min,
        "half_day_hours": float(shift.half_day_hours),
        "full_day_hours": float(shift.full_day_hours),
        "weekly_offs": shift.weekly_offs,
        "is_active": shift.is_active,
    }


def _duplicate_shift() -> AppError:
    return AppError("DUPLICATE", "A shift with that name already exists.", 409)


async def _check_shift_name_free(session: AsyncSession, name: str, exclude: int | None) -> None:
    stmt = select(Shift.id).where(func.lower(Shift.name) == name.lower())
    if exclude is not None:
        stmt = stmt.where(Shift.id != exclude)
    if (await session.execute(stmt)).first():
        raise _duplicate_shift()


async def list_shifts(
    session: AsyncSession, limit: int, cursor: str | None
) -> tuple[list[Shift], str | None]:
    return await _page(session, select(Shift), Shift, limit, cursor)


async def active_shift_names(session: AsyncSession) -> Sequence[Row[int, str]]:
    """Id and name of the active shifts, for pickers."""
    stmt = select(Shift.id, Shift.name).where(Shift.is_active).order_by(Shift.name)
    return (await session.execute(stmt)).all()


async def create_shift(session: AsyncSession, ctx: AuditCtx, data: ShiftCreate) -> Shift:
    await _check_shift_name_free(session, data.name, None)
    shift = Shift(**data.model_dump())
    session.add(shift)
    try:
        await session.flush()
    except IntegrityError:
        raise _duplicate_shift() from None
    audit.record(session, ctx, "shift.create", "shift", shift.id, after=shift_snapshot(shift))
    await session.commit()
    await session.refresh(shift)
    return shift


async def update_shift(
    session: AsyncSession, ctx: AuditCtx, shift_id: int, data: ShiftUpdate
) -> Shift:
    shift = await session.get(Shift, shift_id)
    if shift is None:
        raise AppError("NOT_FOUND", "Shift not found.", 404)
    changes = data.model_dump(exclude_unset=True)
    before = shift_snapshot(shift)
    if "name" in changes:
        await _check_shift_name_free(session, changes["name"], shift.id)
    try:
        # A change to one time or one of the hours must still fit the values already stored.
        check_shift(
            *(
                changes.get(field, getattr(shift, field))
                for field in ("start_time", "end_time", "half_day_hours", "full_day_hours")
            )
        )
    except ValueError as exc:
        raise AppError("VALIDATION_ERROR", str(exc), 422) from None
    for field, value in changes.items():
        setattr(shift, field, value)
    try:
        await session.flush()
    except IntegrityError:
        raise _duplicate_shift() from None
    audit.record(
        session,
        ctx,
        "shift.update",
        "shift",
        shift.id,
        before=before,
        after=shift_snapshot(shift),
    )
    await session.commit()
    await session.refresh(shift)
    return shift


# --- holidays -----------------------------------------------------------------------------


def holiday_snapshot(holiday: Holiday) -> dict[str, Any]:
    return {
        "date": holiday.date.isoformat(),
        "name": holiday.name,
        "branch_id": holiday.branch_id,
    }


def _duplicate_holiday() -> AppError:
    return AppError("DUPLICATE", "There is already a holiday on that date for that branch.", 409)


async def _check_holiday(
    session: AsyncSession, date: dt.date, branch_id: int | None, exclude: int | None
) -> None:
    if branch_id is not None and await session.get(Branch, branch_id) is None:
        raise AppError("INVALID_REFERENCE", "The selected branch does not exist.", 422)
    stmt = select(Holiday.id).where(
        Holiday.date == date, func.coalesce(Holiday.branch_id, 0) == (branch_id or 0)
    )
    if exclude is not None:
        stmt = stmt.where(Holiday.id != exclude)
    if (await session.execute(stmt)).first():
        raise _duplicate_holiday()


async def _get_holiday(session: AsyncSession, holiday_id: int) -> Holiday:
    holiday = await session.get(Holiday, holiday_id)
    if holiday is None:
        raise AppError("NOT_FOUND", "Holiday not found.", 404)
    return holiday


async def list_holidays(
    session: AsyncSession, *, year: int, branch_id: int | None, limit: int, cursor: str | None
) -> tuple[list[Holiday], str | None]:
    stmt = select(Holiday).where(
        Holiday.date >= dt.date(year, 1, 1), Holiday.date < dt.date(year + 1, 1, 1)
    )
    if branch_id is not None:
        # What that branch observes: its own holidays and the ones for every branch.
        stmt = stmt.where(or_(Holiday.branch_id == branch_id, Holiday.branch_id.is_(None)))
    return await _page(session, stmt, Holiday, limit, cursor)


async def create_holiday(session: AsyncSession, ctx: AuditCtx, data: HolidayCreate) -> Holiday:
    await _check_holiday(session, data.date, data.branch_id, None)
    holiday = Holiday(**data.model_dump())
    session.add(holiday)
    try:
        await session.flush()
    except IntegrityError:
        raise _duplicate_holiday() from None
    audit.record(
        session, ctx, "holiday.create", "holiday", holiday.id, after=holiday_snapshot(holiday)
    )
    await session.commit()
    return holiday


async def update_holiday(
    session: AsyncSession, ctx: AuditCtx, holiday_id: int, data: HolidayUpdate
) -> Holiday:
    holiday = await _get_holiday(session, holiday_id)
    before = holiday_snapshot(holiday)
    changes = data.model_dump(exclude_unset=True)
    await _check_holiday(
        session,
        changes.get("date", holiday.date),
        changes.get("branch_id", holiday.branch_id),
        holiday.id,
    )
    for field, value in changes.items():
        setattr(holiday, field, value)
    try:
        await session.flush()
    except IntegrityError:
        raise _duplicate_holiday() from None
    audit.record(
        session,
        ctx,
        "holiday.update",
        "holiday",
        holiday.id,
        before=before,
        after=holiday_snapshot(holiday),
    )
    await session.commit()
    return holiday


async def delete_holiday(session: AsyncSession, ctx: AuditCtx, holiday_id: int) -> None:
    holiday = await _get_holiday(session, holiday_id)
    audit.record(
        session, ctx, "holiday.delete", "holiday", holiday.id, before=holiday_snapshot(holiday)
    )
    await session.delete(holiday)
    await session.commit()
