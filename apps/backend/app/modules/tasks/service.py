"""Field tasks (SRS 4.7): creating, editing, assigning, cancelling, closing, reopening, comments,
briefs and task types. What an assignee does with their own task is in `actions.py`.

Every mutation takes the task's row lock first, then looks for an earlier request with the same
`Idempotency-Key` (so a retry that arrives while the first is still running waits and then replays
it), then changes things, writes the timeline event and the audit row, and commits once. The first
event of a request carries its key.
"""

import datetime as dt
import uuid
from collections.abc import Sequence
from typing import TYPE_CHECKING, Any

from fastapi import UploadFile
from geoalchemy2 import WKTElement
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.errors import AppError
from app.core.security import utcnow
from app.modules.audit import service as audit
from app.modules.audit.service import AuditCtx
from app.modules.auth.deps import AuthContext
from app.modules.auth.permissions import TASKS_VIEW_ALL
from app.modules.employees.models import STATUS_ACTIVE, User
from app.modules.notifications.models import Notification
from app.modules.org_settings.schemas import OrgSettings
from app.modules.org_settings.service import get_org_settings
from app.modules.tasks import lifecycle as lc
from app.modules.tasks import views
from app.modules.tasks.media import read_brief, read_photo, uploads
from app.modules.tasks.models import (
    Task,
    TaskAssignee,
    TaskAttachment,
    TaskComment,
    TaskEvent,
    TaskType,
)
from app.modules.tasks.schemas import (
    ActionForm,
    ActionOut,
    CancelIn,
    CloseIn,
    ReopenIn,
    SiteIn,
    TaskCreate,
    TaskPatch,
    TaskTypeIn,
    TaskTypeOut,
    TaskTypePatch,
)

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client

OPEN_STATUSES = (
    lc.ASSIGNED,
    lc.ACCEPTED,
    lc.REACHED,
    lc.IN_PROGRESS,
    lc.ON_HOLD,
    lc.DECLINED,
)
MAX_BRIEFS = 10


def point(lat: float, lng: float) -> WKTElement:
    return WKTElement(f"POINT({lng} {lat})", srid=4326)


# --- shared pieces -----------------------------------------------------------------------------


