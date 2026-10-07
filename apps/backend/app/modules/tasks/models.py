import datetime as dt
import uuid
from typing import Literal, get_args

from geoalchemy2 import Geography, Geometry, WKBElement, WKTElement
from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Float,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
    cast,
    func,
    text,
    true,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, column_property, mapped_column

from app.core.db import Base
from app.modules.branches.models import RADIUS_MAX_M, RADIUS_MIN_M
from app.modules.tasks.lifecycle import ASSIGNEE_STATUSES, TASK_STATUSES

Priority = Literal["low", "normal", "high", "urgent"]
ProofKind = Literal["photo", "receipt"]
ReachReview = Literal["none", "pending", "approved", "rejected"]
ReachFlag = Literal["location_mismatch", "face_review", "impossible_jump"]
PRIORITIES = get_args(Priority)
PROOF_KINDS = get_args(ProofKind)
REACH_REVIEWS = get_args(ReachReview)
EVENTS = (
    "created", "updated", "assigned", "unassigned", "accepted", "declined", "escalated",
    "reached", "reach_reviewed", "started", "held", "resumed", "note", "completed",
    "reopened", "closed", "cancelled",
)  # fmt: skip
ATTACHMENT_KINDS = ("brief", "work_photo", "proof", "receipt", "comment")

_GEOMETRY = Geometry("POINT", srid=4326)

CODE_DEFAULT = text("'T-' || lpad(nextval('task_code_seq')::text, 5, '0')")


