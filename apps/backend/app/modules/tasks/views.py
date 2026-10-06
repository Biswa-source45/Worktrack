"""Reading tasks: lists, the detail page, the employee's own tasks and the assignment candidates.

Every list scopes in SQL (never by filtering rows afterwards) and loads its people and assignees
for the whole page in one query each, so a page costs a fixed number of queries.
"""

import datetime as dt
from collections import defaultdict
from collections.abc import Iterable, Sequence
from typing import Literal

from sqlalchemy import Float, and_, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import IST
from app.core.config import Settings
from app.core.errors import AppError
from app.core.security import create_file_token, utcnow
from app.modules.attendance.models import AttendanceDay
from app.modules.auth.deps import AuthContext
from app.modules.auth.permissions import (
    FACE_REVIEW,
    TASKS_CREATE,
    TASKS_VIEW_ALL,
    TEAM_VIEW,
)
from app.modules.employees.models import STATUS_ACTIVE, User
from app.modules.employees.service import parse_cursor, team_ids
from app.modules.files.router import file_url
from app.modules.shifts.models import Holiday
from app.modules.shifts.service import is_weekly_off
from app.modules.tasks import lifecycle as lc
from app.modules.tasks.models import (
    Task,
    TaskAssignee,
    TaskAttachment,
    TaskComment,
    TaskEvent,
    TaskType,
)
from app.modules.tasks.schemas import (
    AssigneeBrief,
    AssigneeOut,
    AttachmentOut,
    Candidate,
    CandidatePage,
    CandidateStatus,
    CommentOut,
    EventOut,
    Metrics,
    MyAssignment,
    MyTask,
    MyTaskPage,
    ReachOut,
    SiteOut,
    TaskBrief,
    TaskDetail,
    TaskPage,
    TaskTypeOut,
    UserBrief,
)

View = Literal["assigned_by_me", "team", "all"]
MY_ACTIVE = (lc.ASSIGNED, lc.ACCEPTED, lc.REACHED, lc.IN_PROGRESS, lc.ON_HOLD)


def not_found() -> AppError:
    return AppError("TASK_NOT_FOUND", "This task does not exist or is not visible to you.", 404)


def can_manage(actor: AuthContext, task: Task) -> bool:
    """Everything on a task: for `tasks.view_all`, or its creator holding `tasks.create`."""
    return TASKS_VIEW_ALL in actor.permissions or (
        task.created_by == actor.user.id and TASKS_CREATE in actor.permissions
    )


async def visible_task(session: AsyncSession, actor: AuthContext, task_id: int) -> Task:
    """The task, or 404 when it is out of the actor's scope (so ids reveal nothing)."""
    stmt = select(Task).where(Task.id == task_id).execution_options(populate_existing=True)
    if TASKS_VIEW_ALL not in actor.permissions:
        mine = [
            Task.created_by == actor.user.id,
            exists().where(TaskAssignee.task_id == Task.id, TaskAssignee.user_id == actor.user.id),
        ]
        if TEAM_VIEW in actor.permissions and (team := await team_ids(session, actor.user.id)):
            mine.append(
                exists().where(TaskAssignee.task_id == Task.id, TaskAssignee.user_id.in_(team))
            )
        stmt = stmt.where(or_(*mine))
    task = await session.scalar(stmt)
    if task is None:
        raise not_found()
    return task


# --- small builders ----------------------------------------------------------------------------


def _type_out(row: TaskType) -> TaskTypeOut:
    return TaskTypeOut.model_validate(row, from_attributes=True)


def _site(task: Task) -> SiteOut:
    return SiteOut(
        address=task.site_address,
        lat=task.site_lat,
        lng=task.site_lng,
        radius_m=task.site_radius_m,
    )


