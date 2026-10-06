"""Task sites as geofence candidates (kind "task"): for Reached and for field punch-in."""

import datetime as dt

from sqlalchemy import literal, select

from app.core.clock import IST
from app.modules.branches.geofence import Candidates
from app.modules.tasks import lifecycle as lc
from app.modules.tasks.models import Task, TaskAssignee


def site_candidate(task_id: int) -> Candidates:
    """One task's site."""
    return _candidates().where(Task.id == task_id)


def field_punch_sites(user_id: int, day: dt.date) -> Candidates:
    """The sites of the person's tasks for `day` (IST) that they have accepted and not finished:
    where a field punch-in is allowed (FR-ATT-10)."""
    start = dt.datetime.combine(day, dt.time(), tzinfo=IST)
    return (
        _candidates()
        .join(TaskAssignee, TaskAssignee.task_id == Task.id)
        .where(
            TaskAssignee.user_id == user_id,
            TaskAssignee.status.in_(lc.FIELD_PUNCH_STATES),
            Task.status.not_in((lc.CANCELLED, lc.CLOSED)),
            Task.scheduled_at >= start,
            Task.scheduled_at < start + dt.timedelta(days=1),
        )
    )


def _candidates() -> Candidates:
    return select(
        literal("task").label("kind"),
        Task.id.label("id"),
        Task.code.label("name"),
        Task.site_location.label("location"),
        Task.site_radius_m.label("radius_m"),
    )