def _in_list(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


class TaskType(Base):
    __tablename__ = "task_types"
    __table_args__ = (CheckConstraint(_in_list("proof_kind", PROOF_KINDS), name="proof_kind"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    is_active: Mapped[bool] = mapped_column(default=True, server_default=true())
    # Completing a task of this type needs a proof photo; a "receipt" is the photographed
    # acknowledgement (EMD, cheque and document submission).
    proof_photo_required: Mapped[bool] = mapped_column(default=True, server_default=true())
    proof_kind: Mapped[ProofKind] = mapped_column(
        String(8), default="photo", server_default="photo"
    )


Index("uq_task_types_name_lower", func.lower(TaskType.name), unique=True)


class Task(Base):
    __tablename__ = "tasks"
    __table_args__ = (
        UniqueConstraint("created_by", "request_id", name="uq_tasks_created_by_request_id"),
        CheckConstraint(_in_list("status", TASK_STATUSES), name="status"),
        CheckConstraint(_in_list("priority", PRIORITIES), name="priority"),
        CheckConstraint(f"site_radius_m BETWEEN {RADIUS_MIN_M} AND {RADIUS_MAX_M}", name="radius"),
        CheckConstraint("expected_minutes IS NULL OR expected_minutes > 0", name="expected"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    # T-00001, from a sequence.
    code: Mapped[str] = mapped_column(String(16), unique=True, server_default=CODE_DEFAULT)
    title: Mapped[str] = mapped_column(String(200))
    type_id: Mapped[int] = mapped_column(ForeignKey("task_types.id"))
    client_name: Mapped[str] = mapped_column(String(200))
    site_address: Mapped[str] = mapped_column(String(500))
    site_location: Mapped[WKBElement | WKTElement] = mapped_column(
        Geography("POINT", srid=4326, spatial_index=False)
    )
    site_radius_m: Mapped[int]
    contact_name: Mapped[str | None] = mapped_column(String(120))
    # E.164, through the same normaliser as employee mobiles.
    contact_phone: Mapped[str | None] = mapped_column(String(16))
    priority: Mapped[Priority] = mapped_column(String(8), default="normal", server_default="normal")
    scheduled_at: Mapped[dt.datetime]
    expected_minutes: Mapped[int | None]
    description: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16))
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    request_id: Mapped[uuid.UUID]
    closed_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    closed_at: Mapped[dt.datetime | None]
    close_remarks: Mapped[str | None] = mapped_column(String(500))
    cancelled_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    cancelled_at: Mapped[dt.datetime | None]
    cancel_reason: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[dt.datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[dt.datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

    # Read in the same SELECT as the row, so the API never parses WKB in Python.
    site_lat: Mapped[float] = column_property(
        func.ST_Y(cast(site_location, _GEOMETRY), type_=Float)
    )
    site_lng: Mapped[float] = column_property(
        func.ST_X(cast(site_location, _GEOMETRY), type_=Float)
    )


Index("ix_tasks_status_scheduled_at", Task.status, Task.scheduled_at)
Index("ix_tasks_created_by", Task.created_by)


class TaskAssignee(Base):
    """One person on one task, with their own lifecycle (`lifecycle.transition`)."""

    __tablename__ = "task_assignees"
    __table_args__ = (
        UniqueConstraint("task_id", "user_id", name="uq_task_assignees_task_id_user_id"),
        CheckConstraint(_in_list("status", ASSIGNEE_STATUSES), name="status"),
        CheckConstraint(_in_list("reach_review", REACH_REVIEWS), name="reach_review"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("tasks.id"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    status: Mapped[str] = mapped_column(String(16), default="assigned", server_default="assigned")
    assigned_at: Mapped[dt.datetime] = mapped_column(server_default=func.now())
    accepted_at: Mapped[dt.datetime | None]
    escalated_at: Mapped[dt.datetime | None]
    started_at: Mapped[dt.datetime | None]
    completed_at: Mapped[dt.datetime | None]
    declined_reason: Mapped[str | None] = mapped_column(String(200))
    completion_remarks: Mapped[str | None] = mapped_column(String(1000))
    # "I have reached" (personal data: the point and the selfie are shown to the task's managers).
    reached_at: Mapped[dt.datetime | None]
    reached_location: Mapped[WKBElement | WKTElement | None] = mapped_column(
        Geography("POINT", srid=4326, spatial_index=False)
    )
    reached_accuracy_m: Mapped[float | None]
    reached_distance_m: Mapped[float | None]
    reached_selfie_key: Mapped[str | None] = mapped_column(String(255))
    reached_face_score: Mapped[float | None]
    reached_face_decision: Mapped[str | None] = mapped_column(String(16))
    reach_flags: Mapped[list[ReachFlag]] = mapped_column(ARRAY(String), server_default=text("'{}'"))
    reach_reason: Mapped[str | None] = mapped_column(String(200))
    reach_review: Mapped[ReachReview] = mapped_column(
        String(8), default="none", server_default="none"
    )
    reach_reviewed_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    reach_reviewed_at: Mapped[dt.datetime | None]
    reach_review_remarks: Mapped[str | None] = mapped_column(String(255))

    reached_lat: Mapped[float | None] = column_property(
        func.ST_Y(cast(reached_location, _GEOMETRY), type_=Float)
    )
    reached_lng: Mapped[float | None] = column_property(
        func.ST_X(cast(reached_location, _GEOMETRY), type_=Float)
    )


Index("ix_task_assignees_user_id_status", TaskAssignee.user_id, TaskAssignee.status)


class TaskEvent(Base):
    """The timeline: append-only. `at` is the server's clock (invariant 1); `device_time` is audit
    only. The first event of a request carries its `request_id`, which makes the request
    idempotent."""

    __tablename__ = "task_events"
    __table_args__ = (
        UniqueConstraint("actor_id", "request_id", name="uq_task_events_actor_id_request_id"),
        CheckConstraint(_in_list("event", EVENTS), name="event"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("tasks.id"))
    subject_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    # NULL: the system (the escalation job).
    actor_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    event: Mapped[str] = mapped_column(String(16))
    at: Mapped[dt.datetime] = mapped_column(server_default=func.now())
    device_time: Mapped[dt.datetime | None]
    location: Mapped[WKBElement | WKTElement | None] = mapped_column(
        Geography("POINT", srid=4326, spatial_index=False)
    )
    accuracy_m: Mapped[float | None]
    note: Mapped[str | None] = mapped_column(String(1000))
    offline: Mapped[bool] = mapped_column(default=False, server_default="false")
    request_id: Mapped[uuid.UUID | None]

    lat: Mapped[float | None] = column_property(func.ST_Y(cast(location, _GEOMETRY), type_=Float))
    lng: Mapped[float | None] = column_property(func.ST_X(cast(location, _GEOMETRY), type_=Float))


Index("ix_task_events_task_id_id", TaskEvent.task_id, TaskEvent.id)


class TaskAttachment(Base):
    __tablename__ = "task_attachments"
    __table_args__ = (
        UniqueConstraint(
            "uploaded_by", "request_id", name="uq_task_attachments_uploaded_by_request_id"
        ),
        CheckConstraint(_in_list("kind", ATTACHMENT_KINDS), name="kind"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("tasks.id"))
    uploaded_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    kind: Mapped[str] = mapped_column(String(12))
    file_key: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(64))
    size: Mapped[int]
    filename: Mapped[str | None] = mapped_column(String(255))
    event_id: Mapped[int | None] = mapped_column(ForeignKey("task_events.id"))
    # Set only on a stand-alone upload (brief), which has no event to carry the key.
    request_id: Mapped[uuid.UUID | None]
    created_at: Mapped[dt.datetime] = mapped_column(server_default=func.now())


Index("ix_task_attachments_task_id", TaskAttachment.task_id)


class TaskComment(Base):
    __tablename__ = "task_comments"
    __table_args__ = (
        UniqueConstraint("author_id", "request_id", name="uq_task_comments_author_id_request_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("tasks.id"))
    author_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    body: Mapped[str] = mapped_column(String(1000))
    attachment_id: Mapped[int | None] = mapped_column(ForeignKey("task_attachments.id"))
    request_id: Mapped[uuid.UUID]
    created_at: Mapped[dt.datetime] = mapped_column(server_default=func.now())


Index("ix_task_comments_task_id_id", TaskComment.task_id, TaskComment.id)
