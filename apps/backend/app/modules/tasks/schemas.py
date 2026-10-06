import datetime as dt
from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)

from app.modules.branches.schemas import Lat, Lng, Radius
from app.modules.employees.schemas import normalize_mobile
from app.modules.tasks.models import Priority, ProofKind, ReachFlag, ReachReview

Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Address = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
# A reason for something the person did or decided (decline, hold, cancel, reopen, mismatch).
Reason = Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=200)]
LongReason = Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=500)]
Remarks = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)]
Description = Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)]
Phone = Annotated[str, AfterValidator(normalize_mobile)]
UserIds = Annotated[list[int], Field(min_length=1, max_length=20)]


class SiteIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    address: Address
    lat: Lat
    lng: Lng
    # Omit to use the organisation's default site radius (Settings).
    radius_m: Radius | None = None


class TaskCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: Title
    type_id: int
    client_name: Title
    site: SiteIn
    contact_name: Name | None = None
    contact_phone: Phone | None = None
    priority: Priority = "normal"
    scheduled_at: AwareDatetime
    expected_minutes: int | None = Field(None, ge=1, le=1440)
    description: Description | None = None
    assignee_ids: UserIds

    @model_validator(mode="after")
    def _distinct_assignees(self) -> "TaskCreate":
        if len(set(self.assignee_ids)) != len(self.assignee_ids):
            raise ValueError("assignee_ids must not repeat a person")
        return self


class TaskPatch(BaseModel):
    """Partial update: only the fields sent are changed (null clears an optional one)."""

    model_config = ConfigDict(extra="forbid")

    title: Title | None = None
    type_id: int | None = None
    client_name: Title | None = None
    site: SiteIn | None = None
    contact_name: Name | None = None
    contact_phone: Phone | None = None
    priority: Priority | None = None
    scheduled_at: AwareDatetime | None = None
    expected_minutes: int | None = Field(None, ge=1, le=1440)
    description: Description | None = None

    @model_validator(mode="after")
    def _required_fields_not_null(self) -> "TaskPatch":
        for field in ("title", "type_id", "client_name", "site", "priority", "scheduled_at"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null")
        return self


class ActionForm(BaseModel):
    """What the phone adds to a state change. A position is optional; if sent, all three parts
    must be. The server's own clock decides the time (invariant 1); `device_time` is audit only."""

    model_config = ConfigDict(extra="forbid")

    lat: Lat | None = None
    lng: Lng | None = None
    accuracy_m: float | None = Field(None, ge=0, le=100_000)
    device_time: AwareDatetime | None = None
    # Taken without a connection and sent later.
    offline: bool = False

    @model_validator(mode="after")
    def _whole_position(self) -> "ActionForm":
        if len({self.lat is None, self.lng is None, self.accuracy_m is None}) != 1:
            raise ValueError("lat, lng and accuracy_m must be sent together")
        return self


class ReachedForm(BaseModel):
    """ "I have reached": the position is required, the selfie travels as a file next to it."""

    model_config = ConfigDict(extra="forbid")

    lat: Lat
    lng: Lng
    accuracy_m: float = Field(ge=0, le=100_000)
    device_time: AwareDatetime | None = None
    # What the phone reports about itself: Android's mock flag, emulator, root.
    mocked: bool = False
    emulator: bool = False
    rooted: bool = False
    offline: bool = False
    # Needed to submit a Reached from outside the site radius.
    mismatch_reason: Reason | None = None


class AssignIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_ids: UserIds


class CancelIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: LongReason


class CloseIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Required when a Reached was rejected: the comment explains why the task is closed anyway.
    remarks: LongReason | None = None


class ReopenIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    comment: LongReason
    # Default: every assignee who completed.
    user_ids: UserIds | None = None


class ReachReviewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision: Literal["approve", "reject"]
    remarks: Annotated[str, StringConstraints(strip_whitespace=True, max_length=255)] | None = None


class TaskTypeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
    proof_photo_required: bool = True
    proof_kind: ProofKind = "photo"


class TaskTypePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)] | None
    ) = None
    is_active: bool | None = None
    proof_photo_required: bool | None = None
    proof_kind: ProofKind | None = None

    @model_validator(mode="after")
    def _not_null(self) -> "TaskTypePatch":
        for field in self.model_fields_set:
            if getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null")
        return self


# --- output ------------------------------------------------------------------------------------


class UserBrief(BaseModel):
    id: int
    name: str
    emp_code: str


class TaskTypeOut(BaseModel):
    id: int
    name: str
    is_active: bool
    proof_photo_required: bool
    proof_kind: ProofKind


class SiteOut(BaseModel):
    address: str
    lat: float
    lng: float
    radius_m: int


