import datetime as dt
import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, File, Form, Header, Query, Request, UploadFile
from pydantic import AwareDatetime, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.core.errors import AppError
from app.modules.auth.deps import (
    AuthContext,
    authenticated,
    require_active_device,
    require_permission,
)
from app.modules.auth.permissions import SETTINGS_MANAGE, SETTINGS_VIEW, TASKS_CREATE
from app.modules.branches.schemas import Lat, Lng
from app.modules.face.service import MAX_PHOTO_BYTES
from app.modules.tasks import actions, reach, service, views
from app.modules.tasks import lifecycle as lc
from app.modules.tasks.media import read_upload
from app.modules.tasks.schemas import (
    ActionForm,
    ActionOut,
    AssignIn,
    CancelIn,
    CandidatePage,
    CloseIn,
    MyTaskPage,
    ReachedForm,
    ReachReviewIn,
    Reason,
    Remarks,
    ReopenIn,
    TaskCreate,
    TaskDetail,
    TaskPage,
    TaskPatch,
    TaskTypeIn,
    TaskTypeOut,
    TaskTypePatch,
)

router = APIRouter(tags=["tasks"])

Session = Annotated[AsyncSession, Depends(get_session)]
SignedIn = Annotated[AuthContext, Depends(authenticated)]
OnOwnPhone = Annotated[AuthContext, Depends(require_active_device)]
Assigner = Annotated[AuthContext, Depends(require_permission(TASKS_CREATE))]
# The client makes one id per action; a retry or an offline replay sends the same one.
IdempotencyKey = Annotated[uuid.UUID, Header(alias="Idempotency-Key")]


# --- reading -----------------------------------------------------------------------------------


@router.get("/task-types", response_model=list[TaskTypeOut])
async def task_types(session: Session, _: SignedIn) -> list[TaskTypeOut]:
    """The types a new task can have."""
    return await service.list_types(session, only_active=True)


@router.get("/admin/task-types", response_model=list[TaskTypeOut])
async def all_task_types(
    session: Session, _: Annotated[AuthContext, Depends(require_permission(SETTINGS_VIEW))]
) -> list[TaskTypeOut]:
    return await service.list_types(session, only_active=False)


@router.post("/admin/task-types", response_model=TaskTypeOut, status_code=201)
async def create_task_type(
    body: TaskTypeIn,
    request: Request,
    session: Session,
    auth: Annotated[AuthContext, Depends(require_permission(SETTINGS_MANAGE))],
) -> TaskTypeOut:
    return await service.create_type(session, auth.audit(request), body)


@router.patch("/admin/task-types/{type_id}", response_model=TaskTypeOut)
async def update_task_type(
    type_id: int,
    body: TaskTypePatch,
    request: Request,
    session: Session,
    auth: Annotated[AuthContext, Depends(require_permission(SETTINGS_MANAGE))],
) -> TaskTypeOut:
    return await service.update_type(session, auth.audit(request), type_id, body)


