"""The people who run attendance: the register, manual overrides, punch-out approvals, the review
queue and the exceptions feed (SRS 4.6, 4.14, 7). Scope: an admin sees everyone, a manager the
people below them."""

import datetime as dt
from collections.abc import Sequence
from typing import Any

from geoalchemy2 import Geometry
from sqlalchemy import Float, and_, cast, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import IST, today_ist
from app.core.config import Settings
from app.core.errors import AppError
from app.core.security import create_file_token, utcnow
from app.modules.attendance import days
from app.modules.attendance.admin_schemas import (
    DayDetail,
    DayTask,
    ExceptionItem,
    ExceptionPage,
    OverrideIn,
    OverrideOut,
    OverrideResult,
    PunchDetail,
    RegisterPage,
    RegisterRow,
    RequestDecision,
    RequestDetail,
    RequestItem,
    RequestPage,
    ReviewDecision,
    ReviewDetail,
    ReviewItem,
    ReviewPage,
)
from app.modules.attendance.models import (
    APPROVED,
    AT_HOME,
    IN,
    OUT,
    OUT_OF_OFFICE,
    REJECTED,
    REQUEST_APPROVED,
    REQUEST_EXPIRED,
    REQUEST_PENDING,
    REQUEST_PENDING_ADMIN,
    REQUEST_REJECTED,
    REVIEW_PENDING,
    AttendanceDay,
    AttendanceOverride,
    PunchEvent,
    PunchException,
    PunchOutRequest,
)
from app.modules.attendance.schemas import PlaceOut
from app.modules.attendance.service import day_out
from app.modules.audit import service as audit
from app.modules.audit.service import AuditCtx
from app.modules.auth.deps import AuthContext
from app.modules.auth.permissions import ATTENDANCE_VIEW_ALL
from app.modules.branches.models import Branch
from app.modules.employees.models import Role, User
from app.modules.employees.service import (
    ensure_can_manage,
    get_employee,
    parse_cursor,
    team_ids,
)
from app.modules.files.router import file_url
from app.modules.org_settings.service import get_org_settings
from app.modules.schedule.schemas import EmployeeBrief
from app.modules.tasks.models import Task, TaskAssignee

FINAL_STATUSES = (REQUEST_APPROVED, REQUEST_REJECTED)


async def scope(session: AsyncSession, actor: AuthContext) -> set[int] | None:
    """None = everyone (admins); otherwise the ids of the people below the actor."""
    if ATTENDANCE_VIEW_ALL in actor.permissions:
        return None
    return await team_ids(session, actor.user.id)


def _brief(user: User) -> EmployeeBrief:
    return EmployeeBrief.model_validate(user)


def _signed(settings: Settings, key: str) -> str:
    return file_url(create_file_token(settings, key))


async def _branch_names(session: AsyncSession, ids: set[int | None]) -> dict[int, str]:
    wanted = {i for i in ids if i is not None}
    if not wanted:
        return {}
    rows = await session.execute(select(Branch.id, Branch.name).where(Branch.id.in_(wanted)))
    return {row.id: row.name for row in rows}


def _place(
    event: PunchEvent, names: dict[int, str], task_codes: dict[int, str] | None = None
) -> PlaceOut:
    if event.location_type == AT_HOME:
        return PlaceOut(type="home")
    branch = event.branch_id or event.nearest_branch_id
    return PlaceOut(
        type=event.location_type,
        branch=None if branch is None else names.get(branch),
        task=None if event.task_id is None or task_codes is None else task_codes.get(event.task_id),
        distance_m=None if event.distance_m is None else round(event.distance_m),
    )


async def _task_codes(session: AsyncSession, ids: set[int | None]) -> dict[int, str]:
    wanted = {i for i in ids if i is not None}
    if not wanted:
        return {}
    rows = await session.execute(select(Task.id, Task.code).where(Task.id.in_(wanted)))
    return {row.id: row.code for row in rows}


def _tz_aware(value: dt.datetime) -> dt.datetime:
    if value.tzinfo is None:
        raise AppError("INVALID_TIME", "The time must include its time zone.", 422)
    return value


# --- register ----------------------------------------------------------------------------------


