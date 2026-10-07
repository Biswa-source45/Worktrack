"""What an assignee does with their own task: accept, decline, start, hold, resume, add notes and
complete. Each one moves only that person's status, through `lifecycle.transition` (invariant 9),
and the task status follows from all assignees."""

import uuid
from typing import TYPE_CHECKING, Any

from fastapi import UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.errors import AppError
from app.core.security import utcnow
from app.modules.audit import service as audit
from app.modules.audit.service import AuditCtx
from app.modules.auth.deps import AuthContext
from app.modules.org_settings.service import get_org_settings
from app.modules.tasks import lifecycle as lc
from app.modules.tasks import service, views
from app.modules.tasks.media import read_photo, uploads
from app.modules.tasks.models import Task, TaskAssignee, TaskAttachment, TaskType
from app.modules.tasks.schemas import ActionForm, ActionOut

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client

MAX_PHOTOS = 5
NOTE = "note"
# The timeline event each action writes.
EVENT = {
    lc.ACCEPT: "accepted",
    lc.DECLINE: "declined",
    lc.START: "started",
    lc.HOLD: "held",
    lc.RESUME: "resumed",
    lc.COMPLETE: "completed",
    NOTE: "note",
}


async def own_row(
    session: AsyncSession, actor: AuthContext, task_id: int
) -> tuple[Task, TaskAssignee, list[TaskAssignee]]:
    """The task (locked) and the caller's own row. Anyone else, or an unknown task, gets 404."""
    mine = await session.scalar(
        select(TaskAssignee.id).where(
            TaskAssignee.task_id == task_id, TaskAssignee.user_id == actor.user.id
        )
    )
    if mine is None:
        raise views.not_found()
    task = await service.lock_task(session, task_id)
    assignees = await service.assignees_of(session, task.id)
    row = next(a for a in assignees if a.user_id == actor.user.id)
    return task, row, assignees


async def act(
    session: AsyncSession,
    ctx: AuditCtx,
    settings: Settings,
    s3: "S3Client",
    actor: AuthContext,
    task_id: int,
    key: uuid.UUID,
    action: str,
    form: ActionForm,
    *,
    reason: str | None = None,
    remarks: str | None = None,
    note: str | None = None,
    photos: list[UploadFile] | None = None,
) -> ActionOut:
    """One assignee action. `action` is a lifecycle action or "note" (no status change)."""
    task, mine, assignees = await own_row(session, actor, task_id)
    if await service.replay_of(session, actor.user.id, key, task.id, {EVENT[action]}):
        return await service.finish(session, settings, actor, task, replayed=True)
    now = utcnow()
    service.check_offline(form.offline, form.device_time, now, await get_org_settings(session))

    before = mine.status
    if action == NOTE:
        if mine.status not in lc.NOTE_STATES:
            raise AppError(
                "INVALID_TRANSITION",
                "Notes can be added once you have reached the site and until you complete.",
                409,
                {"from": mine.status, "action": NOTE},
            )
        if not note and not photos:
            raise AppError("EMPTY_NOTE", "Write a note or add a photo.", 422)
        after = mine.status
    else:
        after = lc.transition(mine.status, action)

    kind: TaskType | None = None
    if action == lc.COMPLETE:
        kind = await session.get(TaskType, task.type_id)
        if kind is not None and kind.proof_photo_required and not photos:
            what = "a photo of the receipt" if kind.proof_kind == "receipt" else "a proof photo"
            raise AppError(
                "PROOF_PHOTO_REQUIRED",
                f"Add {what} to complete this task.",
                422,
                {"proof_kind": kind.proof_kind},
            )
    if photos and len(photos) > MAX_PHOTOS:
        raise AppError("TOO_MANY_PHOTOS", f"Add at most {MAX_PHOTOS} photos.", 422)

    text = {lc.DECLINE: reason, lc.HOLD: reason, lc.COMPLETE: remarks, NOTE: note}.get(action)
    async with uploads(s3, settings.s3_bucket) as stored:
        event = service.add_event(
            session,
            task,
            EVENT[action],
            actor_id=actor.user.id,
            now=now,
            subject_id=actor.user.id,
            note=text,
            form=form,
            key=key,
        )
        await session.flush()
        if photos:
            attach = "work_photo"
            if action == lc.COMPLETE:
                attach = "receipt" if kind is not None and kind.proof_kind == "receipt" else "proof"
            for photo in photos:
                data = await read_photo(photo)
                file_key = await stored.put(f"task/{task.id}", data)
                session.add(
                    TaskAttachment(
                        task_id=task.id,
                        uploaded_by=actor.user.id,
                        kind=attach,
                        file_key=file_key,
                        content_type="image/jpeg",
                        size=len(data),
                        event_id=event.id,
                    )
                )
        mine.status = after
        if action == lc.ACCEPT:
            mine.accepted_at = now
        elif action == lc.DECLINE:
            mine.declined_reason = reason
        elif action == lc.START and mine.started_at is None:
            mine.started_at = now
        elif action == lc.COMPLETE:
            mine.completed_at, mine.completion_remarks = now, remarks
        service.recompute(task, assignees)
        await _tell_creator(session, actor, task, mine, event, action, text)
        audit.record(
            session,
            ctx,
            f"task.{action}",
            "task",
            task.id,
            before={"status": before},
            after={"status": after, "offline": form.offline},
        )
        await session.commit()
    return await service.finish(session, settings, actor, task, replayed=False)


_TELL = {
    lc.ACCEPT: ("task_accepted", "accepted"),
    lc.DECLINE: ("task_declined", "declined"),
    lc.COMPLETE: ("task_completed", "completed"),
}


async def _tell_creator(
    session: AsyncSession,
    actor: AuthContext,
    task: Task,
    mine: TaskAssignee,
    event: Any,
    action: str,
    text: str | None,
) -> None:
    if action not in _TELL:
        return
    kind, verb = _TELL[action]
    body = f"{actor.user.name} {verb} {task.title}" + (
        f": {text}" if action == lc.DECLINE and text else ""
    )
    await service.notify(
        session, actor.user.id, task.created_by, kind, f"Task {task.code} {verb}", body, task, event
    )
