import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, Header, Request, UploadFile
from pydantic import AwareDatetime
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.core.errors import AppError
from app.modules.attendance import service
from app.modules.attendance.schemas import (
    Fix,
    Note,
    PrecheckOut,
    PunchForm,
    PunchResult,
    Reason,
    RequestForm,
    TodayOut,
)
from app.modules.auth.deps import AuthContext, authenticated, require_active_device
from app.modules.branches.schemas import Lat, Lng
from app.modules.face.service import MAX_PHOTO_BYTES

router = APIRouter(tags=["attendance"])

Session = Annotated[AsyncSession, Depends(get_session)]
SignedIn = Annotated[AuthContext, Depends(authenticated)]
OnOwnPhone = Annotated[AuthContext, Depends(require_active_device)]
# The client makes one id per punch; a retry or an offline replay sends the same one.
IdempotencyKey = Annotated[uuid.UUID, Header(alias="Idempotency-Key")]
Selfie = Annotated[UploadFile, File()]


# The text fields travel as multipart form fields next to the selfie. (A Form model cannot share a
# request with a File parameter.)
def _punch_form(
    lat: Annotated[Lat, Form()],
    lng: Annotated[Lng, Form()],
    accuracy_m: Annotated[float, Form(ge=0, le=100_000)],
    device_time: Annotated[AwareDatetime | None, Form()] = None,
    mocked: Annotated[bool, Form()] = False,
    emulator: Annotated[bool, Form()] = False,
    rooted: Annotated[bool, Form()] = False,
    offline: Annotated[bool, Form()] = False,
) -> PunchForm:
    return PunchForm(
        lat=lat,
        lng=lng,
        accuracy_m=accuracy_m,
        device_time=device_time,
        mocked=mocked,
        emulator=emulator,
        rooted=rooted,
        offline=offline,
    )


def _request_form(
    form: Annotated[PunchForm, Depends(_punch_form)],
    reason: Annotated[Reason, Form()],
    note: Annotated[Note | None, Form()] = None,
) -> RequestForm:
    return RequestForm(**form.model_dump(), reason=reason, note=note or None)


Punched = Annotated[PunchForm, Depends(_punch_form)]
Requested = Annotated[RequestForm, Depends(_request_form)]


async def _read(selfie: UploadFile) -> bytes:
    # One byte past the limit is enough to know it is too big, without reading it all.
    content = await selfie.read(MAX_PHOTO_BYTES + 1)
    if len(content) > MAX_PHOTO_BYTES:
        raise AppError("PHOTO_TOO_LARGE", "The photo must be 5 MB or smaller.", 413)
    return content


async def _punch(
    kind: str,
    request: Request,
    session: AsyncSession,
    auth: AuthContext,
    key: uuid.UUID,
    form: PunchForm,
    selfie: UploadFile,
    *,
    reason: str | None = None,
    note: str | None = None,
) -> PunchResult:
    state = request.app.state
    return await service.punch(
        session,
        auth.audit(request),
        state.settings,
        state.s3,
        state.settings.s3_bucket,
        auth.user,
        kind=kind,
        request_id=key,
        form=form,
        selfie=await _read(selfie),
        reason=reason,
        note=note,
    )


@router.get("/attendance/today", response_model=TodayOut)
async def today(session: Session, auth: SignedIn) -> TodayOut:
    return await service.today(session, auth.user)


@router.post("/attendance/precheck", response_model=PrecheckOut)
async def precheck(body: Fix, session: Session, auth: OnOwnPhone) -> PrecheckOut:
    return await service.precheck(session, auth.user, body)


@router.post("/attendance/punch-in", response_model=PunchResult, status_code=201)
async def punch_in(
    request: Request,
    session: Session,
    auth: OnOwnPhone,
    key: IdempotencyKey,
    form: Punched,
    selfie: Selfie,
) -> PunchResult:
    return await _punch("in", request, session, auth, key, form, selfie)


@router.post("/attendance/punch-out", response_model=PunchResult, status_code=201)
async def punch_out(
    request: Request,
    session: Session,
    auth: OnOwnPhone,
    key: IdempotencyKey,
    form: Punched,
    selfie: Selfie,
) -> PunchResult:
    return await _punch("out", request, session, auth, key, form, selfie)


@router.post("/attendance/punch-out-requests", response_model=PunchResult, status_code=201)
async def request_punch_out(
    request: Request,
    session: Session,
    auth: OnOwnPhone,
    key: IdempotencyKey,
    form: Requested,
    selfie: Selfie,
) -> PunchResult:
    return await _punch(
        "request", request, session, auth, key, form, selfie, reason=form.reason, note=form.note
    )