async def register(
    session: AsyncSession,
    actor: AuthContext,
    *,
    day: dt.date,
    branch_id: int | None,
    status: str | None,
    q: str | None,
    limit: int,
    cursor: str | None,
) -> RegisterPage:
    """Everyone in scope for one date, with their day if they have one (one query)."""
    stmt = (
        select(User.id, User.emp_code, User.name, AttendanceDay, Branch.name.label("branch"))
        .select_from(User)
        .outerjoin(AttendanceDay, and_(AttendanceDay.user_id == User.id, AttendanceDay.date == day))
        .outerjoin(Branch, Branch.id == AttendanceDay.branch_id)
        .where(
            User.joined_on <= day,
            or_(User.status == "active", AttendanceDay.id.is_not(None)),
        )
        .order_by(User.name, User.id)
        .offset(parse_cursor(cursor))
        .limit(limit + 1)
    )
    ids = await scope(session, actor)
    if ids is not None:
        stmt = stmt.where(User.id.in_(ids))
    if branch_id is not None:
        stmt = stmt.where(AttendanceDay.branch_id == branch_id)
    if status == "no_record":
        stmt = stmt.where(AttendanceDay.id.is_(None))
    elif status:
        stmt = stmt.where(AttendanceDay.status == status)
    if q:
        escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        like = f"%{escaped}%"
        stmt = stmt.where(
            or_(User.name.ilike(like, escape="\\"), User.emp_code.ilike(like, escape="\\"))
        )
    rows = (await session.execute(stmt.execution_options(populate_existing=True))).all()
    items = [
        RegisterRow(
            employee=EmployeeBrief(id=r.id, emp_code=r.emp_code, name=r.name),
            status="no_record" if r.AttendanceDay is None else r.AttendanceDay.status,
            day_id=None if r.AttendanceDay is None else r.AttendanceDay.id,
            branch=r.branch,
            first_in_at=None if r.AttendanceDay is None else r.AttendanceDay.first_in_at,
            last_out_at=None if r.AttendanceDay is None else r.AttendanceDay.last_out_at,
            worked_minutes=0 if r.AttendanceDay is None else r.AttendanceDay.worked_minutes,
            late_minutes=0 if r.AttendanceDay is None else r.AttendanceDay.late_minutes,
            flags=[] if r.AttendanceDay is None else list(r.AttendanceDay.flags),
        )
        for r in rows[:limit]
    ]
    offset = parse_cursor(cursor)
    return RegisterPage(items=items, next_cursor=str(offset + limit) if len(rows) > limit else None)


async def _day_in_scope(session: AsyncSession, actor: AuthContext, day_id: int) -> AttendanceDay:
    day = await session.get(AttendanceDay, day_id, populate_existing=True)
    ids = await scope(session, actor)
    if day is None or (ids is not None and day.user_id not in ids):
        raise AppError("NOT_FOUND", "Attendance record not found.", 404)
    return day


