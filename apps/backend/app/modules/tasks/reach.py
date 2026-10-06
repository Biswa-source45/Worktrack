"""I have reached (FR-TASK-05, US-5.3) and the assigner's review of a Reached that was flagged.

The phone's verdict is never trusted (invariant 2): the distance to the site and the face match
are measured here, with the same rules and thresholds as a punch. Work is never blocked by a doubt:
a position outside the site with a reason, a borderline or mismatched face, or an impossible jump
are recorded as flags, and the Reached waits for the assigner's review.
"""

import datetime as dt
import uuid
from typing import TYPE_CHECKING

from geoalchemy2 import Geography
from sqlalchemy import Float, cast, func, select, union_all
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.errors import AppError
from app.core.security import utcnow
from app.modules.attendance.models import PunchEvent
from app.modules.attendance.service import (
    INTEGRITY_KINDS,
    RETAKE_TEXT,
    mock_location_allowed,
    record_exception,
    refuse,
    too_fast,
)
from app.modules.audit import service as audit
from app.modules.audit.service import AuditCtx
from app.modules.auth.deps import AuthContext
from app.modules.branches import geofence
from app.modules.face import service as face
from app.modules.face.provider import Decision, Issue
from app.modules.org_settings.schemas import OrgSettings
from app.modules.org_settings.service import get_org_settings
from app.modules.tasks import actions, service
from app.modules.tasks import lifecycle as lc
from app.modules.tasks.media import uploads
from app.modules.tasks.models import ReachFlag, TaskAssignee
from app.modules.tasks.schemas import ActionForm, ActionOut, ReachedForm, ReachReviewIn
from app.modules.tasks.sites import site_candidate

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client


async def _jumped(
    session: AsyncSession, user_id: int, form: ReachedForm, now: dt.datetime, org: OrgSettings
) -> bool:
    """SRS 7, against the person's last known point: their last counted punch or last Reached,
    whichever is newer."""
    here = cast(func.ST_SetSRID(func.ST_MakePoint(form.lng, form.lat), 4326), Geography)
    punch = (
        select(
            PunchEvent.server_time.label("at"),
            func.ST_Distance(PunchEvent.location, here, type_=Float).label("metres"),
        )
        .where(PunchEvent.user_id == user_id, PunchEvent.review_status != "rejected")
        .order_by(PunchEvent.id.desc())
        .limit(1)
        .subquery()
    )
    earlier = (
        select(
            TaskAssignee.reached_at.label("at"),
            func.ST_Distance(TaskAssignee.reached_location, here, type_=Float).label("metres"),
        )
        .where(TaskAssignee.user_id == user_id, TaskAssignee.reached_at.is_not(None))
        .order_by(TaskAssignee.reached_at.desc())
        .limit(1)
        .subquery()
    )
    both = union_all(select(punch.c.at, punch.c.metres), select(earlier.c.at, earlier.c.metres))
    newest = both.subquery()
    last = (
        await session.execute(
            select(newest.c.at, newest.c.metres).order_by(newest.c.at.desc()).limit(1)
        )
    ).first()
    return last is not None and too_fast(float(last.metres), last.at, now, org)


