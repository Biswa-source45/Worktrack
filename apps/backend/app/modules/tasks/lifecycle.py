"""The task lifecycle (SRS Figure 1, applied to each assignee) as pure functions.

Invariant 9: a status changes only through `transition`. The task's own status is derived from
its assignees by `derive_status`; the assigner's `closed` and `cancelled` are set by the service.
"""

from collections.abc import Iterable

from app.core.errors import AppError

ASSIGNED = "assigned"
ACCEPTED = "accepted"
REACHED = "reached"
IN_PROGRESS = "in_progress"
ON_HOLD = "on_hold"
COMPLETED = "completed"
DECLINED = "declined"
CANCELLED = "cancelled"
CLOSED = "closed"  # a task status only: the assigner closed a completed task

ASSIGNEE_STATUSES = (
    ASSIGNED, ACCEPTED, REACHED, IN_PROGRESS, ON_HOLD, COMPLETED, DECLINED, CANCELLED
)  # fmt: skip
TASK_STATUSES = (*ASSIGNEE_STATUSES, CLOSED)

ACCEPT = "accept"
DECLINE = "decline"
REACH = "reached"
START = "start"
HOLD = "hold"
RESUME = "resume"
COMPLETE = "complete"
REOPEN = "reopen"
CANCEL = "cancel"
ACTIONS = (ACCEPT, DECLINE, REACH, START, HOLD, RESUME, COMPLETE, REOPEN, CANCEL)

_TRANSITIONS: dict[tuple[str, str], str] = {
    (ASSIGNED, ACCEPT): ACCEPTED,
    (ASSIGNED, DECLINE): DECLINED,
    (ACCEPTED, REACH): REACHED,
    (REACHED, START): IN_PROGRESS,
    (IN_PROGRESS, HOLD): ON_HOLD,
    (ON_HOLD, RESUME): IN_PROGRESS,
    (IN_PROGRESS, COMPLETE): COMPLETED,
    (COMPLETED, REOPEN): IN_PROGRESS,
    # Not after Reached: once someone is on site, the work is theirs to finish (Figure 1).
    (ASSIGNED, CANCEL): CANCELLED,
    (ACCEPTED, CANCEL): CANCELLED,
}

# Where notes may be added: on site or working. Not a status change.
NOTE_STATES = frozenset({REACHED, IN_PROGRESS, ON_HOLD})
# Assignees who still count for the task (declined and cancelled people drop out).
INACTIVE = frozenset({DECLINED, CANCELLED})
# Assigned between accepted and on hold: "on a task" for the candidate list.
BUSY = (ACCEPTED, REACHED, IN_PROGRESS, ON_HOLD)
# Statuses from which the person may punch in at the site (FR-ATT-10).
FIELD_PUNCH_STATES = BUSY

_RANK = {ASSIGNED: 0, ACCEPTED: 1, REACHED: 2, ON_HOLD: 3, IN_PROGRESS: 3, COMPLETED: 4}


def transition(status: str, action: str) -> str:
    """The status after `action`, or a 409 INVALID_TRANSITION."""
    try:
        return _TRANSITIONS[(status, action)]
    except KeyError:
        raise AppError(
            "INVALID_TRANSITION",
            f"This task cannot be moved by '{action}' while it is {status.replace('_', ' ')}.",
            409,
            {"from": status, "action": action},
        ) from None


def derive_status(assignee_statuses: Iterable[str]) -> str:
    """The task status from its assignees.

    Completed when every active assignee has completed; otherwise the least advanced active
    assignee (in progress before on hold at the same rank). With nobody active: declined when
    someone declined, else assigned (the assigner can add someone or cancel).
    """
    statuses = list(assignee_statuses)
    active = [s for s in statuses if s not in INACTIVE]
    if not active:
        return DECLINED if DECLINED in statuses else ASSIGNED
    if all(s == COMPLETED for s in active):
        return COMPLETED
    return min((s for s in active if s != COMPLETED), key=lambda s: (_RANK[s], s != IN_PROGRESS))