async def day_detail(
    session: AsyncSession,
    actor: AuthContext,
    ctx: AuditCtx,
    settings: Settings,
    day_id: int,
) -> DayDetail:
    """One day with every punch and signed selfie links. Looking at selfies is itself audited."""
    day = await _day_in_scope(session, actor, day_id)
    user = await get_employee(session, day.user_id)
    events = await days.day_events(session, day.id)
    names = await _branch_names(session, {e.branch_id or e.nearest_branch_id for e in events})
    overrides = (
        await session.execute(
            select(AttendanceOverride)
            .where(AttendanceOverride.attendance_day_id == day.id)
            .order_by(AttendanceOverride.id)
        )
    ).scalars()
    # The person's tasks scheduled on this IST day, in one query.
    start = dt.datetime.combine(day.date, dt.time(), tzinfo=IST)
    tasks = (
        await session.execute(
            select(
                Task.id,
                Task.code,
                Task.title,
                TaskAssignee.status,
                TaskAssignee.reached_at,
                TaskAssignee.completed_at,
            )
            .join(TaskAssignee, TaskAssignee.task_id == Task.id)
            .where(
                TaskAssignee.user_id == day.user_id,
                Task.scheduled_at >= start,
                Task.scheduled_at < start + dt.timedelta(days=1),
            )
            .order_by(Task.scheduled_at, Task.id)
        )
    ).all()
    task_codes = {t.id: t.code for t in tasks}
    if events:
        audit.record(
            session,
            ctx,
            "attendance_day.view",
            "attendance_day",
            day.id,
            after={"user_id": day.user_id, "date": day.date.isoformat()},
        )
        await session.commit()
    return DayDetail(
        employee=_brief(user),
        day=day_out(day),
        punches=[
            PunchDetail(
                id=e.id,
                type=e.type,
                time=e.effective_time,
                server_time=e.server_time,
                device_time=e.device_time,
                review_status=e.review_status,
                review_reasons=list(e.review_reasons),
                face_decision=e.face_decision,
                face_score=e.face_score,
                place=_place(e, names, task_codes),
                accuracy_m=e.accuracy_m,
                offline=e.offline,
                integrity_flags=list(e.integrity_flags),
                selfie_url=_signed(settings, e.selfie_key),
                reviewed_by=e.reviewed_by,
                review_remarks=e.review_remarks,
            )
            for e in events
        ],
        overrides=[
            OverrideOut(
                kind=o.kind, reason=o.reason, created_by=o.created_by, created_at=o.created_at
            )
            for o in overrides
        ],
        tasks=[
            DayTask(
                id=t.id,
                code=t.code,
                title=t.title,
                status=t.status,
                reached_at=t.reached_at,
                completed_at=t.completed_at,
            )
            for t in tasks
        ],
    )


# --- manual override (FR-SET-05) ---------------------------------------------------------------


async def override(
    session: AsyncSession, actor: AuthContext, ctx: AuditCtx, data: OverrideIn
) -> OverrideResult:
    """Mark a day Leave, Work From Home or On Duty. The reason is mandatory; the day's punches
    stay as they are and the earlier mark stays in the list (append-only)."""
    user = await get_employee(session, data.user_id)
    ensure_can_manage(actor, user)
    if data.date > today_ist() or data.date < user.joined_on:
        raise AppError("INVALID_DATE", "Choose a date from the joining date up to today.", 422)
    day = await days.lock_day(session, user.id, data.date, user.shift_id)
    before = {"status": day.status}
    session.add(
        AttendanceOverride(
            attendance_day_id=day.id, kind=data.kind, reason=data.reason, created_by=actor.user.id
        )
    )
    await session.flush()
    now = utcnow()
    org = await get_org_settings(session)
    await days.recompute(session, day, await days.rules_for_day(session, day), now, org)
    audit.record(
        session,
        ctx,
        "attendance.override",
        "attendance_day",
        day.id,
        before=before,
        after={
            "user_id": user.id,
            "date": data.date.isoformat(),
            "status": day.status,
            "kind": data.kind,
            "reason": data.reason,
        },
    )
    await session.commit()
    return OverrideResult(employee=_brief(user), day=day_out(day))


# --- punch-out requests ------------------------------------------------------------------------


def _request_item(
    request: PunchOutRequest, event: PunchEvent, day: AttendanceDay, user: User
) -> RequestItem:
    return RequestItem(
        id=request.id,
        employee=_brief(user),
        date=day.date,
        status=request.status,
        requested_time=event.server_time,
        reason=request.reason,
        created_at=request.created_at,
        expires_at=request.expires_at,
    )