async def reached(
    session: AsyncSession,
    ctx: AuditCtx,
    app_settings: Settings,
    s3: "S3Client",
    actor: AuthContext,
    task_id: int,
    key: uuid.UUID,
    form: ReachedForm,
    selfie: bytes,
) -> ActionOut:
    user = actor.user
    task, mine, assignees = await actions.own_row(session, actor, task_id)
    if await service.replay_of(session, user.id, key, task.id, {"reached"}):
        return await service.finish(session, app_settings, actor, task, replayed=True)
    lc.transition(mine.status, lc.REACH)  # only after accepting
    now = utcnow()
    org = await get_org_settings(session)
    service.check_offline(form.offline, form.device_time, now, org)

    flags = {"mock": form.mocked, "emulator": form.emulator, "rooted": form.rooted}
    raised = [name for name, on in flags.items() if on]
    if raised and not mock_location_allowed(app_settings):
        for name in raised:
            record_exception(session, user.id, INTEGRITY_KINDS[name], details={"task": task.code})
        mock = "mock" in raised
        raise await refuse(
            session,
            AppError(
                "MOCK_LOCATION" if mock else "DEVICE_NOT_TRUSTED",
                "A mock location app is on. Turn it off and try again."
                if mock
                else "This cannot be done on a rooted phone or an emulator.",
                403,
            ),
        )
    try:
        geofence.ensure_accuracy(org, form.accuracy_m)
    except AppError as error:
        record_exception(
            session,
            user.id,
            error.code,
            details={"accuracy_m": form.accuracy_m, "task": task.code},
        )
        raise await refuse(session, error) from None
    await face.ensure_face_approved(session, user.id)

    [site] = await geofence.nearest_geofences(
        session,
        org,
        lat=form.lat,
        lng=form.lng,
        accuracy_m=form.accuracy_m,
        extra=site_candidate(task.id),
        only_extra=True,
    )
    distance = float(site.distance_m)
    outside = not site.inside
    if outside and form.mismatch_reason is None:
        raise AppError(
            "OUTSIDE_SITE",
            f"You are {round(distance)} m from the site. Go to the site, or send this as a "
            "location mismatch with a reason.",
            422,
            {"distance_m": round(distance), "radius_m": task.site_radius_m},
        )

    jumped = not form.offline and await _jumped(session, user.id, form, now, org)
    check = await face.verify_face(session, user.id, selfie)
    if check.decision == Decision.RETAKE or check.score is None or check.jpeg is None:
        issue = check.issue or Issue.UNREADABLE_IMAGE
        raise AppError("FACE_RETAKE", RETAKE_TEXT[issue], 422, {"issue": issue.value})

    reasons: list[ReachFlag] = []
    if outside:
        reasons.append("location_mismatch")
    if check.decision != Decision.VERIFIED:
        reasons.append("face_review")
    if jumped:
        reasons.append("impossible_jump")

    async with uploads(s3, app_settings.s3_bucket) as stored:
        selfie_key = await stored.put_as(f"task/{user.id}/{key}.jpg", check.jpeg)
        event = service.add_event(
            session,
            task,
            "reached",
            actor_id=user.id,
            now=now,
            subject_id=user.id,
            note=form.mismatch_reason if outside else None,
            form=ActionForm(
                lat=form.lat,
                lng=form.lng,
                accuracy_m=form.accuracy_m,
                device_time=form.device_time,
                offline=form.offline,
            ),
            key=key,
        )
        mine.status = lc.REACHED
        mine.reached_at = now
        mine.reached_location = service.point(form.lat, form.lng)
        mine.reached_accuracy_m = form.accuracy_m
        mine.reached_distance_m = distance
        mine.reached_selfie_key = selfie_key
        mine.reached_face_score = check.score
        mine.reached_face_decision = check.decision.value
        mine.reach_flags = reasons
        mine.reach_reason = form.mismatch_reason if outside else None
        mine.reach_review = "pending" if reasons else "none"
        service.recompute(task, assignees)
        for name in raised:  # only reachable with the development switch on
            record_exception(session, user.id, INTEGRITY_KINDS[name], details={"task": task.code})
        if outside:
            record_exception(
                session,
                user.id,
                "OUTSIDE_GEOFENCE",
                distance_m=distance,
                details={"task": task.code},
            )
        if jumped:
            record_exception(session, user.id, "IMPOSSIBLE_JUMP", details={"task": task.code})
        if check.decision == Decision.MISMATCH:
            record_exception(session, user.id, "FACE_MISMATCH", details={"task": task.code})
        flagged = bool(reasons)
        await service.notify(
            session,
            user.id,
            task.created_by,
            "task_reach_mismatch" if flagged else "task_reached",
            f"{user.name} reached {task.code}" + (" (needs review)" if flagged else ""),
            f"{user.name} reached the site of {task.title}"
            + (f" with a flag: {', '.join(reasons)}" if flagged else ""),
            task,
            event,
        )
        audit.record(
            session,
            ctx,
            "task.reached",
            "task",
            task.id,
            before={"status": lc.ACCEPTED},
            after={
                "status": lc.REACHED,
                "flags": reasons,
                "distance_m": round(distance),
                "face_decision": check.decision.value,
                "offline": form.offline,
            },
        )
        await session.commit()
    return await service.finish(session, app_settings, actor, task, replayed=False)


async def review(
    session: AsyncSession,
    ctx: AuditCtx,
    settings: Settings,
    actor: AuthContext,
    task_id: int,
    user_id: int,
    key: uuid.UUID,
    body: ReachReviewIn,
) -> ActionOut:
    """Approve or reject a flagged Reached. Nobody reviews their own (as in D72)."""
    task = await service.locked_managed(session, actor, task_id)
    if await service.replay_of(session, actor.user.id, key, task.id, {"reach_reviewed"}):
        return await service.finish(session, settings, actor, task, replayed=True)
    if user_id == actor.user.id:
        raise AppError("CANNOT_DECIDE_OWN", "You cannot review your own Reached.", 403)
    assignees = await service.assignees_of(session, task.id)
    row = next((a for a in assignees if a.user_id == user_id), None)
    if row is None:
        raise AppError("NOT_ASSIGNED", "That person is not on this task.", 404)
    if row.reach_review != "pending":
        raise AppError("ALREADY_DECIDED", "This Reached has no review waiting.", 409)
    if body.decision == "reject" and not body.remarks:
        raise AppError("REMARKS_REQUIRED", "Give a reason for rejecting.", 422)
    now = utcnow()
    row.reach_review = "approved" if body.decision == "approve" else "rejected"
    row.reach_reviewed_by, row.reach_reviewed_at = actor.user.id, now
    row.reach_review_remarks = body.remarks
    service.add_event(
        session,
        task,
        "reach_reviewed",
        actor_id=actor.user.id,
        now=now,
        subject_id=user_id,
        note=f"{row.reach_review}" + (f": {body.remarks}" if body.remarks else ""),
        key=key,
    )
    audit.record(
        session,
        ctx,
        "task.reach_review",
        "task",
        task.id,
        before={"user_id": user_id, "review": "pending"},
        after={"review": row.reach_review, "remarks": body.remarks},
    )
    await session.commit()
    return await service.finish(session, settings, actor, task, replayed=False)