async def lock_task(session: AsyncSession, task_id: int) -> Task:
    """The task with its row locked until the transaction ends (serialises its mutations)."""
    task = await session.scalar(
        select(Task)
        .where(Task.id == task_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if task is None:
        raise views.not_found()
    return task


async def locked_visible(session: AsyncSession, actor: AuthContext, task_id: int) -> Task:
    """Lock a task the actor may see (404 otherwise). A task is locked only after the visibility
    check passed, so a stranger cannot make a task wait."""
    await views.visible_task(session, actor, task_id)
    return await lock_task(session, task_id)


async def locked_managed(session: AsyncSession, actor: AuthContext, task_id: int) -> Task:
    task = await locked_visible(session, actor, task_id)
    if not views.can_manage(actor, task):
        raise AppError("FORBIDDEN", "You do not have permission to do this.", 403)
    return task


async def assignees_of(session: AsyncSession, task_id: int) -> list[TaskAssignee]:
    return list(
        (
            await session.execute(
                select(TaskAssignee)
                .where(TaskAssignee.task_id == task_id)
                .order_by(TaskAssignee.id)
                .execution_options(populate_existing=True)
            )
        ).scalars()
    )


async def replay_of(
    session: AsyncSession, actor_id: int, key: uuid.UUID, task_id: int, events: set[str]
) -> TaskEvent | None:
    """The event of an earlier request with this key. Another task or another kind of action means
    the key is being reused, which is refused."""
    prior = await session.scalar(
        select(TaskEvent).where(TaskEvent.actor_id == actor_id, TaskEvent.request_id == key)
    )
    if prior is None:
        return None
    if prior.task_id != task_id or prior.event not in events:
        raise AppError(
            "IDEMPOTENCY_KEY_REUSED",
            "This request id was already used for a different action.",
            409,
        )
    return prior


def add_event(
    session: AsyncSession,
    task: Task,
    event: str,
    *,
    actor_id: int | None,
    now: dt.datetime,
    subject_id: int | None = None,
    note: str | None = None,
    form: ActionForm | None = None,
    key: uuid.UUID | None = None,
) -> TaskEvent:
    row = TaskEvent(
        task_id=task.id,
        subject_user_id=subject_id,
        actor_id=actor_id,
        event=event,
        at=now,
        note=note,
        request_id=key,
    )
    if form is not None:
        row.device_time = form.device_time
        row.offline = form.offline
        if form.lat is not None and form.lng is not None:
            row.location = point(form.lat, form.lng)
            row.accuracy_m = form.accuracy_m
    session.add(row)
    return row


def check_offline(
    offline: bool, device_time: dt.datetime | None, now: dt.datetime, settings: OrgSettings
) -> None:
    """A replayed offline action must say when the phone took it, recently. The time that counts
    is still the server's receipt time (D70)."""
    if not offline:
        return
    if device_time is None:
        raise AppError(
            "OFFLINE_TIME_MISSING", "An offline action needs the time it was taken.", 422
        )
    if now - device_time > dt.timedelta(hours=settings.offline_punch_max_age_hours):
        raise AppError(
            "OFFLINE_PUNCH_TOO_OLD",
            "This action was taken too long ago to be sent. Ask your assigner.",
            409,
        )


async def notify(
    session: AsyncSession,
    actor_id: int | None,
    user_id: int,
    kind: str,
    title: str,
    body: str,
    task: Task,
    event: TaskEvent,
) -> None:
    """An in-app record (push comes in M8). Never for the person who did it themselves. One row
    per event and person, so a replay cannot add a second."""
    if user_id == actor_id:
        return
    await session.flush()  # the event's id is part of the dedupe key
    await session.execute(
        insert(Notification)
        .values(
            user_id=user_id,
            type=kind,
            title=title,
            body=body[:500],
            deep_link=f"/tasks/{task.id}",
            dedupe_key=f"{kind}:{task.id}:{event.id}:{user_id}",
        )
        .on_conflict_do_nothing(index_elements=["dedupe_key"])
    )


def recompute(task: Task, assignees: Sequence[TaskAssignee]) -> None:
    """The task status from its assignees (closed and cancelled are the assigner's, and final)."""
    if task.status not in (lc.CLOSED, lc.CANCELLED):
        task.status = lc.derive_status(a.status for a in assignees)


async def finish(
    session: AsyncSession, settings: Settings, actor: AuthContext, task: Task, *, replayed: bool
) -> ActionOut:
    return ActionOut(task=await views.detail(session, settings, actor, task), replayed=replayed)


async def _active_user(session: AsyncSession, user_id: int) -> User:
    user = await session.get(User, user_id)
    if user is None or user.status != STATUS_ACTIVE:
        raise AppError("INVALID_REFERENCE", "An assignee does not exist or is inactive.", 422)
    if not user.field_eligible:
        raise AppError(
            "NOT_FIELD_ELIGIBLE",
            f"{user.name} is not set up for field work, so cannot be assigned a task.",
            422,
            {"user_id": user.id},
        )
    return user


async def _task_type(session: AsyncSession, type_id: int) -> TaskType:
    kind = await session.get(TaskType, type_id)
    if kind is None or not kind.is_active:
        raise AppError("INVALID_REFERENCE", "The selected task type does not exist.", 422)
    return kind


def _not_open(task: Task, action: str) -> AppError:
    return AppError(
        "INVALID_TRANSITION",
        f"This task is {task.status.replace('_', ' ')}, so it cannot be changed.",
        409,
        {"from": task.status, "action": action},
    )


# --- create and edit ---------------------------------------------------------------------------


async def create(
    session: AsyncSession,
    ctx: AuditCtx,
    settings: Settings,
    actor: AuthContext,
    key: uuid.UUID,
    body: TaskCreate,
) -> ActionOut:
    existing = await session.scalar(
        select(Task).where(Task.created_by == actor.user.id, Task.request_id == key)
    )
    if existing is None:
        other = await session.scalar(
            select(TaskEvent.id).where(
                TaskEvent.actor_id == actor.user.id, TaskEvent.request_id == key
            )
        )
        if other is not None:
            raise AppError(
                "IDEMPOTENCY_KEY_REUSED",
                "This request id was already used for a different action.",
                409,
            )
    else:
        await views.visible_task(session, actor, existing.id)
        return await finish(session, settings, actor, existing, replayed=True)

    await _task_type(session, body.type_id)
    org = await get_org_settings(session)
    people = [await _active_user(session, uid) for uid in body.assignee_ids]
    now = utcnow()
    task = Task(
        title=body.title,
        type_id=body.type_id,
        client_name=body.client_name,
        site_address=body.site.address,
        site_location=point(body.site.lat, body.site.lng),
        site_radius_m=body.site.radius_m or org.task_default_site_radius_m,
        contact_name=body.contact_name,
        contact_phone=body.contact_phone,
        priority=body.priority,
        scheduled_at=body.scheduled_at,
        expected_minutes=body.expected_minutes,
        description=body.description,
        status=lc.ASSIGNED,
        created_by=actor.user.id,
        request_id=key,
    )
    try:
        async with session.begin_nested():
            session.add(task)
            await session.flush()
    except IntegrityError:
        # The same key sent twice at the same instant: the first one won.
        again = await session.scalar(
            select(Task).where(Task.created_by == actor.user.id, Task.request_id == key)
        )
        if again is None:
            raise
        return await finish(session, settings, actor, again, replayed=True)
    add_event(session, task, "created", actor_id=actor.user.id, now=now, key=key)
    for person in people:
        session.add(TaskAssignee(task_id=task.id, user_id=person.id, assigned_at=now))
        event = add_event(
            session, task, "assigned", actor_id=actor.user.id, now=now, subject_id=person.id
        )
        await notify(
            session,
            actor.user.id,
            person.id,
            "task_assigned",
            f"New task {task.code}",
            f"{task.title} at {task.client_name}",
            task,
            event,
        )
    audit.record(
        session,
        ctx,
        "task.create",
        "task",
        task.id,
        after={"code": task.code, "title": task.title, "assignee_ids": body.assignee_ids},
    )
    await session.commit()
    return await finish(session, settings, actor, task, replayed=False)


def _site_changed(task: Task, site: SiteIn, default_radius: int) -> bool:
    return (
        site.address != task.site_address
        or round(site.lat, 6) != round(task.site_lat, 6)
        or round(site.lng, 6) != round(task.site_lng, 6)
        or (site.radius_m or default_radius) != task.site_radius_m
    )


async def edit(
    session: AsyncSession,
    ctx: AuditCtx,
    settings: Settings,
    actor: AuthContext,
    task_id: int,
    key: uuid.UUID,
    body: TaskPatch,
) -> ActionOut:
    task = await locked_managed(session, actor, task_id)
    if await replay_of(session, actor.user.id, key, task.id, {"updated"}):
        return await finish(session, settings, actor, task, replayed=True)
    if task.status in (lc.COMPLETED, lc.CLOSED, lc.CANCELLED):
        raise _not_open(task, "edit")
    org = await get_org_settings(session)
    sent = body.model_fields_set
    changes: dict[str, Any] = {}
    before: dict[str, Any] = {}
    for name in ("title", "client_name", "contact_name", "contact_phone", "priority",
                 "scheduled_at", "expected_minutes", "description"):  # fmt: skip
        if name in sent and getattr(body, name) != getattr(task, name):
            before[name] = getattr(task, name)
            changes[name] = getattr(body, name)
    if body.type_id is not None and body.type_id != task.type_id:
        await _task_type(session, body.type_id)
        before["type_id"], changes["type_id"] = task.type_id, body.type_id
    if "site" in sent and body.site is not None:
        assignees = await assignees_of(session, task.id)
        if _site_changed(task, body.site, org.task_default_site_radius_m):
            if any(a.reached_at is not None for a in assignees):
                raise AppError(
                    "TASK_SITE_LOCKED",
                    "Someone has already reached this site, so it cannot be moved.",
                    409,
                )
            before["site"] = {
                "address": task.site_address,
                "lat": task.site_lat,
                "lng": task.site_lng,
                "radius_m": task.site_radius_m,
            }
            changes["site"] = body.site.model_dump()
            task.site_address = body.site.address
            task.site_location = point(body.site.lat, body.site.lng)
            task.site_radius_m = body.site.radius_m or org.task_default_site_radius_m
    for name, value in changes.items():
        if name != "site":
            setattr(task, name, value)
    if not changes:
        return await finish(session, settings, actor, task, replayed=False)
    now = utcnow()
    add_event(
        session,
        task,
        "updated",
        actor_id=actor.user.id,
        now=now,
        note="Changed " + ", ".join(sorted(changes)),
        key=key,
    )
    audit.record(
        session,
        ctx,
        "task.update",
        "task",
        task.id,
        before=_plain(before),
        after=_plain(changes),
    )
    await session.commit()
    return await finish(session, settings, actor, task, replayed=False)


def _plain(values: dict[str, Any]) -> dict[str, Any]:
    """Audit rows are JSON: dates become text."""
    return {k: v.isoformat() if isinstance(v, dt.datetime) else v for k, v in values.items()}


# --- people on the task ------------------------------------------------------------------------


async def assign(
    session: AsyncSession,
    ctx: AuditCtx,
    settings: Settings,
    actor: AuthContext,
    task_id: int,
    key: uuid.UUID,
    user_ids: list[int],
) -> ActionOut:
    task = await locked_managed(session, actor, task_id)
    if await replay_of(session, actor.user.id, key, task.id, {"assigned"}):
        return await finish(session, settings, actor, task, replayed=True)
    if task.status not in OPEN_STATUSES:
        raise _not_open(task, "assign")
    assignees = {a.user_id: a for a in await assignees_of(session, task.id)}
    people = []
    for uid in dict.fromkeys(user_ids):
        current = assignees.get(uid)
        if current is not None and current.status not in lc.INACTIVE:
            raise AppError(
                "ALREADY_ASSIGNED", "That person is already on this task.", 409, {"user_id": uid}
            )
        people.append(await _active_user(session, uid))
    now = utcnow()
    for n, person in enumerate(people):
        row = assignees.get(person.id)
        if row is None:
            row = TaskAssignee(task_id=task.id, user_id=person.id, assigned_at=now)
            session.add(row)
            assignees[person.id] = row
        else:  # someone who declined or was removed is asked again, from the start
            row.status = lc.ASSIGNED
            row.assigned_at = now
            row.accepted_at = row.escalated_at = None
            row.declined_reason = None
        event = add_event(
            session,
            task,
            "assigned",
            actor_id=actor.user.id,
            now=now,
            subject_id=person.id,
            key=key if n == 0 else None,
        )
        await notify(
            session,
            actor.user.id,
            person.id,
            "task_assigned",
            f"New task {task.code}",
            f"{task.title} at {task.client_name}",
            task,
            event,
        )
    recompute(task, list(assignees.values()))
    audit.record(
        session, ctx, "task.assign", "task", task.id, after={"user_ids": [p.id for p in people]}
    )
    await session.commit()
    return await finish(session, settings, actor, task, replayed=False)


async def unassign(
    session: AsyncSession,
    ctx: AuditCtx,
    settings: Settings,
    actor: AuthContext,
    task_id: int,
    user_id: int,
    key: uuid.UUID,
) -> ActionOut:
    task = await locked_managed(session, actor, task_id)
    if await replay_of(session, actor.user.id, key, task.id, {"unassigned"}):
        return await finish(session, settings, actor, task, replayed=True)
    if task.status in (lc.CLOSED, lc.CANCELLED):
        raise _not_open(task, "unassign")
    assignees = await assignees_of(session, task.id)
    row = next((a for a in assignees if a.user_id == user_id), None)
    if row is None:
        raise AppError("NOT_ASSIGNED", "That person is not on this task.", 404)
    before = row.status
    row.status = lc.transition(row.status, lc.CANCEL)  # only before they have reached the site
    now = utcnow()
    event = add_event(
        session, task, "unassigned", actor_id=actor.user.id, now=now, subject_id=user_id, key=key
    )
    await notify(
        session,
        actor.user.id,
        user_id,
        "task_cancelled",
        f"Task {task.code} removed",
        f"You were taken off {task.title}",
        task,
        event,
    )
    recompute(task, assignees)
    audit.record(
        session,
        ctx,
        "task.unassign",
        "task",
        task.id,
        before={"user_id": user_id, "status": before},
    )
    await session.commit()
    return await finish(session, settings, actor, task, replayed=False)


# --- cancel, close, reopen ---------------------------------------------------------------------


async def cancel(
    session: AsyncSession,
    ctx: AuditCtx,
    settings: Settings,
    actor: AuthContext,
    task_id: int,
    key: uuid.UUID,
    body: CancelIn,
) -> ActionOut:
    task = await locked_managed(session, actor, task_id)
    if await replay_of(session, actor.user.id, key, task.id, {"cancelled"}):
        return await finish(session, settings, actor, task, replayed=True)
    if task.status in (lc.CLOSED, lc.CANCELLED):
        raise _not_open(task, lc.CANCEL)
    assignees = await assignees_of(session, task.id)
    live = [a for a in assignees if a.status not in lc.INACTIVE]
    # Every live assignee must still be cancellable: nobody who has reached the site, or finished.
    for a in live:
        lc.transition(a.status, lc.CANCEL)
    now = utcnow()
    for a in live:
        a.status = lc.CANCELLED
    task.status = lc.CANCELLED
    task.cancelled_by, task.cancelled_at, task.cancel_reason = actor.user.id, now, body.reason
    event = add_event(
        session, task, "cancelled", actor_id=actor.user.id, now=now, note=body.reason, key=key
    )
    for a in live:
        await notify(
            session,
            actor.user.id,
            a.user_id,
            "task_cancelled",
            f"Task {task.code} cancelled",
            f"{task.title}: {body.reason}",
            task,
            event,
        )
    audit.record(session, ctx, "task.cancel", "task", task.id, after={"reason": body.reason})
    await session.commit()
    return await finish(session, settings, actor, task, replayed=False)


async def close(
    session: AsyncSession,
    ctx: AuditCtx,
    settings: Settings,
    actor: AuthContext,
    task_id: int,
    key: uuid.UUID,
    body: CloseIn,
) -> ActionOut:
    task = await locked_managed(session, actor, task_id)
    if await replay_of(session, actor.user.id, key, task.id, {"closed"}):
        return await finish(session, settings, actor, task, replayed=True)
    if task.status != lc.COMPLETED:
        raise _not_open(task, "close")
    assignees = await assignees_of(session, task.id)
    if any(a.reach_review == "pending" for a in assignees):
        raise AppError(
            "REACH_REVIEW_PENDING",
            "A Reached that needs review is still waiting. Decide it before closing.",
            409,
        )
    if any(a.reach_review == "rejected" for a in assignees) and not body.remarks:
        raise AppError(
            "CLOSE_COMMENT_REQUIRED",
            "A Reached was rejected on this task. Say why you are closing it anyway.",
            422,
        )
    now = utcnow()
    task.status = lc.CLOSED
    task.closed_by, task.closed_at, task.close_remarks = actor.user.id, now, body.remarks
    add_event(session, task, "closed", actor_id=actor.user.id, now=now, note=body.remarks, key=key)
    audit.record(session, ctx, "task.close", "task", task.id, after={"remarks": body.remarks})
    await session.commit()
    return await finish(session, settings, actor, task, replayed=False)


async def reopen(
    session: AsyncSession,
    ctx: AuditCtx,
    settings: Settings,
    actor: AuthContext,
    task_id: int,
    key: uuid.UUID,
    body: ReopenIn,
) -> ActionOut:
    task = await locked_managed(session, actor, task_id)
    if await replay_of(session, actor.user.id, key, task.id, {"reopened"}):
        return await finish(session, settings, actor, task, replayed=True)
    if task.status != lc.COMPLETED:
        raise _not_open(task, lc.REOPEN)
    assignees = await assignees_of(session, task.id)
    completed = [a for a in assignees if a.status == lc.COMPLETED]
    chosen = completed
    if body.user_ids is not None:
        by_user = {a.user_id: a for a in assignees}
        wanted = list(dict.fromkeys(body.user_ids))
        missing = [uid for uid in wanted if uid not in by_user]
        if missing:
            raise AppError(
                "NOT_ASSIGNED", "That person is not on this task.", 404, {"user_ids": missing}
            )
        chosen = [by_user[uid] for uid in wanted]
    now = utcnow()
    for n, a in enumerate(chosen):
        a.status = lc.transition(a.status, lc.REOPEN)
        a.completed_at = None
        event = add_event(
            session,
            task,
            "reopened",
            actor_id=actor.user.id,
            now=now,
            subject_id=a.user_id,
            note=body.comment,
            key=key if n == 0 else None,
        )
        await notify(
            session,
            actor.user.id,
            a.user_id,
            "task_reopened",
            f"Task {task.code} reopened",
            f"{task.title}: {body.comment}",
            task,
            event,
        )
    recompute(task, assignees)
    audit.record(
        session,
        ctx,
        "task.reopen",
        "task",
        task.id,
        after={"user_ids": [a.user_id for a in chosen], "comment": body.comment},
    )
    await session.commit()
    return await finish(session, settings, actor, task, replayed=False)


# --- comments and briefs -----------------------------------------------------------------------


async def comment(
    session: AsyncSession,
    ctx: AuditCtx,
    settings: Settings,
    s3: "S3Client",
    actor: AuthContext,
    task_id: int,
    key: uuid.UUID,
    body: str,
    photo: UploadFile | None,
) -> ActionOut:
    """The assigner (or an admin) and the assignees talk here; a manager only watching from a
    team scope does not."""
    task = await locked_visible(session, actor, task_id)
    taking_part = TASKS_VIEW_ALL in actor.permissions or task.created_by == actor.user.id
    if not taking_part:
        taking_part = any(a.user_id == actor.user.id for a in await assignees_of(session, task.id))
    if not taking_part:
        raise AppError("FORBIDDEN", "You do not have permission to do this.", 403)
    prior = await session.scalar(
        select(TaskComment).where(
            TaskComment.author_id == actor.user.id, TaskComment.request_id == key
        )
    )
    if prior is not None:
        if prior.task_id != task.id:
            raise AppError(
                "IDEMPOTENCY_KEY_REUSED",
                "This request id was already used for a different action.",
                409,
            )
        return await finish(session, settings, actor, task, replayed=True)
    if not body and photo is None:
        raise AppError("EMPTY_COMMENT", "Write something or add a photo.", 422)
    async with uploads(s3, settings.s3_bucket) as stored:
        attachment_id = None
        if photo is not None:
            data = await read_photo(photo)
            file_key = await stored.put(f"task/{task.id}", data)
            attachment = TaskAttachment(
                task_id=task.id,
                uploaded_by=actor.user.id,
                kind="comment",
                file_key=file_key,
                content_type="image/jpeg",
                size=len(data),
            )
            session.add(attachment)
            await session.flush()
            attachment_id = attachment.id
        row = TaskComment(
            task_id=task.id,
            author_id=actor.user.id,
            body=body,
            attachment_id=attachment_id,
            request_id=key,
        )
        session.add(row)
        await session.flush()
        audit.record(session, ctx, "task.comment", "task", task.id, after={"comment_id": row.id})
        await session.commit()
    return await finish(session, settings, actor, task, replayed=False)


async def add_brief(
    session: AsyncSession,
    ctx: AuditCtx,
    settings: Settings,
    s3: "S3Client",
    actor: AuthContext,
    task_id: int,
    key: uuid.UUID,
    file: UploadFile,
) -> ActionOut:
    task = await locked_managed(session, actor, task_id)
    prior = await session.scalar(
        select(TaskAttachment).where(
            TaskAttachment.uploaded_by == actor.user.id, TaskAttachment.request_id == key
        )
    )
    if prior is not None:
        if prior.task_id != task.id:
            raise AppError(
                "IDEMPOTENCY_KEY_REUSED",
                "This request id was already used for a different action.",
                409,
            )
        return await finish(session, settings, actor, task, replayed=True)
    if task.status in (lc.CLOSED, lc.CANCELLED):
        raise _not_open(task, "attach")
    count = await session.scalar(
        select(func.count()).where(
            TaskAttachment.task_id == task.id, TaskAttachment.kind == "brief"
        )
    )
    if (count or 0) >= MAX_BRIEFS:
        raise AppError("TOO_MANY_ATTACHMENTS", f"A task can have {MAX_BRIEFS} attachments.", 422)
    data, content_type = await read_brief(file)
    async with uploads(s3, settings.s3_bucket) as stored:
        file_key = await stored.put(f"task/{task.id}", data, content_type)
        row = TaskAttachment(
            task_id=task.id,
            uploaded_by=actor.user.id,
            kind="brief",
            file_key=file_key,
            content_type=content_type,
            size=len(data),
            filename=(file.filename or "")[:255] or None,
            request_id=key,
        )
        session.add(row)
        await session.flush()
        audit.record(
            session,
            ctx,
            "task.attachment",
            "task",
            task.id,
            after={"attachment_id": row.id, "content_type": content_type, "size": len(data)},
        )
        await session.commit()
    return await finish(session, settings, actor, task, replayed=False)


# --- task types --------------------------------------------------------------------------------


async def list_types(session: AsyncSession, *, only_active: bool) -> list[TaskTypeOut]:
    stmt = select(TaskType).order_by(TaskType.id)
    if only_active:
        stmt = stmt.where(TaskType.is_active)
    return [
        TaskTypeOut.model_validate(t, from_attributes=True)
        for t in (await session.execute(stmt)).scalars()
    ]


async def _type_name_free(session: AsyncSession, name: str, own_id: int | None) -> None:
    taken = await session.scalar(
        select(TaskType.id).where(
            func.lower(TaskType.name) == name.lower(), TaskType.id != (own_id or 0)
        )
    )
    if taken is not None:
        raise AppError("DUPLICATE", "A task type with that name already exists.", 409)


async def create_type(session: AsyncSession, ctx: AuditCtx, body: TaskTypeIn) -> TaskTypeOut:
    await _type_name_free(session, body.name, None)
    row = TaskType(
        name=body.name, proof_photo_required=body.proof_photo_required, proof_kind=body.proof_kind
    )
    session.add(row)
    await session.flush()
    audit.record(session, ctx, "task_type.create", "task_type", row.id, after=body.model_dump())
    await session.commit()
    return TaskTypeOut.model_validate(row, from_attributes=True)


async def update_type(
    session: AsyncSession, ctx: AuditCtx, type_id: int, body: TaskTypePatch
) -> TaskTypeOut:
    row = await session.get(TaskType, type_id)
    if row is None:
        raise AppError("NOT_FOUND", "Task type not found.", 404)
    changes = {name: getattr(body, name) for name in body.model_fields_set}
    if "name" in changes:
        await _type_name_free(session, changes["name"], row.id)
    before = {name: getattr(row, name) for name in changes}
    for name, value in changes.items():
        setattr(row, name, value)
    audit.record(
        session, ctx, "task_type.update", "task_type", row.id, before=before, after=changes
    )
    await session.commit()
    return TaskTypeOut.model_validate(row, from_attributes=True)