async def list_requests(
    session: AsyncSession, actor: AuthContext, *, status: str, limit: int, cursor: str | None
) -> RequestPage:
    """`waiting` is what the actor can act on: an admin sees both stages, a manager the first."""
    admin = ATTENDANCE_VIEW_ALL in actor.permissions
    waiting = (REQUEST_PENDING, REQUEST_PENDING_ADMIN) if admin else (REQUEST_PENDING,)
    wanted = waiting if status == "waiting" else (status,)
    after = parse_cursor(cursor)
    stmt = (
        select(PunchOutRequest, PunchEvent, AttendanceDay, User)
        .join(PunchEvent, PunchEvent.id == PunchOutRequest.punch_event_id)
        .join(AttendanceDay, AttendanceDay.id == PunchEvent.attendance_day_id)
        .join(User, User.id == PunchEvent.user_id)
        .where(PunchOutRequest.status.in_(wanted))
        .limit(limit + 1)
    )
    # The queue is oldest first; decided requests, newest first.
    if status == "waiting":
        stmt = stmt.where(PunchOutRequest.id > after).order_by(PunchOutRequest.id)
    else:
        if after:
            stmt = stmt.where(PunchOutRequest.id < after)
        stmt = stmt.order_by(PunchOutRequest.id.desc())
    ids = await scope(session, actor)
    if ids is not None:
        stmt = stmt.where(PunchEvent.user_id.in_(ids))
    rows = (await session.execute(stmt)).all()
    items = [_request_item(*row) for row in rows[:limit]]
    return RequestPage(items=items, next_cursor=str(items[-1].id) if len(rows) > limit else None)


async def _load_request(
    session: AsyncSession, actor: AuthContext, request_id: int, *, lock: bool
) -> tuple[PunchOutRequest, PunchEvent, AttendanceDay, User]:
    stmt = (
        select(PunchOutRequest, PunchEvent, AttendanceDay, User)
        .join(PunchEvent, PunchEvent.id == PunchOutRequest.punch_event_id)
        .join(AttendanceDay, AttendanceDay.id == PunchEvent.attendance_day_id)
        .join(User, User.id == PunchEvent.user_id)
        .where(PunchOutRequest.id == request_id)
        .execution_options(populate_existing=True)
    )
    if lock:
        stmt = stmt.with_for_update(of=(PunchOutRequest, PunchEvent, AttendanceDay))
    row = (await session.execute(stmt)).first()
    ids = await scope(session, actor)
    if row is None or (ids is not None and row[3].id not in ids):
        raise AppError("NOT_FOUND", "Request not found.", 404)
    return row[0], row[1], row[2], row[3]


def _stage(request: PunchOutRequest, actor: AuthContext, levels: int) -> tuple[bool, bool]:
    """(may this actor decide now, does a final decision need an admin)."""
    admin = ATTENDANCE_VIEW_ALL in actor.permissions
    two_levels = levels == 2
    if request.status == REQUEST_EXPIRED:
        return admin, True
    if request.status == REQUEST_PENDING_ADMIN:
        return admin, True
    if request.status == REQUEST_PENDING:
        return True, two_levels and not admin
    return False, False


async def request_detail(
    session: AsyncSession,
    actor: AuthContext,
    ctx: AuditCtx,
    settings: Settings,
    request_id: int,
) -> RequestDetail:
    request, event, day, user = await _load_request(session, actor, request_id, lock=False)
    org = await get_org_settings(session)
    names = await _branch_names(session, {event.nearest_branch_id})
    people = {
        i: await session.get(User, i)
        for i in {request.first_approver_id, request.approver_id}
        if i is not None
    }
    audit.record(
        session,
        ctx,
        "punch_out_request.view",
        "punch_out_request",
        request.id,
        after={"user_id": user.id, "date": day.date.isoformat()},
    )
    await session.commit()
    allowed, final_by_admin = _stage(request, actor, org.punch_out_approval_levels)
    first_in = await session.scalar(
        select(PunchEvent.effective_time).where(
            PunchEvent.attendance_day_id == day.id,
            PunchEvent.type == IN,
            PunchEvent.review_status != REJECTED,
        )
    )
    geometry = cast(PunchEvent.location, Geometry)
    where = (
        await session.execute(
            select(
                func.ST_Y(geometry, type_=Float).label("lat"),
                func.ST_X(geometry, type_=Float).label("lng"),
            ).where(PunchEvent.id == event.id)
        )
    ).one()
    first = people.get(request.first_approver_id or 0)
    approver = people.get(request.approver_id or 0)
    return RequestDetail(
        **_request_item(request, event, day, user).model_dump(),
        note=request.note,
        punched_in_at=first_in,
        lat=where.lat,
        lng=where.lng,
        nearest_branch=names.get(event.nearest_branch_id) if event.nearest_branch_id else None,
        distance_m=None if event.distance_m is None else round(event.distance_m),
        accuracy_m=event.accuracy_m,
        face_decision=event.face_decision,
        face_score=event.face_score,
        offline=event.offline,
        review_reasons=list(event.review_reasons),
        selfie_url=_signed(settings, event.selfie_key),
        first_approver=None if first is None else _brief(first),
        approver=None if approver is None else _brief(approver),
        approved_time=request.approved_time,
        remarks=request.remarks,
        decided_at=request.decided_at,
        can_decide=allowed and event.user_id != actor.user.id,
        final_by_admin=final_by_admin,
    )


