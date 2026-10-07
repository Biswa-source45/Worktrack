"""Unaccepted tasks escalate to their assigner (FR-TASK-03). Run every few minutes by the worker;
an assignee is escalated once per assignment, so a late or repeated run changes nothing twice."""

import datetime as dt

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.audit import service as audit
from app.modules.audit.service import AuditCtx
from app.modules.employees.models import User
from app.modules.org_settings.service import get_org_settings
from app.modules.tasks import lifecycle as lc
from app.modules.tasks import service
from app.modules.tasks.models import Task, TaskAssignee

SYSTEM = AuditCtx(None, None)


async def escalate_unaccepted(session: AsyncSession, now: dt.datetime) -> int:
    """Tell the assigner about everyone still `assigned` after `task_accept_escalation_minutes`.
    Returns how many were escalated."""
    minutes = (await get_org_settings(session)).task_accept_escalation_minutes
    due = (
        await session.execute(
            select(TaskAssignee, Task, User.name)
            .join(Task, Task.id == TaskAssignee.task_id)
            .join(User, User.id == TaskAssignee.user_id)
            .where(
                TaskAssignee.status == lc.ASSIGNED,
                TaskAssignee.escalated_at.is_(None),
                TaskAssignee.assigned_at <= now - dt.timedelta(minutes=minutes),
                Task.status.not_in((lc.CANCELLED, lc.CLOSED)),
            )
            .order_by(TaskAssignee.id)
            # Two workers at once never escalate the same row twice.
            .with_for_update(of=TaskAssignee, skip_locked=True)
            .execution_options(populate_existing=True)
        )
    ).all()
    for assignee, task, name in due:
        assignee.escalated_at = now
        event = service.add_event(
            session,
            task,
            "escalated",
            actor_id=None,
            now=now,
            subject_id=assignee.user_id,
            note=f"Not accepted after {minutes} minutes",
        )
        await service.notify(
            session,
            None,
            task.created_by,
            "task_not_accepted",
            f"{task.code} not accepted",
            f"{name} has not accepted {task.title} after {minutes} minutes.",
            task,
            event,
        )
        audit.record(
            session,
            SYSTEM,
            "task.escalate",
            "task",
            task.id,
            after={"user_id": assignee.user_id, "minutes": minutes},
        )
    await session.commit()
    return len(due)
