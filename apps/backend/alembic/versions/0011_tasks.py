"""field tasks: types, tasks, assignees, events, attachments, comments, field punch-in, permissions

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-06 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from geoalchemy2 import Geography
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0011"
down_revision: str | Sequence[str] | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Permission keys are frozen here, like the ones in 0002, 0006, 0009 and 0010.
NEW_PERMISSIONS = {
    "Super Admin": ["tasks.create", "tasks.view_all"],
    "Admin/HR": ["tasks.create", "tasks.view_all"],
    "Task Assigner": ["tasks.create"],
}
ALL_NEW_KEYS = ["tasks.create", "tasks.view_all"]

ASSIGNEE_STATUSES = (
    "assigned, accepted, reached, in_progress, on_hold, completed, declined, cancelled"
)
EVENTS = (
    "created, updated, assigned, unassigned, accepted, declined, escalated, reached,"
    " reach_reviewed, started, held, resumed, note, completed, reopened, closed, cancelled"
)

# The seven types of FR-TASK-01. A receipt is the photographed acknowledgement.
TASK_TYPES = [
    ("Firewall Installation", "photo"),
    ("Support/Issue Fix", "photo"),
    ("Maintenance", "photo"),
    ("EMD/Cheque Submission", "receipt"),
    ("Document Submission", "receipt"),
    ("Client Meeting", "photo"),
    ("Other", "photo"),
]


def _in_list(column: str, values: str) -> str:
    return f"{column} IN ({', '.join(repr(v.strip()) for v in values.split(','))})"


def _created_at() -> sa.Column[object]:
    return sa.Column(
        "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
    )


def _point(name: str, *, nullable: bool) -> sa.Column[object]:
    return sa.Column(
        name, Geography(geometry_type="POINT", srid=4326, spatial_index=False), nullable=nullable
    )


def upgrade() -> None:
    op.create_table(
        "task_types",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("proof_photo_required", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("proof_kind", sa.String(length=8), server_default="photo", nullable=False),
        sa.CheckConstraint(
            "proof_kind IN ('photo', 'receipt')", name=op.f("ck_task_types_proof_kind")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_task_types")),
    )
    op.create_index("uq_task_types_name_lower", "task_types", [sa.text("lower(name)")], unique=True)
    op.bulk_insert(
        sa.table("task_types", sa.column("name", sa.String), sa.column("proof_kind", sa.String)),
        [{"name": name, "proof_kind": kind} for name, kind in TASK_TYPES],
    )

    op.execute("CREATE SEQUENCE task_code_seq")
    op.create_table(
        "tasks",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column(
            "code",
            sa.String(length=16),
            server_default=sa.text("'T-' || lpad(nextval('task_code_seq')::text, 5, '0')"),
            nullable=False,
        ),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("type_id", sa.Integer(), nullable=False),
        sa.Column("client_name", sa.String(length=200), nullable=False),
        sa.Column("site_address", sa.String(length=500), nullable=False),
        _point("site_location", nullable=False),
        sa.Column("site_radius_m", sa.Integer(), nullable=False),
        sa.Column("contact_name", sa.String(length=120), nullable=True),
        sa.Column("contact_phone", sa.String(length=16), nullable=True),
        sa.Column("priority", sa.String(length=8), server_default="normal", nullable=False),
        sa.Column("scheduled_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expected_minutes", sa.Integer(), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=False),
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.Column("closed_by", sa.Integer(), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("close_remarks", sa.String(length=500), nullable=True),
        sa.Column("cancelled_by", sa.Integer(), nullable=True),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancel_reason", sa.String(length=500), nullable=True),
        _created_at(),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            _in_list("status", ASSIGNEE_STATUSES + ", closed"), name=op.f("ck_tasks_status")
        ),
        sa.CheckConstraint(
            "priority IN ('low', 'normal', 'high', 'urgent')", name=op.f("ck_tasks_priority")
        ),
        sa.CheckConstraint("site_radius_m BETWEEN 30 AND 500", name=op.f("ck_tasks_radius")),
        sa.CheckConstraint(
            "expected_minutes IS NULL OR expected_minutes > 0", name=op.f("ck_tasks_expected")
        ),
        sa.ForeignKeyConstraint(
            ["type_id"], ["task_types.id"], name=op.f("fk_tasks_type_id_task_types")
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], name=op.f("fk_tasks_created_by_users")
        ),
        sa.ForeignKeyConstraint(["closed_by"], ["users.id"], name=op.f("fk_tasks_closed_by_users")),
        sa.ForeignKeyConstraint(
            ["cancelled_by"], ["users.id"], name=op.f("fk_tasks_cancelled_by_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_tasks")),
        sa.UniqueConstraint("code", name=op.f("uq_tasks_code")),
        sa.UniqueConstraint("created_by", "request_id", name="uq_tasks_created_by_request_id"),
    )
    op.create_index("ix_tasks_status_scheduled_at", "tasks", ["status", "scheduled_at"])
    op.create_index("ix_tasks_created_by", "tasks", ["created_by"])

    op.create_table(
        "task_assignees",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("task_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=16), server_default="assigned", nullable=False),
        sa.Column(
            "assigned_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("escalated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("declined_reason", sa.String(length=200), nullable=True),
        sa.Column("completion_remarks", sa.String(length=1000), nullable=True),
        sa.Column("reached_at", sa.DateTime(timezone=True), nullable=True),
        _point("reached_location", nullable=True),
        sa.Column("reached_accuracy_m", sa.Float(), nullable=True),
        sa.Column("reached_distance_m", sa.Float(), nullable=True),
        sa.Column("reached_selfie_key", sa.String(length=255), nullable=True),
        sa.Column("reached_face_score", sa.Float(), nullable=True),
        sa.Column("reached_face_decision", sa.String(length=16), nullable=True),
        sa.Column(
            "reach_flags",
            postgresql.ARRAY(sa.String()),
            server_default=sa.text("'{}'"),
            nullable=False,
        ),
        sa.Column("reach_reason", sa.String(length=200), nullable=True),
        sa.Column("reach_review", sa.String(length=8), server_default="none", nullable=False),
        sa.Column("reach_reviewed_by", sa.Integer(), nullable=True),
        sa.Column("reach_reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reach_review_remarks", sa.String(length=255), nullable=True),
        sa.CheckConstraint(
            _in_list("status", ASSIGNEE_STATUSES), name=op.f("ck_task_assignees_status")
        ),
        sa.CheckConstraint(
            "reach_review IN ('none', 'pending', 'approved', 'rejected')",
            name=op.f("ck_task_assignees_reach_review"),
        ),
        sa.ForeignKeyConstraint(
            ["task_id"], ["tasks.id"], name=op.f("fk_task_assignees_task_id_tasks")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_task_assignees_user_id_users")
        ),
        sa.ForeignKeyConstraint(
            ["reach_reviewed_by"],
            ["users.id"],
            name=op.f("fk_task_assignees_reach_reviewed_by_users"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_task_assignees")),
        sa.UniqueConstraint("task_id", "user_id", name="uq_task_assignees_task_id_user_id"),
    )
    op.create_index("ix_task_assignees_user_id_status", "task_assignees", ["user_id", "status"])

    op.create_table(
        "task_events",
        sa.Column("id", sa.BigInteger(), nullable=False),
        sa.Column("task_id", sa.Integer(), nullable=False),
        sa.Column("subject_user_id", sa.Integer(), nullable=True),
        sa.Column("actor_id", sa.Integer(), nullable=True),
        sa.Column("event", sa.String(length=16), nullable=False),
        sa.Column(
            "at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column("device_time", sa.DateTime(timezone=True), nullable=True),
        _point("location", nullable=True),
        sa.Column("accuracy_m", sa.Float(), nullable=True),
        sa.Column("note", sa.String(length=1000), nullable=True),
        sa.Column("offline", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("request_id", sa.Uuid(), nullable=True),
        sa.CheckConstraint(_in_list("event", EVENTS), name=op.f("ck_task_events_event")),
        sa.ForeignKeyConstraint(
            ["task_id"], ["tasks.id"], name=op.f("fk_task_events_task_id_tasks")
        ),
        sa.ForeignKeyConstraint(
            ["subject_user_id"], ["users.id"], name=op.f("fk_task_events_subject_user_id_users")
        ),
        sa.ForeignKeyConstraint(
            ["actor_id"], ["users.id"], name=op.f("fk_task_events_actor_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_task_events")),
        sa.UniqueConstraint("actor_id", "request_id", name="uq_task_events_actor_id_request_id"),
    )
    op.create_index("ix_task_events_task_id_id", "task_events", ["task_id", "id"])

    op.create_table(
        "task_attachments",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("task_id", sa.Integer(), nullable=False),
        sa.Column("uploaded_by", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=12), nullable=False),
        sa.Column("file_key", sa.String(length=255), nullable=False),
        sa.Column("content_type", sa.String(length=64), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("filename", sa.String(length=255), nullable=True),
        sa.Column("event_id", sa.BigInteger(), nullable=True),
        sa.Column("request_id", sa.Uuid(), nullable=True),
        _created_at(),
        sa.CheckConstraint(
            "kind IN ('brief', 'work_photo', 'proof', 'receipt', 'comment')",
            name=op.f("ck_task_attachments_kind"),
        ),
        sa.ForeignKeyConstraint(
            ["task_id"], ["tasks.id"], name=op.f("fk_task_attachments_task_id_tasks")
        ),
        sa.ForeignKeyConstraint(
            ["uploaded_by"], ["users.id"], name=op.f("fk_task_attachments_uploaded_by_users")
        ),
        sa.ForeignKeyConstraint(
            ["event_id"], ["task_events.id"], name=op.f("fk_task_attachments_event_id_task_events")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_task_attachments")),
        sa.UniqueConstraint(
            "uploaded_by", "request_id", name="uq_task_attachments_uploaded_by_request_id"
        ),
    )
    op.create_index("ix_task_attachments_task_id", "task_attachments", ["task_id"])

    op.create_table(
        "task_comments",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("task_id", sa.Integer(), nullable=False),
        sa.Column("author_id", sa.Integer(), nullable=False),
        sa.Column("body", sa.String(length=1000), nullable=False),
        sa.Column("attachment_id", sa.Integer(), nullable=True),
        sa.Column("request_id", sa.Uuid(), nullable=False),
        _created_at(),
        sa.ForeignKeyConstraint(
            ["task_id"], ["tasks.id"], name=op.f("fk_task_comments_task_id_tasks")
        ),
        sa.ForeignKeyConstraint(
            ["author_id"], ["users.id"], name=op.f("fk_task_comments_author_id_users")
        ),
        sa.ForeignKeyConstraint(
            ["attachment_id"],
            ["task_attachments.id"],
            name=op.f("fk_task_comments_attachment_id_task_attachments"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_task_comments")),
        sa.UniqueConstraint(
            "author_id", "request_id", name="uq_task_comments_author_id_request_id"
        ),
    )
    op.create_index("ix_task_comments_task_id_id", "task_comments", ["task_id", "id"])

    # Field punch-in (FR-ATT-10).
    op.add_column(
        "users",
        sa.Column(
            "field_punch_in_allowed", sa.Boolean(), server_default=sa.false(), nullable=False
        ),
    )
    op.add_column("punch_events", sa.Column("task_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        op.f("fk_punch_events_task_id_tasks"), "punch_events", "tasks", ["task_id"], ["id"]
    )
    op.drop_constraint(op.f("ck_punch_events_location_type"), "punch_events", type_="check")
    op.create_check_constraint(
        op.f("ck_punch_events_location_type"),
        "punch_events",
        "location_type IN ('branch', 'home', 'outside', 'task')",
    )

    grant = sa.text(
        "UPDATE roles SET permissions = (permissions - CAST(:keys AS text[]))"
        " || to_jsonb(CAST(:keys AS text[])) WHERE name = :name"
    )
    for name, keys in NEW_PERMISSIONS.items():
        op.get_bind().execute(grant, {"name": name, "keys": keys})


def downgrade() -> None:
    # Custom roles may hold the keys too; they mean nothing once the feature is gone.
    op.get_bind().execute(
        sa.text("UPDATE roles SET permissions = permissions - CAST(:keys AS text[])"),
        {"keys": ALL_NEW_KEYS},
    )
    # A field punch-in has nowhere to point once tasks are gone: it becomes an outside punch (the
    # old constraint allows no "task"), keeping the attendance record itself.
    op.execute("UPDATE punch_events SET location_type = 'outside' WHERE location_type = 'task'")
    op.drop_constraint(op.f("ck_punch_events_location_type"), "punch_events", type_="check")
    op.create_check_constraint(
        op.f("ck_punch_events_location_type"),
        "punch_events",
        "location_type IN ('branch', 'home', 'outside')",
    )
    op.drop_constraint(op.f("fk_punch_events_task_id_tasks"), "punch_events", type_="foreignkey")
    op.drop_column("punch_events", "task_id")
    op.drop_column("users", "field_punch_in_allowed")
    op.drop_table("task_comments")
    op.drop_table("task_attachments")
    op.drop_table("task_events")
    op.drop_table("task_assignees")
    op.drop_table("tasks")
    op.execute("DROP SEQUENCE task_code_seq")
    op.drop_table("task_types")
