"""branches, shifts, holidays, settings

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-04 18:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from geoalchemy2 import Geography
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0006"
down_revision: str | Sequence[str] | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Permission keys are frozen here, like the ones in 0002.
NEW_PERMISSIONS = {
    "Super Admin": ["branches.manage", "settings.view", "settings.manage"],
    "Admin/HR": ["branches.manage", "settings.view"],
}


def _timestamps() -> list[sa.Column[object]]:
    return [
        sa.Column(name, sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False)
        for name in ("created_at", "updated_at")
    ]


def upgrade() -> None:
    # The two columns have existed since 0002 without a table to point at and were never exposed,
    # so any value in them is a mistake only a person can resolve.
    stray = (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT emp_code, home_branch_id, shift_id FROM users"
                " WHERE home_branch_id IS NOT NULL OR shift_id IS NOT NULL ORDER BY emp_code"
            )
        )
        .all()
    )
    if stray:
        lines = [
            "Cannot link employees to branches and shifts.",
            "These employees already have a home branch or shift id, but no branches or shifts"
            " exist yet:",
            *(
                f"  - emp_code={row.emp_code}: home_branch_id={row.home_branch_id},"
                f" shift_id={row.shift_id}"
                for row in stray
            ),
            "Nothing was changed. Clear users.home_branch_id and users.shift_id for these"
            " employees and run the migration again.",
        ]
        raise RuntimeError("\n".join(lines))

    op.create_table(
        "branches",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("address", sa.String(length=255), nullable=True),
        # spatial_index=False: the GiST index is created by name below, exactly once.
        sa.Column(
            "location",
            Geography(geometry_type="POINT", srid=4326, spatial_index=False),
            nullable=False,
        ),
        sa.Column("radius_m", sa.Integer(), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        *_timestamps(),
        sa.CheckConstraint("radius_m BETWEEN 30 AND 500", name=op.f("ck_branches_radius_m")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_branches")),
    )
    op.create_index(
        "uq_branches_name_lower", "branches", [sa.literal_column("lower(name)")], unique=True
    )
    op.create_index(
        "idx_branches_location", "branches", ["location"], unique=False, postgresql_using="gist"
    )
    op.create_table(
        "shifts",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("start_time", sa.Time(), nullable=False),
        sa.Column("end_time", sa.Time(), nullable=False),
        sa.Column("grace_min", sa.Integer(), nullable=False),
        sa.Column("half_day_hours", sa.Numeric(precision=4, scale=2), nullable=False),
        sa.Column("full_day_hours", sa.Numeric(precision=4, scale=2), nullable=False),
        sa.Column("weekly_offs", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        *_timestamps(),
        sa.CheckConstraint("grace_min BETWEEN 0 AND 120", name=op.f("ck_shifts_grace_min")),
        sa.CheckConstraint(
            "half_day_hours > 0 AND half_day_hours <= full_day_hours AND full_day_hours <= 24",
            name=op.f("ck_shifts_day_hours"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_shifts")),
    )
    op.create_index(
        "uq_shifts_name_lower", "shifts", [sa.literal_column("lower(name)")], unique=True
    )
    op.create_table(
        "holidays",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("branch_id", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(
            ["branch_id"], ["branches.id"], name=op.f("fk_holidays_branch_id_branches")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_holidays")),
    )
    op.create_index(
        "uq_holidays_date_branch",
        "holidays",
        ["date", sa.literal_column("coalesce(branch_id, 0)")],
        unique=True,
    )
    op.create_table(
        "settings",
        sa.Column("key", sa.String(length=64), nullable=False),
        sa.Column("value", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("updated_by", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(
            ["updated_by"], ["users.id"], name=op.f("fk_settings_updated_by_users")
        ),
        sa.PrimaryKeyConstraint("key", name=op.f("pk_settings")),
    )

    op.add_column(
        "users",
        sa.Column(
            "restrict_to_home_branch",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
    )
    op.create_foreign_key(
        op.f("fk_users_home_branch_id_branches"), "users", "branches", ["home_branch_id"], ["id"]
    )
    op.create_foreign_key(op.f("fk_users_shift_id_shifts"), "users", "shifts", ["shift_id"], ["id"])

    grant = sa.text(
        "UPDATE roles SET permissions = (permissions - CAST(:keys AS text[]))"
        " || to_jsonb(CAST(:keys AS text[])) WHERE name = :name"
    )
    for name, keys in NEW_PERMISSIONS.items():
        op.get_bind().execute(grant, {"name": name, "keys": keys})


def downgrade() -> None:
    # Custom roles may hold the keys too; they mean nothing once the features are gone.
    op.get_bind().execute(
        sa.text("UPDATE roles SET permissions = permissions - CAST(:keys AS text[])"),
        {"keys": NEW_PERMISSIONS["Super Admin"]},
    )
    op.drop_constraint(op.f("fk_users_shift_id_shifts"), "users", type_="foreignkey")
    op.drop_constraint(op.f("fk_users_home_branch_id_branches"), "users", type_="foreignkey")
    # The branches and shifts are dropped below, so the ids would point at nothing (and would
    # block the next upgrade).
    op.execute("UPDATE users SET home_branch_id = NULL, shift_id = NULL")
    op.drop_column("users", "restrict_to_home_branch")
    op.drop_table("settings")
    op.drop_index("uq_holidays_date_branch", table_name="holidays")
    op.drop_table("holidays")
    op.drop_index("uq_shifts_name_lower", table_name="shifts")
    op.drop_table("shifts")
    op.drop_index("idx_branches_location", table_name="branches", postgresql_using="gist")
    op.drop_index("uq_branches_name_lower", table_name="branches")
    op.drop_table("branches")
