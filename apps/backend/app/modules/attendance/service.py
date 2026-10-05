"""Punch in, punch out and out-of-office punch-out requests (SRS 4.5, 4.6, 5.1, 5.2, 7).

Everything the phone says is re-checked here (invariant 2), the clock is the server's
(invariant 1), and one request id makes a retry or an offline replay the same punch.
"""

import datetime as dt
import logging
import uuid
from typing import TYPE_CHECKING

from geoalchemy2 import Geography, WKTElement
from sqlalchemy import Float, cast, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import storage
from app.core.clock import IST
from app.core.config import Settings
from app.core.errors import AppError
from app.core.security import utcnow
from app.modules.attendance import days
from app.modules.attendance.models import (
    AT_HOME,
    FACE_BORDERLINE,
    FACE_MISMATCH,
    IMPOSSIBLE_JUMP,
    IN,
    OFFLINE,
    OUT,
    OUT_OF_OFFICE,
    OUTSIDE,
    REJECTED,
    REQUEST_PENDING,
    REVIEW_PENDING,
    VERIFIED,
    AttendanceDay,
    PunchEvent,
    PunchException,
    PunchOutRequest,
)
from app.modules.attendance.schemas import (
    DayOut,
    Fix,
    PlaceOut,
    PrecheckOut,
    PunchBrief,
    PunchForm,
    PunchResult,
    TodayOut,
)
from app.modules.audit import service as audit
from app.modules.audit.service import AuditCtx
from app.modules.branches.models import Branch
from app.modules.employees.models import User
from app.modules.face import service as face
from app.modules.face.provider import Decision, Issue
from app.modules.org_settings.schemas import OrgSettings
from app.modules.org_settings.service import get_org_settings
from app.modules.schedule.punch import PunchPlace, check_punch_location
from app.modules.schedule.service import resolve_day

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client

logger = logging.getLogger(__name__)

OUTSIDE_FENCE = "OUTSIDE_GEOFENCE"
# Exception kind for each thing the phone can report about itself.
_INTEGRITY = {"mock": "MOCK_LOCATION", "emulator": "EMULATOR", "rooted": "ROOTED_DEVICE"}
# What the person is told when the selfie cannot be used (SRS 9.7.3: RETAKE, nothing is stored).
RETAKE_TEXT = {
    Issue.UNREADABLE_IMAGE: "The photo could not be read. Take it again.",
    Issue.NO_FACE: "No face was found in the photo. Face the camera and take it again.",
    Issue.MULTIPLE_FACES: "More than one face was in the photo. Take it again, alone.",
    Issue.LOW_CONFIDENCE: "The face was not clear enough. Take it again.",
    Issue.FACE_TOO_SMALL: "Your face was too far from the camera. Move closer and try again.",
    Issue.BLURRY: "The photo was blurry. Hold still and take it again.",
    Issue.TOO_DARK: "The photo was too dark. Move to a brighter place and try again.",
    Issue.TOO_BRIGHT: "The photo was too bright. Avoid direct light and try again.",
}


def _point(lat: float, lng: float) -> WKTElement:
    return WKTElement(f"POINT({lng} {lat})", srid=4326)


def mock_location_allowed(settings: Settings) -> bool:
    """The development switch (invariant 8). Production refuses to start with it on."""
    return settings.allow_mock_location and settings.app_env == "development"


def _exception(
    session: AsyncSession,
    user_id: int,
    kind: str,
    *,
    nearest: str | None = None,
    distance_m: float | None = None,
    event: PunchEvent | None = None,
    details: dict[str, object] | None = None,
) -> None:
    """A row for the exceptions feed. It holds no coordinates (invariant 3)."""
    session.add(
        PunchException(
            user_id=user_id,
            kind=kind,
            nearest_branch=nearest,
            distance_m=None if distance_m is None else round(distance_m),
            punch_event_id=None if event is None else event.id,
            details=details,
        )
    )


async def _refuse(session: AsyncSession, error: AppError) -> AppError:
    """Save the exception rows added so far (they must outlive the failed request), then hand
    back the error to raise."""
    await session.commit()
    return error


# --- reading -----------------------------------------------------------------------------------