async def _people(session: AsyncSession, ids: Iterable[int | None]) -> dict[int, UserBrief]:
    wanted = {i for i in ids if i is not None}
    if not wanted:
        return {}
    rows = await session.execute(
        select(User.id, User.name, User.emp_code).where(User.id.in_(wanted))
    )
    return {r.id: UserBrief(id=r.id, name=r.name, emp_code=r.emp_code) for r in rows}


def _minutes(start: dt.datetime | None, end: dt.datetime | None) -> int | None:
    if start is None or end is None:
        return None
    return max(int((end - start).total_seconds() // 60), 0)


# --- lists -------------------------------------------------------------------------------------


def _ist_midnight(day: dt.date) -> dt.datetime:
    return dt.datetime.combine(day, dt.time(), tzinfo=IST)


async def list_tasks(
    session: AsyncSession,
    actor: AuthContext,
    *,
    view: View | None,
    statuses: Sequence[str],
    assignee_id: int | None,
    date_from: dt.date | None,
    date_to: dt.date | None,
    type_id: int | None,
    q: str | None,
    limit: int,
    cursor: str | None,
) -> TaskPage:
    perms = actor.permissions
    if view is None:
        view = (
            "all"
            if TASKS_VIEW_ALL in perms
            else "assigned_by_me"
            if TASKS_CREATE in perms
            else "team"
        )
    stmt = select(Task, TaskType).join(TaskType, TaskType.id == Task.type_id)
    if view == "all":
        if TASKS_VIEW_ALL not in perms:
            raise AppError("FORBIDDEN", "You do not have permission to do this.", 403)
    elif view == "assigned_by_me":
        if TASKS_CREATE not in perms:
            raise AppError("FORBIDDEN", "You do not have permission to do this.", 403)
        stmt = stmt.where(Task.created_by == actor.user.id)
    else:
        if TEAM_VIEW not in perms:
            raise AppError("FORBIDDEN", "You do not have permission to do this.", 403)
        team = await team_ids(session, actor.user.id)
        stmt = stmt.where(
            exists().where(TaskAssignee.task_id == Task.id, TaskAssignee.user_id.in_(team))
        )
    if statuses:
        stmt = stmt.where(Task.status.in_(statuses))
    if assignee_id is not None:
        stmt = stmt.where(
            exists().where(TaskAssignee.task_id == Task.id, TaskAssignee.user_id == assignee_id)
        )
    if date_from is not None:
        stmt = stmt.where(Task.scheduled_at >= _ist_midnight(date_from))
    if date_to is not None:
        stmt = stmt.where(Task.scheduled_at < _ist_midnight(date_to + dt.timedelta(days=1)))
    if type_id is not None:
        stmt = stmt.where(Task.type_id == type_id)
    if q:
        escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        like = f"%{escaped}%"
        stmt = stmt.where(
            or_(
                Task.client_name.ilike(like, escape="\\"),
                Task.title.ilike(like, escape="\\"),
                Task.code.ilike(like, escape="\\"),
            )
        )
    if cursor is not None:
        stmt = stmt.where(Task.id < parse_cursor(cursor))
    rows = (
        await session.execute(
            stmt.order_by(Task.id.desc()).limit(limit + 1).execution_options(populate_existing=True)
        )
    ).all()
    page = rows[:limit]
    briefs = await _briefs(session, [(r.Task, r.TaskType) for r in page])
    return TaskPage(
        items=briefs, next_cursor=str(page[-1].Task.id) if len(rows) > limit and page else None
    )


async def _briefs(session: AsyncSession, pairs: Sequence[tuple[Task, TaskType]]) -> list[TaskBrief]:
    if not pairs:
        return []
    ids = [task.id for task, _ in pairs]
    assignees = defaultdict(list)
    for a in (
        await session.execute(
            select(TaskAssignee).where(TaskAssignee.task_id.in_(ids)).order_by(TaskAssignee.id)
        )
    ).scalars():
        assignees[a.task_id].append(a)
    people = await _people(
        session,
        [task.created_by for task, _ in pairs]
        + [a.user_id for rows in assignees.values() for a in rows],
    )
    return [
        TaskBrief(
            id=task.id,
            code=task.code,
            title=task.title,
            type=_type_out(kind),
            client_name=task.client_name,
            site=_site(task),
            priority=task.priority,
            scheduled_at=task.scheduled_at,
            status=task.status,
            created_by=people[task.created_by],
            assignees=[
                AssigneeBrief(
                    user=people[a.user_id],
                    status=a.status,
                    escalated=a.escalated_at is not None,
                    reach_review=a.reach_review,
                )
                for a in assignees[task.id]
            ],
        )
        for task, kind in pairs
    ]


async def my_tasks(
    session: AsyncSession,
    user: User,
    *,
    state: Literal["active", "done"],
    limit: int,
    cursor: str | None,
) -> MyTaskPage:
    stmt = (
        select(TaskAssignee, Task, TaskType)
        .join(Task, Task.id == TaskAssignee.task_id)
        .join(TaskType, TaskType.id == Task.type_id)
        .where(TaskAssignee.user_id == user.id)
    )
    in_active = TaskAssignee.status.in_(MY_ACTIVE)
    stmt = stmt.where(in_active if state == "active" else ~in_active)
    if cursor is not None:
        stmt = stmt.where(TaskAssignee.id < parse_cursor(cursor))
    rows = (
        await session.execute(
            stmt.order_by(TaskAssignee.id.desc())
            .limit(limit + 1)
            .execution_options(populate_existing=True)
        )
    ).all()
    page = rows[:limit]
    people = await _people(session, [r.Task.created_by for r in page])
    items = [
        MyTask(
            id=r.Task.id,
            code=r.Task.code,
            title=r.Task.title,
            type=_type_out(r.TaskType),
            client_name=r.Task.client_name,
            site=_site(r.Task),
            contact_name=r.Task.contact_name,
            contact_phone=r.Task.contact_phone,
            priority=r.Task.priority,
            scheduled_at=r.Task.scheduled_at,
            expected_minutes=r.Task.expected_minutes,
            description=r.Task.description,
            status=r.Task.status,
            created_by=people[r.Task.created_by],
            my=MyAssignment(
                status=r.TaskAssignee.status,
                assigned_at=r.TaskAssignee.assigned_at,
                accepted_at=r.TaskAssignee.accepted_at,
                started_at=r.TaskAssignee.started_at,
                completed_at=r.TaskAssignee.completed_at,
                reached_at=r.TaskAssignee.reached_at,
                declined_reason=r.TaskAssignee.declined_reason,
                reach_flags=r.TaskAssignee.reach_flags,
                reach_review=r.TaskAssignee.reach_review,
            ),
        )
        for r in page
    ]
    return MyTaskPage(
        items=items,
        next_cursor=str(page[-1].TaskAssignee.id) if len(rows) > limit and page else None,
    )


# --- the detail page ---------------------------------------------------------------------------


def _signed(settings: Settings, key: str) -> str:
    return file_url(create_file_token(settings, key))


def _attachment(
    settings: Settings, a: TaskAttachment, people: dict[int, UserBrief]
) -> AttachmentOut:
    return AttachmentOut(
        id=a.id,
        kind=a.kind,
        filename=a.filename,
        content_type=a.content_type,
        size=a.size,
        uploaded_by=people[a.uploaded_by],
        created_at=a.created_at,
        url=_signed(settings, a.file_key),
    )


def _metrics(a: TaskAssignee, events: Sequence[tuple[TaskEvent, float | None]]) -> Metrics:
    # `events` pairs each event with its distance (m) from the site, when it has a position.
    """Straight-line figures from what the server recorded. Holds are subtracted from the time on
    site; the wait before leaving is part of accept-to-reached (real travel needs M6)."""
    mine = [(e, d) for e, d in events if e.subject_user_id == a.user_id]
    held_since: dt.datetime | None = None
    held = dt.timedelta()
    for e, _ in mine:
        if e.event == "held":
            held_since = e.at
        elif e.event in ("resumed", "completed") and held_since is not None:
            held += e.at - held_since
            held_since = None
    on_site = _minutes(a.reached_at, a.completed_at)
    if on_site is not None:
        on_site = max(on_site - int(held.total_seconds() // 60), 0)
    straight_line = next((d for e, d in mine if e.event == "accepted" and d is not None), None)
    return Metrics(
        time_to_accept_min=_minutes(a.assigned_at, a.accepted_at),
        accept_to_reached_min=_minutes(a.accepted_at, a.reached_at),
        time_on_site_min=on_site,
        straight_line_m=None if straight_line is None else round(straight_line),
    )


async def detail(
    session: AsyncSession, settings: Settings, actor: AuthContext, task: Task
) -> TaskDetail:
    """The task as this viewer may see it: selfies, positions and the face score only for those
    who manage it (the score only with `face.review`); an assignee sees their own Reached result
    without the selfie or the score."""
    # Re-read, so the computed columns (site position) are loaded for a task just written.
    task = (
        await session.execute(
            select(Task).where(Task.id == task.id).execution_options(populate_existing=True)
        )
    ).scalar_one()
    manager = can_manage(actor, task)
    kind = (await session.execute(select(TaskType).where(TaskType.id == task.type_id))).scalar_one()
    assignees = list(
        (
            await session.execute(
                select(TaskAssignee)
                .where(TaskAssignee.task_id == task.id)
                .order_by(TaskAssignee.id)
                .execution_options(populate_existing=True)
            )
        ).scalars()
    )
    events = (
        await session.execute(
            select(
                TaskEvent,
                func.ST_Distance(TaskEvent.location, Task.site_location, type_=Float),
            )
            .join(Task, Task.id == TaskEvent.task_id)
            .where(TaskEvent.task_id == task.id)
            .order_by(TaskEvent.id)
            .execution_options(populate_existing=True)
        )
    ).all()
    event_rows = [(row[0], row[1]) for row in events]
    attachments = list(
        (
            await session.execute(
                select(TaskAttachment)
                .where(TaskAttachment.task_id == task.id)
                .order_by(TaskAttachment.id)
            )
        ).scalars()
    )
    comments = list(
        (
            await session.execute(
                select(TaskComment).where(TaskComment.task_id == task.id).order_by(TaskComment.id)
            )
        ).scalars()
    )
    people = await _people(
        session,
        [task.created_by, task.closed_by, task.cancelled_by]
        + [a.user_id for a in assignees]
        + [a.reach_reviewed_by for a in assignees]
        + [e.actor_id for e, _ in event_rows]
        + [e.subject_user_id for e, _ in event_rows]
        + [a.uploaded_by for a in attachments]
        + [c.author_id for c in comments],
    )
    by_id = {a.id: a for a in attachments}
    show_score = FACE_REVIEW in actor.permissions

    def reach(a: TaskAssignee) -> ReachOut | None:
        if a.reached_at is None or not (manager or a.user_id == actor.user.id):
            return None
        out = ReachOut(
            at=a.reached_at,
            distance_m=None if a.reached_distance_m is None else round(a.reached_distance_m),
            flags=a.reach_flags,
            reason=a.reach_reason,
            review=a.reach_review,
            review_remarks=a.reach_review_remarks,
            reviewed_by=people.get(a.reach_reviewed_by) if a.reach_reviewed_by else None,
            reviewed_at=a.reach_reviewed_at,
        )
        if manager:
            out.lat, out.lng, out.accuracy_m = a.reached_lat, a.reached_lng, a.reached_accuracy_m
            out.face_decision = a.reached_face_decision
            if a.reached_selfie_key:
                out.selfie_url = _signed(settings, a.reached_selfie_key)
            if show_score:
                out.face_score = a.reached_face_score
        return out

    return TaskDetail(
        id=task.id,
        code=task.code,
        title=task.title,
        type=_type_out(kind),
        client_name=task.client_name,
        site=_site(task),
        contact_name=task.contact_name,
        contact_phone=task.contact_phone,
        priority=task.priority,
        scheduled_at=task.scheduled_at,
        expected_minutes=task.expected_minutes,
        description=task.description,
        status=task.status,
        created_by=people[task.created_by],
        created_at=task.created_at,
        closed_by=people.get(task.closed_by) if task.closed_by else None,
        closed_at=task.closed_at,
        close_remarks=task.close_remarks,
        cancelled_by=people.get(task.cancelled_by) if task.cancelled_by else None,
        cancelled_at=task.cancelled_at,
        cancel_reason=task.cancel_reason,
        can_manage=manager,
        assignees=[
            AssigneeOut(
                user=people[a.user_id],
                status=a.status,
                assigned_at=a.assigned_at,
                accepted_at=a.accepted_at,
                escalated_at=a.escalated_at,
                started_at=a.started_at,
                completed_at=a.completed_at,
                declined_reason=a.declined_reason,
                completion_remarks=a.completion_remarks,
                reach=reach(a),
                metrics=_metrics(a, event_rows),
            )
            for a in assignees
        ],
        events=[
            EventOut(
                id=e.id,
                event=e.event,
                at=e.at,
                actor=people.get(e.actor_id) if e.actor_id else None,
                subject=people.get(e.subject_user_id) if e.subject_user_id else None,
                note=e.note,
                offline=e.offline,
                lat=e.lat if manager else None,
                lng=e.lng if manager else None,
            )
            for e, _ in event_rows
        ],
        # Comment pictures are shown in the thread, not twice.
        attachments=[_attachment(settings, a, people) for a in attachments if a.kind != "comment"],
        comments=[
            CommentOut(
                id=c.id,
                author=people[c.author_id],
                body=c.body,
                created_at=c.created_at,
                attachment=_attachment(settings, by_id[c.attachment_id], people)
                if c.attachment_id
                else None,
            )
            for c in comments
        ],
    )


# --- candidates --------------------------------------------------------------------------------


async def candidates(session: AsyncSession) -> CandidatePage:
    """Every active field-eligible person with today's status, in one query (plus the day's
    holidays). Names and status only: no coordinates, no home locations."""
    today = utcnow().astimezone(IST).date()
    on_task = exists().where(TaskAssignee.user_id == User.id, TaskAssignee.status.in_(lc.BUSY))
    rows = (
        await session.execute(
            select(
                User, AttendanceDay.first_in_at, AttendanceDay.last_out_at, on_task.label("busy")
            )
            .outerjoin(
                AttendanceDay,
                and_(AttendanceDay.user_id == User.id, AttendanceDay.date == today),
            )
            .where(User.status == STATUS_ACTIVE, User.field_eligible)
            .order_by(User.name, User.id)
        )
    ).all()
    holidays = list(
        (await session.execute(select(Holiday.branch_id).where(Holiday.date == today))).scalars()
    )

    def status(
        user: User, first_in: dt.datetime | None, last_out: dt.datetime | None, busy: bool
    ) -> CandidateStatus:
        if busy:
            return "on_task"
        if last_out is not None:
            return "punched_out"
        if first_in is not None:
            return "in_office"
        # ponytail: weekly offs and holidays only; a personal schedule's "off" weekday is not
        # considered here (it would need one lookup per person).
        if None in holidays or user.home_branch_id in holidays:
            return "off_day"
        if user.shift is not None and is_weekly_off(user.shift.weekly_offs, today):
            return "off_day"
        return "not_punched_in"

    return CandidatePage(
        items=[
            Candidate(
                id=u.id,
                name=u.name,
                emp_code=u.emp_code,
                status=status(u, first_in, last_out, busy),
            )
            for u, first_in, last_out, busy in rows
        ]
    )
