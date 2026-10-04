"""work schedules, home locations

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-04 21:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from geoalchemy2 import Geography
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0007"
down_revision: str | Sequence[str] | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "work_schedules",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("effective_from", sa.Date(), nullable=False),
        sa.Column("days", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "jsonb_array_length(days) = 7", name=op.f("ck_work_schedules_seven_days")
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], name=op.f("fk_work_schedules_created_by_users")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_work_schedules_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_work_schedules")),
    )
    op.create_index(
        "uq_work_schedules_user_id_effective_from",
        "work_schedules",
        ["user_id", "effective_from"],
        unique=True,
    )
    op.create_table(
        "home_locations",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column(
            "location",
            Geography(geometry_type="POINT", srid=4326, spatial_index=False),
            nullable=False,
        ),
        sa.Column("radius_m", sa.Integer(), nullable=False),
        sa.Column("accuracy_m", sa.Float(), nullable=True),
        sa.Column("source", sa.String(length=8), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("requested_by", sa.Integer(), nullable=True),
        sa.Column("decided_by", sa.Integer(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reject_reason", sa.String(length=255), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("radius_m BETWEEN 30 AND 500", name=op.f("ck_home_locations_radius_m")),
        sa.CheckConstraint("source IN ('admin', 'self')", name=op.f("ck_home_locations_source")),
        sa.CheckConstraint(
            "status IN ('pending', 'approved', 'rejected', 'replaced', 'removed')",
            name=op.f("ck_home_locations_status"),
        ),
        sa.ForeignKeyConstraint(
            ["decided_by"], ["users.id"], name=op.f("fk_home_locations_decided_by_users")
        ),
        sa.ForeignKeyConstraint(
            ["requested_by"], ["users.id"], name=op.f("fk_home_locations_requested_by_users")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_home_locations_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_home_locations")),
    )
    op.create_index("ix_home_locations_user_id", "home_locations", ["user_id"], unique=False)
    op.create_index(
        "uq_home_locations_one_approved",
        "home_locations",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("status = 'approved'"),
    )
    op.create_index(
        "uq_home_locations_one_pending",
        "home_locations",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("status = 'pending'"),
    )


def downgrade() -> None:
    op.drop_index(
        "uq_home_locations_one_pending",
        table_name="home_locations",
        postgresql_where=sa.text("status = 'pending'"),
    )
    op.drop_index(
        "uq_home_locations_one_approved",
        table_name="home_locations",
        postgresql_where=sa.text("status = 'approved'"),
    )
    op.drop_index("ix_home_locations_user_id", table_name="home_locations")
    op.drop_table("home_locations")
    op.drop_index("uq_work_schedules_user_id_effective_from", table_name="work_schedules")
    op.drop_table("work_schedules")