def _check_time(
    when: dt.datetime,
    day: AttendanceDay,
    now: dt.datetime,
    *,
    kind: str,
    first_in: dt.datetime | None,
    last_out: dt.datetime | None,
) -> dt.datetime:
    """An edited time stays on the day's IST date, is not in the future, and keeps in before out."""
    when = _tz_aware(when)
    problem = None
    if when.astimezone(IST).date() != day.date:
        problem = "The time must be on the same day as the punch."
    elif when > now:
        problem = "The time cannot be in the future."
    elif kind == OUT and first_in is not None and when < first_in:
        problem = "The punch-out cannot be before the punch-in."
    elif kind == IN and last_out is not None and when > last_out:
        problem = "The punch-in cannot be after the punch-out."
    if problem:
        raise AppError("INVALID_TIME", problem, 422)
    return when


async def decide_request(
    session: AsyncSession,
    actor: AuthContext,
    ctx: AuditCtx,
    request_id: int,
    data: RequestDecision,
) -> RequestItem:
    """Approve, reject, or approve with an edited time (FR-PO-03, FR-PO-04). Hours are counted
    only now. With two approval levels a manager passes it on and an admin decides."""
    request, event, day, user = await _load_request(session, actor, request_id, lock=True)
    if event.user_id == actor.user.id:
        raise AppError("CANNOT_DECIDE_OWN", "You cannot decide your own request.", 403)
    if request.status in FINAL_STATUSES:
        raise AppError("ALREADY_DECIDED", "This request has already been decided.", 409)
    org = await get_org_settings(session)
    allowed, needs_admin = _stage(request, actor, org.punch_out_approval_levels)
    if not allowed:
        raise AppError("ADMIN_ONLY", "This request now needs an admin's decision.", 403)
    if data.decision == "reject" and not data.remarks:
        raise AppError("REMARKS_REQUIRED", "Give a reason for rejecting.", 422)
    now = utcnow()
    before = {"status": request.status, "approved_time": None}

    if data.decision == "approve" and needs_admin and ATTENDANCE_VIEW_ALL not in actor.permissions:
        # First of two levels: pass it on. No edited time here: the final approver sets it.
        if data.approved_time is not None:
            raise AppError("INVALID_TIME", "Only the final approver can edit the time.", 422)
        request.status = REQUEST_PENDING_ADMIN
        request.first_approver_id, request.first_decided_at = actor.user.id, now
        audit.record(
            session, ctx, "punch_out_request.first_approve", "punch_out_request", request.id,
            before=before, after={"status": request.status, "user_id": user.id},
        )  # fmt: skip
        await session.commit()
        return _request_item(request, event, day, user)

    request.approver_id, request.decided_at, request.remarks = actor.user.id, now, data.remarks
    event.reviewed_by, event.reviewed_at, event.review_remarks = actor.user.id, now, data.remarks
    if data.decision == "reject":
        request.status, event.review_status = REQUEST_REJECTED, REJECTED
    else:
        events = [e for e in await days.day_events(session, day.id) if e.review_status != REJECTED]
        first_in = next((e.effective_time for e in events if e.type == IN), None)
        approved = _check_time(
            data.approved_time or event.effective_time,
            day,
            now,
            kind=OUT,
            first_in=first_in,
            last_out=None,
        )
        request.status, request.approved_time = REQUEST_APPROVED, approved
        before["approved_time"] = event.effective_time.isoformat()
        event.effective_time, event.review_status = approved, APPROVED
    await session.flush()
    await days.recompute(session, day, await days.rules_for_day(session, day), now, org)
    audit.record(
        session, ctx, f"punch_out_request.{data.decision}", "punch_out_request", request.id,
        before=before,
        after={
            "status": request.status,
            "user_id": user.id,
            "approved_time": None if request.approved_time is None
            else request.approved_time.isoformat(),
            "remarks": data.remarks,
            "day_status": day.status,
        },
    )  # fmt: skip
    await session.commit()
    return _request_item(request, event, day, user)