class AssigneeBrief(BaseModel):
    user: UserBrief
    status: str
    escalated: bool
    reach_review: ReachReview


class TaskBrief(BaseModel):
    id: int
    code: str
    title: str
    type: TaskTypeOut
    client_name: str
    site: SiteOut
    priority: Priority
    scheduled_at: dt.datetime
    status: str
    created_by: UserBrief
    assignees: list[AssigneeBrief]


class TaskPage(BaseModel):
    items: list[TaskBrief]
    next_cursor: str | None


class MyAssignment(BaseModel):
    status: str
    assigned_at: dt.datetime
    accepted_at: dt.datetime | None
    started_at: dt.datetime | None
    completed_at: dt.datetime | None
    reached_at: dt.datetime | None
    declined_reason: str | None
    reach_flags: list[ReachFlag]
    reach_review: ReachReview


class MyTask(BaseModel):
    id: int
    code: str
    title: str
    type: TaskTypeOut
    client_name: str
    site: SiteOut
    contact_name: str | None
    contact_phone: str | None
    priority: Priority
    scheduled_at: dt.datetime
    expected_minutes: int | None
    description: str | None
    status: str
    created_by: UserBrief
    my: MyAssignment


class MyTaskPage(BaseModel):
    items: list[MyTask]
    next_cursor: str | None


class Metrics(BaseModel):
    """Straight-line figures only; real travel time and distance need tracking (M6)."""

    time_to_accept_min: int | None
    # Includes any wait before leaving.
    accept_to_reached_min: int | None
    time_on_site_min: int | None
    # From where the person accepted (if they sent a position) to the site.
    straight_line_m: int | None


class ReachOut(BaseModel):
    at: dt.datetime
    distance_m: int | None
    flags: list[ReachFlag]
    reason: str | None
    review: ReachReview
    review_remarks: str | None
    reviewed_by: UserBrief | None
    reviewed_at: dt.datetime | None
    # Managers of the task only.
    lat: float | None = None
    lng: float | None = None
    accuracy_m: float | None = None
    face_decision: str | None = None
    selfie_url: str | None = None
    # Only with face.review; the employee never sees it.
    face_score: float | None = None


class AssigneeOut(BaseModel):
    user: UserBrief
    status: str
    assigned_at: dt.datetime
    accepted_at: dt.datetime | None
    escalated_at: dt.datetime | None
    started_at: dt.datetime | None
    completed_at: dt.datetime | None
    declined_reason: str | None
    completion_remarks: str | None
    reach: ReachOut | None
    metrics: Metrics


class EventOut(BaseModel):
    id: int
    event: str
    at: dt.datetime
    actor: UserBrief | None
    subject: UserBrief | None
    note: str | None
    offline: bool
    # Managers of the task only.
    lat: float | None = None
    lng: float | None = None


class AttachmentOut(BaseModel):
    id: int
    kind: str
    filename: str | None
    content_type: str
    size: int
    uploaded_by: UserBrief
    created_at: dt.datetime
    # A signed link, valid 5 minutes (relative: the client adds its own base).
    url: str


class CommentOut(BaseModel):
    id: int
    author: UserBrief
    body: str
    created_at: dt.datetime
    attachment: AttachmentOut | None


class TaskDetail(BaseModel):
    id: int
    code: str
    title: str
    type: TaskTypeOut
    client_name: str
    site: SiteOut
    contact_name: str | None
    contact_phone: str | None
    priority: Priority
    scheduled_at: dt.datetime
    expected_minutes: int | None
    description: str | None
    status: str
    created_by: UserBrief
    created_at: dt.datetime
    closed_by: UserBrief | None
    closed_at: dt.datetime | None
    close_remarks: str | None
    cancelled_by: UserBrief | None
    cancelled_at: dt.datetime | None
    cancel_reason: str | None
    # The viewer may edit, assign, cancel, close, reopen and review this task.
    can_manage: bool
    assignees: list[AssigneeOut]
    events: list[EventOut]
    attachments: list[AttachmentOut]
    comments: list[CommentOut]


class ActionOut(BaseModel):
    """What every state-changing call answers: the task as the caller sees it now. `replayed` is
    true when the same Idempotency-Key was already used and nothing was changed."""

    task: TaskDetail
    replayed: bool


CandidateStatus = Literal["in_office", "on_task", "punched_out", "not_punched_in", "off_day"]


class Candidate(BaseModel):
    """A person who may be assigned. Name, code and today's status only: no coordinates."""

    id: int
    name: str
    emp_code: str
    status: CandidateStatus


class CandidatePage(BaseModel):
    items: list[Candidate]
