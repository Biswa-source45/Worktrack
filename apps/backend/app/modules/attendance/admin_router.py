import datetime as dt
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import today_ist
from app.core.db import get_session
from app.modules.attendance import admin, history
from app.modules.attendance.admin_schemas import (
    DayDetail,
    ExceptionPage,
    MonthOut,
    OverrideIn,
    OverrideResult,
    RegisterPage,
    RequestDecision,
    RequestDetail,
    RequestItem,
    RequestPage,
    ReviewDecision,
    ReviewDetail,
    ReviewItem,
    ReviewPage,
)
from app.modules.auth.deps import (
    AuthContext,
    authenticated,
    require_any_permission,
    require_permission,
)
from app.modules.auth.permissions import (
    ATTENDANCE_OVERRIDE,
    ATTENDANCE_VIEW_ALL,
    FACE_REVIEW,
    PUNCHOUT_APPROVE,
    TEAM_VIEW,
)

router = APIRouter(tags=["attendance"])

Session = Annotated[AsyncSession, Depends(get_session)]
SignedIn = Annotated[AuthContext, Depends(authenticated)]
# A manager sees their own team's register; an admin sees everyone's.
Viewer = Annotated[AuthContext, Depends(require_any_permission(ATTENDANCE_VIEW_ALL, TEAM_VIEW))]
AllViewer = Annotated[AuthContext, Depends(require_permission(ATTENDANCE_VIEW_ALL))]
Overrider = Annotated[AuthContext, Depends(require_permission(ATTENDANCE_OVERRIDE))]
Approver = Annotated[AuthContext, Depends(require_permission(PUNCHOUT_APPROVE))]
Reviewer = Annotated[AuthContext, Depends(require_permission(FACE_REVIEW))]
Limit = Annotated[int, Query(ge=1, le=200)]

RegisterStatus = Literal[
    "working",
    "present",
    "half_day",
    "short_hours",
    "absent",
    "holiday",
    "weekly_off",
    "pending",
    "missed_punch_out",
    "leave",
    "work_from_home",
    "on_duty",
    "no_record",
]
ExceptionKind = Literal[
    "MOCK_LOCATION",
    "ROOTED_DEVICE",
    "EMULATOR",
    "OUTSIDE_GEOFENCE",
    "GPS_ACCURACY_POOR",
    "IMPOSSIBLE_JUMP",
    "FACE_MISMATCH",
]
RequestFilter = Literal["waiting", "pending", "pending_admin", "approved", "rejected", "expired"]
ReviewReason = Literal["face_borderline", "face_mismatch", "offline", "impossible_jump"]


@router.get("/attendance/me", response_model=MonthOut)
async def my_month(
    session: Session,
    auth: SignedIn,
    month: Annotated[str | None, Query(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")] = None,
) -> MonthOut:
    """`month` is YYYY-MM; omitted, this month."""
    return await history.my_month(session, auth.user, month or f"{today_ist():%Y-%m}")


# --- register ----------------------------------------------------------------------------------


@router.get("/admin/attendance", response_model=RegisterPage)
async def register(
    session: Session,
    actor: Viewer,
    date: dt.date | None = None,
    branch_id: int | None = None,
    status: RegisterStatus | None = None,
    q: Annotated[str | None, Query(max_length=100)] = None,
    limit: Limit = 50,
    cursor: str | None = None,
) -> RegisterPage:
    return await admin.register(
        session,
        actor,
        day=date or today_ist(),
        branch_id=branch_id,
        status=status,
        q=q,
        limit=limit,
        cursor=cursor,
    )


@router.get("/admin/attendance/{day_id}", response_model=DayDetail)
async def day_detail(day_id: int, request: Request, session: Session, actor: Viewer) -> DayDetail:
    return await admin.day_detail(
        session, actor, actor.audit(request), request.app.state.settings, day_id
    )


@router.post("/admin/attendance/overrides", response_model=OverrideResult, status_code=201)
async def override(
    body: OverrideIn, request: Request, session: Session, actor: Overrider
) -> OverrideResult:
    return await admin.override(session, actor, actor.audit(request), body)


# --- punch-out requests ------------------------------------------------------------------------


@router.get("/admin/punch-out-requests", response_model=RequestPage)
async def list_requests(
    session: Session,
    actor: Approver,
    status: RequestFilter = "waiting",
    limit: Limit = 50,
    cursor: str | None = None,
) -> RequestPage:
    return await admin.list_requests(session, actor, status=status, limit=limit, cursor=cursor)


@router.get("/admin/punch-out-requests/{request_id}", response_model=RequestDetail)
async def request_detail(
    request_id: int, request: Request, session: Session, actor: Approver
) -> RequestDetail:
    return await admin.request_detail(
        session, actor, actor.audit(request), request.app.state.settings, request_id
    )


@router.patch("/admin/punch-out-requests/{request_id}/decision", response_model=RequestItem)
async def decide_request(
    request_id: int, body: RequestDecision, request: Request, session: Session, actor: Approver
) -> RequestItem:
    return await admin.decide_request(session, actor, actor.audit(request), request_id, body)


# --- punch reviews -----------------------------------------------------------------------------


@router.get("/admin/punch-reviews", response_model=ReviewPage)
async def list_reviews(
    session: Session,
    actor: Reviewer,
    status: Literal["pending", "approved", "rejected"] = "pending",
    reason: ReviewReason | None = None,
    limit: Limit = 50,
    cursor: str | None = None,
) -> ReviewPage:
    return await admin.list_reviews(
        session, actor, status=status, reason=reason, limit=limit, cursor=cursor
    )


@router.get("/admin/punch-reviews/{event_id}", response_model=ReviewDetail)
async def review_detail(
    event_id: int, request: Request, session: Session, actor: Reviewer
) -> ReviewDetail:
    return await admin.review_detail(
        session, actor, actor.audit(request), request.app.state.settings, event_id
    )


@router.post("/admin/punch-reviews/{event_id}/decision", response_model=ReviewItem)
async def decide_review(
    event_id: int, body: ReviewDecision, request: Request, session: Session, actor: Reviewer
) -> ReviewItem:
    return await admin.decide_review(session, actor, actor.audit(request), event_id, body)


# --- exceptions --------------------------------------------------------------------------------


@router.get("/admin/attendance-exceptions", response_model=ExceptionPage)
async def list_exceptions(
    session: Session,
    actor: AllViewer,
    kind: ExceptionKind | None = None,
    from_date: dt.date | None = None,
    to_date: dt.date | None = None,
    limit: Limit = 50,
    cursor: str | None = None,
) -> ExceptionPage:
    return await admin.list_exceptions(
        session, kind=kind, from_date=from_date, to_date=to_date, limit=limit, cursor=cursor
    )