# --- punch reviews (face borderline or mismatch, offline, jump) ---------------------------------


def _review_item(event: PunchEvent, day: AttendanceDay, user: User) -> ReviewItem:
    return ReviewItem(
        id=event.id,
        employee=_brief(user),
        date=day.date,
        type=event.type,
        time=event.effective_time,
        review_status=event.review_status,
        review_reasons=list(event.review_reasons),
        face_decision=event.face_decision,
        face_score=event.face_score,
        offline=event.offline,
    )


def _reviewable(actor: AuthContext) -> Any:
    """Only people the actor may manage (same rule as the face enrollments), decided in SQL."""
    return Role.__table__.c.permissions.contained_by(sorted(actor.permissions))


async def list_reviews(
    session: AsyncSession,
    actor: AuthContext,
    *,
    status: str,
    reason: str | None,
    limit: int,
    cursor: str | None,
) -> ReviewPage:
    after = parse_cursor(cursor)
    stmt = (
        select(PunchEvent, AttendanceDay, User)
        .join(AttendanceDay, AttendanceDay.id == PunchEvent.attendance_day_id)
        .join(User, User.id == PunchEvent.user_id)
        .join(Role, Role.id == User.role_id)
        .where(
            PunchEvent.review_status == status,
            # Out-of-office punch-outs are decided as requests, not here.
            ~PunchEvent.review_reasons.contains([OUT_OF_OFFICE]),
            _reviewable(actor),
        )
        .limit(limit + 1)
    )
    if reason:
        stmt = stmt.where(PunchEvent.review_reasons.contains([reason]))
    if status == REVIEW_PENDING:
        stmt = stmt.where(PunchEvent.id > after).order_by(PunchEvent.id)
    else:
        if after:
            stmt = stmt.where(PunchEvent.id < after)
        stmt = stmt.order_by(PunchEvent.id.desc())
    rows = (await session.execute(stmt)).all()
    items = [_review_item(*row) for row in rows[:limit]]
    return ReviewPage(items=items, next_cursor=str(items[-1].id) if len(rows) > limit else None)


async def _load_review(
    session: AsyncSession, actor: AuthContext, event_id: int, *, lock: bool
) -> tuple[PunchEvent, AttendanceDay, User]:
    stmt = (
        select(PunchEvent, AttendanceDay, User)
        .join(AttendanceDay, AttendanceDay.id == PunchEvent.attendance_day_id)
        .join(User, User.id == PunchEvent.user_id)
        .where(PunchEvent.id == event_id, ~PunchEvent.review_reasons.contains([OUT_OF_OFFICE]))
        .execution_options(populate_existing=True)
    )
    if lock:
        stmt = stmt.with_for_update(of=(PunchEvent, AttendanceDay))
    row = (await session.execute(stmt)).first()
    if row is None:
        raise AppError("NOT_FOUND", "Punch not found.", 404)
    ensure_can_manage(actor, row[2])
    return row[0], row[1], row[2]


async def review_detail(
    session: AsyncSession,
    actor: AuthContext,
    ctx: AuditCtx,
    settings: Settings,
    event_id: int,
) -> ReviewDetail:
    event, day, user = await _load_review(session, actor, event_id, lock=False)
    names = await _branch_names(session, {event.branch_id or event.nearest_branch_id})
    audit.record(
        session,
        ctx,
        "punch_event.view",
        "punch_event",
        event.id,
        after={"user_id": user.id, "date": day.date.isoformat()},
    )
    await session.commit()
    return ReviewDetail(
        **_review_item(event, day, user).model_dump(),
        server_time=event.server_time,
        device_time=event.device_time,
        place=_place(event, names, await _task_codes(session, {event.task_id})),
        accuracy_m=event.accuracy_m,
        integrity_flags=list(event.integrity_flags),
        thresholds=event.thresholds_used,
        model_version=event.face_model_version,
        selfie_url=_signed(settings, event.selfie_key),
        reviewed_by=event.reviewed_by,
        review_remarks=event.review_remarks,
        can_decide=event.review_status == REVIEW_PENDING and event.user_id != actor.user.id,
    )


