"""The task lifecycle table (SRS Figure 1) over every status x action pair, and the derived
task status."""

import itertools

import pytest

from app.core.errors import AppError
from app.modules.tasks.lifecycle import (
    ACCEPT,
    ACCEPTED,
    ACTIONS,
    ASSIGNED,
    ASSIGNEE_STATUSES,
    CANCEL,
    CANCELLED,
    COMPLETE,
    COMPLETED,
    DECLINE,
    DECLINED,
    HOLD,
    IN_PROGRESS,
    ON_HOLD,
    REACH,
    REACHED,
    REOPEN,
    RESUME,
    START,
    derive_status,
    transition,
)

ALLOWED = {
    (ASSIGNED, ACCEPT): ACCEPTED,
    (ASSIGNED, DECLINE): DECLINED,
    (ACCEPTED, REACH): REACHED,
    (REACHED, START): IN_PROGRESS,
    (IN_PROGRESS, HOLD): ON_HOLD,
    (ON_HOLD, RESUME): IN_PROGRESS,
    (IN_PROGRESS, COMPLETE): COMPLETED,
    (COMPLETED, REOPEN): IN_PROGRESS,
    (ASSIGNED, CANCEL): CANCELLED,
    (ACCEPTED, CANCEL): CANCELLED,
}
PAIRS = list(itertools.product(ASSIGNEE_STATUSES, ACTIONS))


def test_the_table_covers_every_status_and_action() -> None:
    assert len(PAIRS) == 8 * 9
    assert set(ALLOWED) <= set(PAIRS)


@pytest.mark.parametrize(("status", "action"), PAIRS)
def test_every_status_action_pair(status: str, action: str) -> None:
    if (status, action) in ALLOWED:
        assert transition(status, action) == ALLOWED[(status, action)]
        return
    with pytest.raises(AppError) as caught:
        transition(status, action)
    error = caught.value
    assert error.status_code == 409
    assert error.code == "INVALID_TRANSITION"
    assert error.details == {"from": status, "action": action}


def test_an_unknown_status_or_action_is_refused_the_same_way() -> None:
    for status, action in [("closed", ACCEPT), (ASSIGNED, "teleport")]:
        with pytest.raises(AppError) as caught:
            transition(status, action)
        assert caught.value.code == "INVALID_TRANSITION"


def test_nobody_can_cancel_after_reaching_the_site() -> None:
    for status in (REACHED, IN_PROGRESS, ON_HOLD, COMPLETED):
        with pytest.raises(AppError):
            transition(status, CANCEL)


@pytest.mark.parametrize("status", ASSIGNEE_STATUSES)
def test_with_one_assignee_the_task_has_that_status(status: str) -> None:
    expected = {CANCELLED: ASSIGNED}.get(status, status)
    assert derive_status([status]) == expected


@pytest.mark.parametrize(
    ("statuses", "expected"),
    [
        ([COMPLETED, COMPLETED], COMPLETED),
        # Declined and cancelled people drop out.
        ([COMPLETED, DECLINED], COMPLETED),
        ([COMPLETED, CANCELLED, COMPLETED], COMPLETED),
        ([DECLINED, DECLINED], DECLINED),
        ([DECLINED, CANCELLED], DECLINED),
        ([CANCELLED, CANCELLED], ASSIGNED),
        ([], ASSIGNED),
        # The least advanced active assignee wins.
        ([ASSIGNED, ACCEPTED], ASSIGNED),
        ([ACCEPTED, REACHED, IN_PROGRESS], ACCEPTED),
        ([REACHED, IN_PROGRESS, COMPLETED], REACHED),
        ([COMPLETED, IN_PROGRESS], IN_PROGRESS),
        ([COMPLETED, ON_HOLD], ON_HOLD),
        ([DECLINED, ASSIGNED], ASSIGNED),
        # In progress beats on hold at the same rank, in either order.
        ([IN_PROGRESS, ON_HOLD], IN_PROGRESS),
        ([ON_HOLD, IN_PROGRESS], IN_PROGRESS),
        ([ON_HOLD, ON_HOLD], ON_HOLD),
    ],
)
def test_derived_task_status(statuses: list[str], expected: str) -> None:
    assert derive_status(statuses) == expected
