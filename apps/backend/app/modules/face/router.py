from typing import Annotated, Literal

from fastapi import APIRouter, Depends, File, Query, Request, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.core.errors import AppError
from app.modules.auth.deps import (
    AuthContext,
    authenticated,
    require_active_device,
    require_permission,
)
from app.modules.auth.permissions import FACE_REVIEW
from app.modules.face import service
from app.modules.face.provider import REQUIRED_PHOTOS
from app.modules.face.schemas import (
    Approve,
    EnrollmentDetail,
    EnrollmentItem,
    EnrollmentPage,
    MyEnrollment,
    Reason,
)

router = APIRouter(tags=["face"])

Session = Annotated[AsyncSession, Depends(get_session)]
Reviewer = Annotated[AuthContext, Depends(require_permission(FACE_REVIEW))]
SignedIn = Annotated[AuthContext, Depends(authenticated)]
OnOwnPhone = Annotated[AuthContext, Depends(require_active_device)]


# --- the employee -----------------------------------------------------------------------------


@router.get("/me/face-enrollment", response_model=MyEnrollment)
async def my_face_enrollment(session: Session, auth: SignedIn) -> MyEnrollment:
    return await service.my_status(session, auth.user.id)


@router.post("/me/face-enrollment/consent", response_model=MyEnrollment, status_code=201)
async def consent_to_face_enrollment(
    request: Request, session: Session, auth: OnOwnPhone
) -> MyEnrollment:
    return await service.give_consent(session, auth.audit(request), auth.user)


@router.post("/me/face-enrollment", response_model=MyEnrollment, status_code=201)
async def submit_face_enrollment(
    request: Request,
    session: Session,
    auth: OnOwnPhone,
    photos: Annotated[list[UploadFile], File()],
) -> MyEnrollment:
    # Before any photo is read: a request with a hundred files must not fill memory first.
    if len(photos) != REQUIRED_PHOTOS:
        raise AppError("PHOTO_COUNT", f"Send exactly {REQUIRED_PHOTOS} photos.", 422)
    data: list[bytes] = []
    for photo in photos:
        # One byte past the limit is enough to know it is too big, without reading it all.
        content = await photo.read(service.MAX_PHOTO_BYTES + 1)
        if len(content) > service.MAX_PHOTO_BYTES:
            raise AppError("PHOTO_TOO_LARGE", "Each photo must be 5 MB or smaller.", 413)
        data.append(content)
    state = request.app.state
    return await service.submit(
        session, auth.audit(request), state.s3, state.settings.s3_bucket, auth.user, data
    )


# --- the admin --------------------------------------------------------------------------------


@router.get("/admin/face-enrollments", response_model=EnrollmentPage)
async def list_face_enrollments(
    session: Session,
    actor: Reviewer,
    status: Literal["pending", "approved", "rejected"] = "pending",
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: str | None = None,
) -> EnrollmentPage:
    items, next_cursor = await service.list_enrollments(
        session, actor, status=status, limit=limit, cursor=cursor
    )
    return EnrollmentPage(items=items, next_cursor=next_cursor)


@router.get("/admin/face-enrollments/{enrollment_id}", response_model=EnrollmentDetail)
async def get_face_enrollment(
    enrollment_id: int, request: Request, session: Session, actor: Reviewer
) -> EnrollmentDetail:
    return await service.detail(
        session, actor, actor.audit(request), request.app.state.settings, enrollment_id
    )


@router.post("/admin/face-enrollments/{enrollment_id}/approve", response_model=EnrollmentItem)
async def approve_face_enrollment(
    enrollment_id: int, body: Approve, request: Request, session: Session, actor: Reviewer
) -> EnrollmentItem:
    return await service.approve(
        session, actor, actor.audit(request), enrollment_id, body.submitted_at
    )


@router.post("/admin/face-enrollments/{enrollment_id}/reject", response_model=EnrollmentItem)
async def reject_face_enrollment(
    enrollment_id: int, body: Reason, request: Request, session: Session, actor: Reviewer
) -> EnrollmentItem:
    state = request.app.state
    return await service.reject(
        session,
        actor,
        actor.audit(request),
        state.s3,
        state.settings.s3_bucket,
        enrollment_id,
        body.reason,
    )


@router.post("/admin/face-enrollments/{enrollment_id}/reset", response_model=EnrollmentItem)
async def reset_face_enrollment(
    enrollment_id: int, body: Reason, request: Request, session: Session, actor: Reviewer
) -> EnrollmentItem:
    state = request.app.state
    return await service.reset(
        session,
        actor,
        actor.audit(request),
        state.s3,
        state.settings.s3_bucket,
        enrollment_id,
        body.reason,
    )