def _place(event: PunchEvent, branch_name: str | None) -> PlaceOut:
    if event.location_type == AT_HOME:
        return PlaceOut(type="home")
    return PlaceOut(
        type=event.location_type,
        branch=branch_name,
        distance_m=None if event.distance_m is None else round(event.distance_m),
    )


async def _brief(session: AsyncSession, event: PunchEvent) -> PunchBrief:
    name = None
    if (branch_id := event.branch_id or event.nearest_branch_id) is not None:
        branch = await session.get(Branch, branch_id)
        name = branch.name if branch else None
    return PunchBrief(
        id=event.id,
        type=event.type,
        time=event.effective_time,
        review_status=event.review_status,
        in_review=event.review_status == REVIEW_PENDING,
        out_of_office=OUT_OF_OFFICE in event.review_reasons,
        offline=event.offline,
        place=_place(event, name),
    )


def day_out(day: AttendanceDay) -> DayOut:
    return DayOut(
        id=day.id,
        date=day.date,
        status=day.status,
        first_in_at=day.first_in_at,
        last_out_at=day.last_out_at,
        worked_minutes=day.worked_minutes,
        late_minutes=day.late_minutes,
        overtime_minutes=day.overtime_minutes,
        flags=list(day.flags),
    )


async def _result(session: AsyncSession, event: PunchEvent, *, replayed: bool) -> PunchResult:
    day = (
        await session.execute(
            select(AttendanceDay)
            .where(AttendanceDay.id == event.attendance_day_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    return PunchResult(
        punch=await _brief(session, event),
        day=day_out(day),
        result="verified" if event.review_status == VERIFIED else "in_review",
        replayed=replayed,
    )


async def _find(session: AsyncSession, user_id: int, request_id: uuid.UUID) -> PunchEvent | None:
    return await session.scalar(
        select(PunchEvent).where(PunchEvent.user_id == user_id, PunchEvent.request_id == request_id)
    )


# --- the punch ---------------------------------------------------------------------------------


async def _locate(
    session: AsyncSession, user: User, day: dt.date, form: Fix, *, punching_out: bool
) -> PunchPlace | AppError:
    """The fence that accepts the position, or the OUTSIDE_GEOFENCE error (returned, not raised,
    because a punch-out from outside is a request). Any other refusal (accuracy, off day) raises."""
    try:
        return await check_punch_location(
            session,
            user,
            day,
            lat=form.lat,
            lng=form.lng,
            accuracy_m=form.accuracy_m,
            punching_out=punching_out,
        )
    except AppError as error:
        if error.code == OUTSIDE_FENCE:
            return error
        raise


async def _branch_id(session: AsyncSession, name: str | None) -> int | None:
    """Branch names are unique (case-insensitively), so the name in the error finds the branch."""
    if name is None:
        return None
    return await session.scalar(select(Branch.id).where(func.lower(Branch.name) == name.lower()))


def _outside_details(error: AppError) -> tuple[str | None, float | None]:
    details = error.details if isinstance(error.details, dict) else {}
    return details.get("branch"), details.get("distance_m")


async def _jumped(
    session: AsyncSession, user_id: int, form: Fix, now: dt.datetime, settings: OrgSettings
) -> bool:
    """SRS 7: faster than `punch_max_speed_kmh` from the last punch, over more than 200 m."""
    here = cast(func.ST_SetSRID(func.ST_MakePoint(form.lng, form.lat), 4326), Geography)
    last = (
        await session.execute(
            select(PunchEvent.server_time, func.ST_Distance(PunchEvent.location, here, type_=Float))
            .where(PunchEvent.user_id == user_id, PunchEvent.review_status != REJECTED)
            .order_by(PunchEvent.id.desc())
            .limit(1)
        )
    ).first()
    if last is None:
        return False
    metres = float(last[1])
    hours = max((now - last[0]).total_seconds(), 1.0) / 3600
    return metres > 200 and metres / 1000 / hours > settings.punch_max_speed_kmh


def _check_offline(form: PunchForm, now: dt.datetime, settings: OrgSettings) -> None:
    """An offline punch must say when the phone took it, recently and on today's IST date. The
    counted time is still the server's, so this only keeps old punches out (D69)."""
    if not form.offline:
        return
    taken = form.device_time
    if taken is None:
        raise AppError("OFFLINE_TIME_MISSING", "An offline punch needs the time it was taken.", 422)
    age = now - taken
    max_age = dt.timedelta(hours=settings.offline_punch_max_age_hours)
    if age > max_age or taken.astimezone(IST).date() != now.astimezone(IST).date():
        raise AppError(
            "OFFLINE_PUNCH_TOO_OLD",
            "This punch was taken too long ago to be sent. Ask your admin to correct the day.",
            409,
        )


async def punch(
    session: AsyncSession,
    ctx: AuditCtx,
    app_settings: Settings,
    s3: "S3Client",
    bucket: str,
    user: User,
    *,
    kind: str,
    request_id: uuid.UUID,
    form: PunchForm,
    selfie: bytes,
    reason: str | None = None,
    note: str | None = None,
) -> PunchResult:
    """`kind` is "in", "out", or "request" (a punch-out from outside every fence)."""
    wants = IN if kind == IN else OUT
    existing = await _find(session, user.id, request_id)
    if existing is not None:
        return await _replay(session, existing, wants, kind)

    now = utcnow()
    today = now.astimezone(IST).date()
    org = await get_org_settings(session)
    _check_offline(form, now, org)

    flags = {"mock": form.mocked, "emulator": form.emulator, "rooted": form.rooted}
    raised = [name for name, on in flags.items() if on]
    if raised and not mock_location_allowed(app_settings):
        for name in raised:
            _exception(session, user.id, _INTEGRITY[name])
        mock = "mock" in raised
        raise await _refuse(
            session,
            AppError(
                "MOCK_LOCATION" if mock else "DEVICE_NOT_TRUSTED",
                "A mock location app is on. Turn it off and try again."
                if mock
                else "Punching is not allowed on a rooted phone or an emulator.",
                403,
            ),
        )

    shift = user.shift
    if shift is None:
        raise AppError("NO_SHIFT", "No shift is assigned to you. Ask your admin.", 409)
    if days.is_closed(today, now, org):
        raise AppError("DAY_CLOSED", "Today's attendance is closed.", 409)
    await face.ensure_face_approved(session, user.id)

    try:
        located = await _locate(session, user, today, form, punching_out=wants == OUT)
    except AppError as error:
        if error.code == "GPS_ACCURACY_POOR":
            _exception(session, user.id, error.code, details={"accuracy_m": form.accuracy_m})
            raise await _refuse(session, error) from None
        raise
    place: PunchPlace | None = None
    nearest: str | None = None
    distance: float | None = None
    if isinstance(located, AppError):
        nearest, distance = _outside_details(located)
        if kind != "request":
            _exception(session, user.id, OUTSIDE_FENCE, nearest=nearest, distance_m=distance)
            raise await _refuse(session, located)
    else:
        place = located
        if kind == "request":
            raise AppError("USE_PUNCH_OUT", "You are at a work location. Punch out normally.", 409)

    # From here on the person's day is locked: two punches of one person queue up.
    day = await days.lock_day(session, user.id, today, shift.id)
    existing = await _find(session, user.id, request_id)
    if existing is not None:  # the same request, sent twice at once: the first one won
        return await _replay(session, existing, wants, kind)
    events = [e for e in await days.day_events(session, day.id) if e.review_status != REJECTED]
    _check_state(events, wants)

    jumped = not form.offline and await _jumped(session, user.id, form, now, org)
    check = await face.verify_face(session, user.id, selfie)
    if check.decision == Decision.RETAKE or check.score is None or check.jpeg is None:
        issue = check.issue or Issue.UNREADABLE_IMAGE
        raise AppError("FACE_RETAKE", RETAKE_TEXT[issue], 422, {"issue": issue.value})

    reasons: list[str] = []
    if check.decision == Decision.PENDING_REVIEW:
        reasons.append(FACE_BORDERLINE)
    elif check.decision == Decision.MISMATCH:
        reasons.append(FACE_MISMATCH)
    if form.offline:
        reasons.append(OFFLINE)
    if jumped:
        reasons.append(IMPOSSIBLE_JUMP)
    if kind == "request":
        reasons.append(OUT_OF_OFFICE)

    key = f"punch/{user.id}/{request_id}.jpg"
    await storage.put(s3, bucket, key, check.jpeg)
    event = PunchEvent(
        attendance_day_id=day.id,
        user_id=user.id,
        type=wants,
        request_id=request_id,
        server_time=now,
        effective_time=now,
        device_time=form.device_time,
        location=_point(form.lat, form.lng),
        accuracy_m=form.accuracy_m,
        location_type=OUTSIDE if place is None else place.type,
        branch_id=None if place is None else place.branch_id,
        nearest_branch_id=await _branch_id(session, nearest) if place is None else None,
        distance_m=distance if place is None else place.distance_m,
        selfie_key=key,
        face_score=check.score,
        face_decision=check.decision.value,
        face_model_version=check.model_version,
        thresholds_used={"verify": check.thresholds.verify, "review": check.thresholds.review},
        integrity_flags=raised,
        offline=form.offline,
        review_status=REVIEW_PENDING if reasons else VERIFIED,
        review_reasons=reasons,
    )
    try:
        async with session.begin_nested():
            session.add(event)
            await session.flush()
    except IntegrityError:
        await _drop_selfie(s3, bucket, key)
        raise
    if kind == "request":
        session.add(
            PunchOutRequest(
                punch_event_id=event.id,
                reason=reason or "",
                note=note,
                status=REQUEST_PENDING,
                expires_at=now + dt.timedelta(hours=org.punch_out_request_expiry_hours),
            )
        )
        await session.flush()
    await days.recompute(session, day, days.shift_rules(shift), now, org)

    for name in raised:  # only reachable with the development switch on
        _exception(session, user.id, _INTEGRITY[name], event=event)
    if jumped:
        _exception(session, user.id, "IMPOSSIBLE_JUMP", event=event)
    if check.decision == Decision.MISMATCH:
        _exception(session, user.id, "FACE_MISMATCH", event=event)
    audit.record(
        session,
        ctx,
        {"in": "punch.in", "out": "punch.out", "request": "punch_out_request.create"}[kind],
        "punch_event",
        event.id,
        after={
            "user_id": user.id,
            "date": today.isoformat(),
            "type": event.type,
            "location_type": event.location_type,
            "branch_id": event.branch_id,
            "review_status": event.review_status,
            "review_reasons": reasons,
            "face_decision": event.face_decision,
            "offline": event.offline,
            "integrity_flags": raised,
        },
    )
    await session.commit()
    return await _result(session, event, replayed=False)


async def _drop_selfie(s3: "S3Client", bucket: str, key: str) -> None:
    try:
        await storage.delete(s3, bucket, [key])
    except Exception:  # best effort: the punch itself already failed
        logger.exception("could not delete an unused selfie")


async def _replay(
    session: AsyncSession, existing: PunchEvent, wants: str, kind: str
) -> PunchResult:
    """The same request id again: answer with what happened the first time, change nothing."""
    is_request = OUT_OF_OFFICE in existing.review_reasons
    if existing.type != wants or is_request != (kind == "request"):
        raise AppError(
            "IDEMPOTENCY_KEY_REUSED", "This request id was already used for a different punch.", 409
        )
    return await _result(session, existing, replayed=True)


def _check_state(events: list[PunchEvent], wants: str) -> None:
    ins = [e for e in events if e.type == IN]
    outs = [e for e in events if e.type == OUT]
    if wants == IN:
        if ins:
            raise AppError("ALREADY_PUNCHED_IN", "You have already punched in today.", 409)
        return
    if not ins:
        raise AppError("NOT_PUNCHED_IN", "You have not punched in today.", 409)
    if outs:
        waiting = any(
            OUT_OF_OFFICE in e.review_reasons and e.review_status == REVIEW_PENDING for e in outs
        )
        raise AppError(
            "ALREADY_PUNCHED_OUT",
            "Your punch-out request is waiting for approval."
            if waiting
            else "You have already punched out today.",
            409,
        )


# --- the Home screen ---------------------------------------------------------------------------


async def _today_state(
    session: AsyncSession, user: User, now: dt.datetime
) -> tuple[AttendanceDay | None, list[PunchEvent]]:
    day = await session.scalar(
        select(AttendanceDay)
        .where(AttendanceDay.user_id == user.id, AttendanceDay.date == now.astimezone(IST).date())
        .execution_options(populate_existing=True)
    )
    events = [] if day is None else await days.day_events(session, day.id)
    return day, [e for e in events if e.review_status != REJECTED]


def _action(events: list[PunchEvent]) -> tuple[str, str | None]:
    """What the person can do now, or why nothing."""
    ins = [e for e in events if e.type == IN]
    outs = [e for e in events if e.type == OUT]
    if not ins:
        return "punch_in", None
    if not outs:
        return "punch_out", None
    waiting = any(
        OUT_OF_OFFICE in e.review_reasons and e.review_status == REVIEW_PENDING for e in outs
    )
    return "none", "request_pending" if waiting else "done"


async def today(session: AsyncSession, user: User) -> TodayOut:
    """Server time, today's plan and punches, and the one action the Home card should offer."""
    now = utcnow()
    local = now.astimezone(IST)
    plan = await resolve_day(session, user, local.date())
    day, events = await _today_state(session, user, now)
    action, blocked = _action(events)
    org = await get_org_settings(session)
    if action == "punch_in":
        if plan.kind == "off":
            action, blocked = "none", "off_day"
        elif user.shift is None:
            action, blocked = "none", "no_shift"
        elif days.is_closed(local.date(), now, org):
            action, blocked = "none", "day_closed"
    if (
        action != "none"
        and blocked is None
        and day is not None
        and day.status == "missed_punch_out"
    ):
        action, blocked = "none", "day_closed"
    if action != "none" and not await _face_ready(session, user.id):
        action, blocked = "none", "face_not_approved"
    first_in = next((e for e in events if e.type == IN), None)
    so_far = (
        int((now - first_in.effective_time).total_seconds() // 60)
        if action == "punch_out" and first_in
        else None
    )
    return TodayOut(
        server_time=now,
        date=local.date(),
        kind=plan.kind,
        reason=plan.reason,
        shift=user.shift.name if user.shift else None,
        shift_start=user.shift.start_time if user.shift else None,
        shift_end=user.shift.end_time if user.shift else None,
        day=None if day is None else day_out(day),
        punches=[await _brief(session, e) for e in events],
        action=action,
        blocked=blocked,
        minutes_so_far=so_far,
    )


async def _face_ready(session: AsyncSession, user_id: int) -> bool:
    try:
        await face.ensure_face_approved(session, user_id)
    except AppError:
        return False
    return True


async def precheck(session: AsyncSession, user: User, fix: Fix) -> PrecheckOut:
    """Before the camera opens: would a punch from here be accepted, and what is the person
    allowed to do? Nothing is stored."""
    now = utcnow()
    today_date = now.astimezone(IST).date()
    _, events = await _today_state(session, user, now)
    action, _ = _action(events)
    if action == "none":
        return PrecheckOut(
            allowed=False, action="none", place=None, nearest_branch=None, distance_m=None,
            code="NOTHING_TO_PUNCH", message="There is nothing left to punch today.",
        )  # fmt: skip
    try:
        located = await _locate(session, user, today_date, fix, punching_out=action == "punch_out")
    except AppError as error:
        return PrecheckOut(
            allowed=False, action=action,
            place=None, nearest_branch=None, distance_m=None,
            code=error.code, message=error.message, details=error.details,
        )  # fmt: skip
    if not isinstance(located, AppError):
        place = located
        name = None
        if place.branch_id is not None:
            branch = await session.get(Branch, place.branch_id)
            name = branch.name if branch else None
        metres = None if place.type == AT_HOME else round(place.distance_m)
        return PrecheckOut(
            allowed=True,
            action=action,
            place=PlaceOut(type=place.type, branch=name, distance_m=metres),
            nearest_branch=name,
            distance_m=metres,
        )
    outside = located
    nearest, distance = _outside_details(outside)
    out_ok = (
        action == "punch_out"
    )  # outside a fence: a punch-in is refused, a punch-out is a request
    return PrecheckOut(
        allowed=out_ok,
        action="request_punch_out" if out_ok else action,
        place=PlaceOut(type="outside", branch=nearest, distance_m=distance) if out_ok else None,
        nearest_branch=nearest,
        distance_m=None if distance is None else round(distance),
        code=None if out_ok else outside.code,
        message=None if out_ok else outside.message,
        details=None if out_ok else outside.details,
    )
