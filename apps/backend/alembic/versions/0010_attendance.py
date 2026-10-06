"""attendance days, punches, punch-out requests, overrides, exceptions, notifications, permissions

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-05 22:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from geoalchemy2 import Geography
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0010"
down_revision: str | Sequence[str] | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Permission keys are frozen here, like the ones in 0002, 0006 and 0009.
NEW_PERMISSIONS = {
    "Super Admin": ["attendance.view_all", "attendance.override", "punchout.approve"],
    "Admin/HR": ["attendance.view_all", "attendance.override", "punchout.approve"],
    "Task Assigner": ["punchout.approve"],
}
ALL_NEW_KEYS = ["attendance.view_all", "attendance.override", "punchout.approve"]

DAY_STATUSES = (
    "working, present, half_day, short_hours, absent, holiday, weekly_off, pending,"
    " missed_punch_out, leave, work_from_home, on_duty"
)


def _in_list(column: str, values: str) -> str:
    return f"{column} IN ({', '.join(repr(v.strip()) for v in values.split(','))})"


def _created_at() -> sa.Column[object]:
    return sa.Column(
        "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
    )


def upgrade() -> None:
    op.create_table(
        "attendance_days",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("shift_id", sa.Integer(), nullable=True),
        sa.Column("branch_id", sa.Integer(), nullable=True),
        sa.Column("first_in_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_out_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("worked_minutes", sa.Integer(), server_default="0", nullable=False),
        sa.Column("late_minutes", sa.Integer(), server_default="0", nullable=False),
        sa.Column("overtime_minutes", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "flags", postgresql.ARRAY(sa.String()), server_default=sa.text("'{}'"), nullable=False
        ),
        _created_at(),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            _in_list("status", DAY_STATUSES), name=op.f("ck_attendance_days_status")
        ),
        sa.CheckConstraint(
            "worked_minutes >= 0 AND late_minutes >= 0 AND overtime_minutes >= 0",
            name=op.f("ck_attendance_days_minutes"),
        ),
        sa.ForeignKeyConstraint(
            ["branch_id"], ["branches.id"], name=op.f("fk_attendance_days_branch_id_branches")
        ),
        sa.ForeignKeyConstraint(
            ["shift_id"], ["shifts.id"], name=op.f("fk_attendance_days_shift_id_shifts")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_attendance_days_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_attendance_days")),
        sa.UniqueConstraint("user_id", "date", name="uq_attendance_days_user_id_date"),
    )
    op.create_index("ix_attendance_days_date_status", "attendance_days", ["date", "status"])
    op.create_index("ix_attendance_days_date_branch_id", "attendance_days", ["date", "branch_id"])

    op.create_table(
        "punch_events",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("attendance_day_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("type", sa.String(length=3), nullable=False),
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.Column(
            "server_time",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("effective_time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("device_time", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "location",
            Geography(geometry_type="POINT", srid=4326, spatial_index=False),
            nullable=False,
        ),
        sa.Column("accuracy_m", sa.Float(), nullable=False),
        sa.Column("location_type", sa.String(length=8), nullable=False),
        sa.Column("branch_id", sa.Integer(), nullable=True),
        sa.Column("nearest_branch_id", sa.Integer(), nullable=True),
        sa.Column("distance_m", sa.Float(), nullable=True),
        sa.Column("selfie_key", sa.String(length=255), nullable=False),
        sa.Column("face_score", sa.Float(), nullable=False),
        sa.Column("face_decision", sa.String(length=16), nullable=False),
        sa.Column("face_model_version", sa.String(length=64), nullable=False),
        sa.Column("thresholds_used", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "integrity_flags",
            postgresql.ARRAY(sa.String()),
            server_default=sa.text("'{}'"),
            nullable=False,
        ),
        sa.Column("offline", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("review_status", sa.String(length=16), nullable=False),
        sa.Column(
            "review_reasons",
            postgresql.ARRAY(sa.String()),
            server_default=sa.text("'{}'"),
            nullable=False,
        ),
        sa.Column("reviewed_by", sa.Integer(), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("review_remarks", sa.String(length=255), nullable=True),
        _created_at(),
        sa.CheckConstraint("type IN ('in', 'out')", name=op.f("ck_punch_events_type")),
        sa.CheckConstraint(
            "location_type IN ('branch', 'home', 'outside')",
            name=op.f("ck_punch_events_location_type"),
        ),
        sa.CheckConstraint(
            "review_status IN ('verified', 'pending', 'approved', 'rejected')",
            name=op.f("ck_punch_events_review_status"),
        ),
        sa.CheckConstraint(
            "face_decision IN ('VERIFIED', 'PENDING_REVIEW', 'MISMATCH')",
            name=op.f("ck_punch_events_face_decision"),
        ),
        sa.CheckConstraint(
            "(location_type = 'branch') = (branch_id IS NOT NULL)",
            name=op.f("ck_punch_events_branch_only_at_branch"),
        ),
        sa.CheckConstraint("accuracy_m >= 0", name=op.f("ck_punch_events_accuracy_m")),
        sa.ForeignKeyConstraint(
            ["attendance_day_id"],
            ["attendance_days.id"],
            name=op.f("fk_punch_events_attendance_day_id_attendance_days"),
        ),
        sa.ForeignKeyConstraint(
            ["branch_id"], ["branches.id"], name=op.f("fk_punch_events_branch_id_branches")
        ),
        sa.ForeignKeyConstraint(
            ["nearest_branch_id"],
            ["branches.id"],
            name=op.f("fk_punch_events_nearest_branch_id_branches"),
        ),
        sa.ForeignKeyConstraint(
            ["reviewed_by"], ["users.id"], name=op.f("fk_punch_events_reviewed_by_users")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_punch_events_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_punch_events")),
        sa.UniqueConstraint("user_id", "request_id", name="uq_punch_events_user_id_request_id"),
    )
    op.create_index(
        "uq_punch_events_one_active_in",
        "punch_events",
        ["attendance_day_id"],
        unique=True,
        postgresql_where=sa.text("type = 'in' AND review_status <> 'rejected'"),
    )
    op.create_index(
        "uq_punch_events_one_active_out",
        "punch_events",
        ["attendance_day_id"],
        unique=True,
        postgresql_where=sa.text("type = 'out' AND review_status <> 'rejected'"),
    )
    op.create_index("ix_punch_events_review_status_id", "punch_events", ["review_status", "id"])
    op.create_index("ix_punch_events_user_id_id", "punch_events", ["user_id", "id"])

    op.create_table(
        "punch_out_requests",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("punch_event_id", sa.Integer(), nullable=False),
        sa.Column("reason", sa.String(length=200), nullable=False),
        sa.Column("note", sa.String(length=500), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("first_approver_id", sa.Integer(), nullable=True),
        sa.Column("first_decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("approver_id", sa.Integer(), nullable=True),
        sa.Column("approved_time", sa.DateTime(timezone=True), nullable=True),
        sa.Column("remarks", sa.String(length=255), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        _created_at(),
        sa.CheckConstraint(
            "status IN ('pending', 'pending_admin', 'approved', 'rejected', 'expired')",
            name=op.f("ck_punch_out_requests_status"),
        ),
        sa.ForeignKeyConstraint(
            ["approver_id"], ["users.id"], name=op.f("fk_punch_out_requests_approver_id_users")
        ),
        sa.ForeignKeyConstraint(
            ["first_approver_id"],
            ["users.id"],
            name=op.f("fk_punch_out_requests_first_approver_id_users"),
        ),
        sa.ForeignKeyConstraint(
            ["punch_event_id"],
            ["punch_events.id"],
            name=op.f("fk_punch_out_requests_punch_event_id_punch_events"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_punch_out_requests")),
        sa.UniqueConstraint("punch_event_id", name=op.f("uq_punch_out_requests_punch_event_id")),
    )
    op.create_index("ix_punch_out_requests_status_id", "punch_out_requests", ["status", "id"])

    op.create_table(
        "attendance_overrides",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("attendance_day_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("reason", sa.String(length=255), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=False),
        _created_at(),
        sa.CheckConstraint(
            "kind IN ('leave', 'work_from_home', 'on_duty')",
            name=op.f("ck_attendance_overrides_kind"),
        ),
        sa.ForeignKeyConstraint(
            ["attendance_day_id"],
            ["attendance_days.id"],
            name=op.f("fk_attendance_overrides_attendance_day_id_attendance_days"),
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], name=op.f("fk_attendance_overrides_created_by_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_attendance_overrides")),
    )
    op.create_index(
        "ix_attendance_overrides_attendance_day_id_id",
        "attendance_overrides",
        ["attendance_day_id", "id"],
    )

    op.create_table(
        "punch_exceptions",
        sa.Column("id", sa.BigInteger(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=24), nullable=False),
        sa.Column(
            "at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column("nearest_branch", sa.String(length=120), nullable=True),
        sa.Column("distance_m", sa.Float(), nullable=True),
        sa.Column("punch_event_id", sa.Integer(), nullable=True),
        sa.Column("details", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.CheckConstraint(
            "kind IN ('MOCK_LOCATION', 'ROOTED_DEVICE', 'EMULATOR', 'OUTSIDE_GEOFENCE',"
            " 'GPS_ACCURACY_POOR', 'IMPOSSIBLE_JUMP', 'FACE_MISMATCH')",
            name=op.f("ck_punch_exceptions_kind"),
        ),
        sa.ForeignKeyConstraint(
            ["punch_event_id"],
            ["punch_events.id"],
            name=op.f("fk_punch_exceptions_punch_event_id_punch_events"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_punch_exceptions_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_punch_exceptions")),
    )
    op.create_index("ix_punch_exceptions_at_id", "punch_exceptions", ["at", "id"])
    op.create_index("ix_punch_exceptions_user_id", "punch_exceptions", ["user_id"])

    op.create_table(
        "notifications",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("type", sa.String(length=48), nullable=False),
        sa.Column("title", sa.String(length=120), nullable=False),
        sa.Column("body", sa.String(length=500), nullable=False),
        sa.Column("deep_link", sa.String(length=255), nullable=True),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("dedupe_key", sa.String(length=120), nullable=True),
        _created_at(),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_notifications_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_notifications")),
        sa.UniqueConstraint("dedupe_key", name=op.f("uq_notifications_dedupe_key")),
    )
    op.create_index("ix_notifications_user_id_id", "notifications", ["user_id", "id"])

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
    op.drop_table("notifications")
    op.drop_table("punch_exceptions")
    op.drop_table("attendance_overrides")
    op.drop_table("punch_out_requests")
    # Stored selfies in object storage are not touched here; the audit rows stay.
    op.drop_table("punch_events")
    op.drop_table("attendance_days")
