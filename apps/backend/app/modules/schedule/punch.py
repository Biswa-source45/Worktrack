"""Where an employee may punch from on a given day (FR-ATT-04). M4's punch endpoints call this."""

import datetime as dt
from dataclasses import dataclass
from typing import Literal

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.modules.branches.geofence import Candidates, ensure_accuracy, nearest_geofences
from app.modules.employees.models import User
from app.modules.org_settings.service import get_org_settings
from app.modules.schedule.home import home_candidate
from app.modules.schedule.models import DayKind
from app.modules.schedule.service import resolve_day

BRANCH = "branch"


@dataclass(frozen=True)
class PunchPlace:
    type: Literal["branch", "home", "task"]
    # None when the punch is accepted at the home location or at a task site.
    branch_id: int | None
    distance_m: float
    day_kind: DayKind
    # The task whose site accepted a field punch-in (FR-ATT-10).
    task_id: int | None = None


async def check_punch_location(
    session: AsyncSession,
    user: User,
    day: dt.date,
    *,
    lat: float,
    lng: float,
    accuracy_m: float,
    punching_out: bool = False,
    task_sites: Candidates | None = None,
) -> PunchPlace:
    """Accept or refuse a punch position for `day`, and say which fence accepted it.

    Office day: inside a branch fence. Home day: inside the approved home fence or a branch
    fence. An employee restricted to their home branch has only that branch as a candidate.
    A punch-out is never refused for the day type: the person punched in earlier, and a holiday
    added since must not trap them (an off day then has branch fences only). `task_sites` are the
    sites of today's accepted tasks, for a field punch-in: they count as fences too.
    """
    plan = await resolve_day(session, user, day)
    if plan.kind == "off" and not punching_out:
        message = "Today is a holiday." if plan.reason == "holiday" else "Today is your day off."
        raise AppError(
            "OFF_DAY", f"{message} Attendance is not marked.", 409, {"reason": plan.reason}
        )
    settings = await get_org_settings(session)
    ensure_accuracy(settings, accuracy_m)
    fences = await nearest_geofences(
        session,
        settings,
        lat=lat,
        lng=lng,
        accuracy_m=accuracy_m,
        branch_id=user.home_branch_id if user.restrict_to_home_branch else None,
        extra=[
            *([home_candidate(user.id)] if plan.kind == "home" else []),
            *([task_sites] if task_sites is not None else []),
        ],
    )
    branches = [fence for fence in fences if fence.kind == BRANCH]
    # At a branch and at home at once, the branch is the more informative record.
    hit = next((f for f in branches if f.inside), None) or next(
        (f for f in fences if f.inside), None
    )
    if hit is not None:
        at_branch = hit.kind == BRANCH
        return PunchPlace(
            type="branch" if at_branch else "task" if hit.kind == "task" else "home",
            branch_id=hit.id if at_branch else None,
            distance_m=hit.distance_m,
            day_kind=plan.kind,
            task_id=hit.id if hit.kind == "task" else None,
        )
    if user.restrict_to_home_branch and (
        user.home_branch is None or not user.home_branch.is_active
    ):
        raise AppError(
            "HOME_BRANCH_INACTIVE",
            "Your home branch is not active, and you may punch only there. Ask your admin.",
            409,
        )
    # Only the nearest branch is named: nothing about the home location leaves the server.
    nearest = branches[0] if branches else None
    raise AppError(
        "OUTSIDE_GEOFENCE",
        "You are not at an allowed work location."
        if nearest is None
        else f"You are {round(nearest.distance_m)} m from {nearest.name}. Move closer to punch.",
        422,
        None
        if nearest is None
        else {"branch": nearest.name, "distance_m": round(nearest.distance_m)},
    )