async def decide_review(
    session: AsyncSession,
    actor: AuthContext,
    ctx: AuditCtx,
    event_id: int,
    data: ReviewDecision,
) -> ReviewItem:
    """Approve or reject a punch that waits for review. A rejected punch does not count."""
    event, day, user = await _load_review(session, actor, event_id, lock=True)
    if event.user_id == actor.user.id:
        raise AppError("CANNOT_DECIDE_OWN", "You cannot review your own punch.", 403)
    if event.review_status != REVIEW_PENDING:
        raise AppError("ALREADY_DECIDED", "This punch has already been decided.", 409)
    if data.decision == "reject" and not data.remarks:
        raise AppError("REMARKS_REQUIRED", "Give a reason for rejecting.", 422)
    if data.effective_time is not None and not event.offline:
        raise AppError("INVALID_TIME", "Only an offline punch can have its time changed.", 422)
    now = utcnow()
    before = {
        "review_status": event.review_status,
        "effective_time": event.effective_time.isoformat(),
    }
    if data.effective_time is not None and data.decision == "approve":
        events = [e for e in await days.day_events(session, day.id) if e.review_status != REJECTED]
        counted_in = next((e for e in events if e.type == IN and e.id != event.id), None)
        counted_out = next((e for e in events if e.type == OUT and e.id != event.id), None)
        event.effective_time = _check_time(
            data.effective_time,
            day,
            now,
            kind=event.type,
            first_in=counted_in.effective_time if counted_in else None,
            last_out=counted_out.effective_time if counted_out else None,
        )
    event.review_status = APPROVED if data.decision == "approve" else REJECTED
    event.reviewed_by, event.reviewed_at, event.review_remarks = actor.user.id, now, data.remarks
    await session.flush()
    org = await get_org_settings(session)
    await days.recompute(session, day, await days.rules_for_day(session, day), now, org)
    audit.record(
        session, ctx, f"punch_review.{data.decision}", "punch_event", event.id,
        before=before,
        after={
            "review_status": event.review_status,
            "effective_time": event.effective_time.isoformat(),
            "remarks": data.remarks,
            "user_id": user.id,
            "day_status": day.status,
        },
    )  # fmt: skip
    await session.commit()
    return _review_item(event, day, user)


# --- exceptions --------------------------------------------------------------------------------


async def list_exceptions(
    session: AsyncSession,
    *,
    kind: str | None,
    from_date: dt.date | None,
    to_date: dt.date | None,
    limit: int,
    cursor: str | None,
) -> ExceptionPage:
    """Newest first. `cursor` is the id of the last row seen."""
    stmt = (
        select(PunchException, User)
        .join(User, User.id == PunchException.user_id)
        .order_by(PunchException.id.desc())
        .limit(limit + 1)
    )
    if cursor is not None:
        stmt = stmt.where(PunchException.id < parse_cursor(cursor))
    if kind:
        stmt = stmt.where(PunchException.kind == kind)
    if from_date:
        stmt = stmt.where(PunchException.at >= dt.datetime.combine(from_date, dt.time(), IST))
    if to_date:
        stmt = stmt.where(
            PunchException.at < dt.datetime.combine(to_date + dt.timedelta(days=1), dt.time(), IST)
        )
    rows: Sequence[Any] = (await session.execute(stmt)).all()
    items = [
        ExceptionItem(
            id=e.id,
            at=e.at,
            employee=_brief(user),
            kind=e.kind,
            nearest_branch=e.nearest_branch,
            distance_m=e.distance_m,
            punch_event_id=e.punch_event_id,
            details=e.details,
        )
        for e, user in rows[:limit]
    ]
    return ExceptionPage(items=items, next_cursor=str(items[-1].id) if len(rows) > limit else None)