@router.get("/tasks", response_model=TaskPage)
async def list_tasks(
    session: Session,
    auth: SignedIn,
    view: Annotated[Literal["assigned_by_me", "team", "all"] | None, Query()] = None,
    status: Annotated[list[str] | None, Query()] = None,
    assignee: Annotated[int | None, Query()] = None,
    date_from: Annotated[dt.date | None, Query(alias="from")] = None,
    date_to: Annotated[dt.date | None, Query(alias="to")] = None,
    type_id: Annotated[int | None, Query()] = None,
    q: Annotated[str | None, Query(max_length=100)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
    cursor: str | None = None,
) -> TaskPage:
    """Tasks in the caller's scope. `view` picks which: the ones they created, their team's, or
    everyone's (admins). Dates are IST dates of the scheduled time."""
    return await views.list_tasks(
        session,
        auth,
        view=view,
        statuses=status or [],
        assignee_id=assignee,
        date_from=date_from,
        date_to=date_to,
        type_id=type_id,
        q=q.strip() if q else None,
        limit=limit,
        cursor=cursor,
    )


@router.get("/tasks/candidates", response_model=CandidatePage)
async def candidates(session: Session, _: Assigner) -> CandidatePage:
    return await views.candidates(session)


@router.get("/me/tasks", response_model=MyTaskPage)
async def my_tasks(
    session: Session,
    auth: SignedIn,
    state: Annotated[Literal["active", "done"], Query()] = "active",
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    cursor: str | None = None,
) -> MyTaskPage:
    return await views.my_tasks(session, auth.user, state=state, limit=limit, cursor=cursor)


@router.get("/tasks/{task_id}", response_model=TaskDetail)
async def task_detail(
    task_id: int, request: Request, session: Session, auth: SignedIn
) -> TaskDetail:
    task = await views.visible_task(session, auth, task_id)
    return await views.detail(session, request.app.state.settings, auth, task)


# --- the assigner ------------------------------------------------------------------------------


@router.post("/tasks", response_model=ActionOut, status_code=201)
async def create_task(
    body: TaskCreate, request: Request, session: Session, auth: Assigner, key: IdempotencyKey
) -> ActionOut:
    return await service.create(
        session, auth.audit(request), request.app.state.settings, auth, key, body
    )


@router.patch("/tasks/{task_id}", response_model=ActionOut)
async def edit_task(
    task_id: int,
    body: TaskPatch,
    request: Request,
    session: Session,
    auth: Assigner,
    key: IdempotencyKey,
) -> ActionOut:
    return await service.edit(
        session, auth.audit(request), request.app.state.settings, auth, task_id, key, body
    )


@router.post("/tasks/{task_id}/assignees", response_model=ActionOut)
async def assign(
    task_id: int,
    body: AssignIn,
    request: Request,
    session: Session,
    auth: Assigner,
    key: IdempotencyKey,
) -> ActionOut:
    return await service.assign(
        session, auth.audit(request), request.app.state.settings, auth, task_id, key, body.user_ids
    )


@router.delete("/tasks/{task_id}/assignees/{user_id}", response_model=ActionOut)
async def unassign(
    task_id: int,
    user_id: int,
    request: Request,
    session: Session,
    auth: Assigner,
    key: IdempotencyKey,
) -> ActionOut:
    return await service.unassign(
        session, auth.audit(request), request.app.state.settings, auth, task_id, user_id, key
    )


@router.post("/tasks/{task_id}/cancel", response_model=ActionOut)
async def cancel_task(
    task_id: int,
    body: CancelIn,
    request: Request,
    session: Session,
    auth: Assigner,
    key: IdempotencyKey,
) -> ActionOut:
    return await service.cancel(
        session, auth.audit(request), request.app.state.settings, auth, task_id, key, body
    )


@router.post("/tasks/{task_id}/close", response_model=ActionOut)
async def close_task(
    task_id: int,
    body: CloseIn,
    request: Request,
    session: Session,
    auth: Assigner,
    key: IdempotencyKey,
) -> ActionOut:
    return await service.close(
        session, auth.audit(request), request.app.state.settings, auth, task_id, key, body
    )


@router.post("/tasks/{task_id}/reopen", response_model=ActionOut)
async def reopen_task(
    task_id: int,
    body: ReopenIn,
    request: Request,
    session: Session,
    auth: Assigner,
    key: IdempotencyKey,
) -> ActionOut:
    return await service.reopen(
        session, auth.audit(request), request.app.state.settings, auth, task_id, key, body
    )


@router.post("/tasks/{task_id}/assignees/{user_id}/reach-review", response_model=ActionOut)
async def review_reached(
    task_id: int,
    user_id: int,
    body: ReachReviewIn,
    request: Request,
    session: Session,
    auth: Assigner,
    key: IdempotencyKey,
) -> ActionOut:
    return await reach.review(
        session, auth.audit(request), request.app.state.settings, auth, task_id, user_id, key, body
    )


@router.post("/tasks/{task_id}/attachments", response_model=ActionOut, status_code=201)
async def add_attachment(
    task_id: int,
    request: Request,
    session: Session,
    auth: Assigner,
    key: IdempotencyKey,
    file: Annotated[UploadFile, File()],
) -> ActionOut:
    """A brief for the assignees: a PDF or a photo, 10 MB at most."""
    state = request.app.state
    return await service.add_brief(
        session, auth.audit(request), state.settings, state.s3, auth, task_id, key, file
    )


@router.post("/tasks/{task_id}/comments", response_model=ActionOut, status_code=201)
async def add_comment(
    task_id: int,
    request: Request,
    session: Session,
    auth: SignedIn,
    key: IdempotencyKey,
    body: Annotated[str, Form(max_length=1000)] = "",
    photo: Annotated[UploadFile | None, File()] = None,
) -> ActionOut:
    state = request.app.state
    return await service.comment(
        session,
        auth.audit(request),
        state.settings,
        state.s3,
        auth,
        task_id,
        key,
        body.strip(),
        photo,
    )


# --- the assignee ------------------------------------------------------------------------------


def _form(
    lat: Annotated[Lat | None, Form()] = None,
    lng: Annotated[Lng | None, Form()] = None,
    accuracy_m: Annotated[float | None, Form(ge=0, le=100_000)] = None,
    device_time: Annotated[AwareDatetime | None, Form()] = None,
    offline: Annotated[bool, Form()] = False,
) -> ActionForm:
    try:
        return ActionForm(
            lat=lat, lng=lng, accuracy_m=accuracy_m, device_time=device_time, offline=offline
        )
    except ValidationError:
        raise AppError(
            "VALIDATION_ERROR", "lat, lng and accuracy_m must be sent together.", 422
        ) from None


Posted = Annotated[ActionForm, Depends(_form)]


async def _act(
    action: str,
    task_id: int,
    request: Request,
    session: AsyncSession,
    auth: AuthContext,
    key: uuid.UUID,
    form: ActionForm,
    *,
    reason: str | None = None,
    remarks: str | None = None,
    note: str | None = None,
    photos: list[UploadFile] | None = None,
) -> ActionOut:
    state = request.app.state
    return await actions.act(
        session,
        auth.audit(request),
        state.settings,
        state.s3,
        auth,
        task_id,
        key,
        action,
        form,
        reason=reason,
        remarks=remarks,
        note=note,
        photos=photos,
    )


@router.post("/tasks/{task_id}/accept", response_model=ActionOut)
async def accept(
    task_id: int,
    request: Request,
    session: Session,
    auth: OnOwnPhone,
    key: IdempotencyKey,
    form: Posted,
) -> ActionOut:
    return await _act(lc.ACCEPT, task_id, request, session, auth, key, form)


@router.post("/tasks/{task_id}/decline", response_model=ActionOut)
async def decline(
    task_id: int,
    request: Request,
    session: Session,
    auth: OnOwnPhone,
    key: IdempotencyKey,
    form: Posted,
    reason: Annotated[Reason, Form()],
) -> ActionOut:
    return await _act(lc.DECLINE, task_id, request, session, auth, key, form, reason=reason)


@router.post("/tasks/{task_id}/start", response_model=ActionOut)
async def start(
    task_id: int,
    request: Request,
    session: Session,
    auth: OnOwnPhone,
    key: IdempotencyKey,
    form: Posted,
) -> ActionOut:
    return await _act(lc.START, task_id, request, session, auth, key, form)


@router.post("/tasks/{task_id}/hold", response_model=ActionOut)
async def hold(
    task_id: int,
    request: Request,
    session: Session,
    auth: OnOwnPhone,
    key: IdempotencyKey,
    form: Posted,
    reason: Annotated[Reason, Form()],
) -> ActionOut:
    return await _act(lc.HOLD, task_id, request, session, auth, key, form, reason=reason)


@router.post("/tasks/{task_id}/resume", response_model=ActionOut)
async def resume(
    task_id: int,
    request: Request,
    session: Session,
    auth: OnOwnPhone,
    key: IdempotencyKey,
    form: Posted,
) -> ActionOut:
    return await _act(lc.RESUME, task_id, request, session, auth, key, form)


@router.post("/tasks/{task_id}/notes", response_model=ActionOut)
async def add_note(
    task_id: int,
    request: Request,
    session: Session,
    auth: OnOwnPhone,
    key: IdempotencyKey,
    form: Posted,
    note: Annotated[str, Form(max_length=1000)] = "",
    photo: Annotated[UploadFile | None, File()] = None,
) -> ActionOut:
    return await _act(
        actions.NOTE,
        task_id,
        request,
        session,
        auth,
        key,
        form,
        note=note.strip() or None,
        photos=[photo] if photo is not None else None,
    )


@router.post("/tasks/{task_id}/complete", response_model=ActionOut)
async def complete(
    task_id: int,
    request: Request,
    session: Session,
    auth: OnOwnPhone,
    key: IdempotencyKey,
    form: Posted,
    remarks: Annotated[Remarks, Form()],
    photos: Annotated[list[UploadFile] | None, File()] = None,
) -> ActionOut:
    return await _act(
        lc.COMPLETE, task_id, request, session, auth, key, form, remarks=remarks, photos=photos
    )


def _reached_form(
    lat: Annotated[Lat, Form()],
    lng: Annotated[Lng, Form()],
    accuracy_m: Annotated[float, Form(ge=0, le=100_000)],
    device_time: Annotated[AwareDatetime | None, Form()] = None,
    mocked: Annotated[bool, Form()] = False,
    emulator: Annotated[bool, Form()] = False,
    rooted: Annotated[bool, Form()] = False,
    offline: Annotated[bool, Form()] = False,
    mismatch_reason: Annotated[Reason | None, Form()] = None,
) -> ReachedForm:
    return ReachedForm(
        lat=lat,
        lng=lng,
        accuracy_m=accuracy_m,
        device_time=device_time,
        mocked=mocked,
        emulator=emulator,
        rooted=rooted,
        offline=offline,
        mismatch_reason=mismatch_reason or None,
    )


@router.post("/tasks/{task_id}/reached", response_model=ActionOut)
async def reached(
    task_id: int,
    request: Request,
    session: Session,
    auth: OnOwnPhone,
    key: IdempotencyKey,
    form: Annotated[ReachedForm, Depends(_reached_form)],
    selfie: Annotated[UploadFile, File()],
) -> ActionOut:
    """ "I have reached": the position and a selfie. The server measures the distance to the site
    and matches the face; outside the radius it answers 422 OUTSIDE_SITE with the distance, unless
    `mismatch_reason` is sent."""
    state = request.app.state
    data = await read_upload(selfie, MAX_PHOTO_BYTES)
    return await reach.reached(
        session, auth.audit(request), state.settings, state.s3, auth, task_id, key, form, data
    )
