"""face enrollments, the face.review permission, and when an account was deactivated

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-05 13:30:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0009"
down_revision: str | Sequence[str] | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Permission keys are frozen here, like the ones in 0002 and 0006.
NEW_PERMISSIONS = {"Super Admin": ["face.review"], "Admin/HR": ["face.review"]}


def upgrade() -> None:
    op.create_table(
        "face_enrollments",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("consent_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("image_keys", postgresql.ARRAY(sa.String()), nullable=True),
        sa.Column("embeddings", sa.LargeBinary(), nullable=True),
        sa.Column("model_version", sa.String(length=64), nullable=True),
        sa.Column("quality", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("consistency_score", sa.Double(), nullable=True),
        sa.Column("decided_by", sa.Integer(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reason", sa.String(length=255), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "(status IN ('pending', 'approved'))"
            " = (embeddings IS NOT NULL AND image_keys IS NOT NULL)",
            name=op.f("ck_face_enrollments_face_data_only_in_use"),
        ),
        sa.CheckConstraint(
            "status IN ('consented', 'pending', 'approved', 'rejected', 'reset')",
            name=op.f("ck_face_enrollments_status"),
        ),
        sa.ForeignKeyConstraint(
            ["decided_by"], ["users.id"], name=op.f("fk_face_enrollments_decided_by_users")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_face_enrollments_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_face_enrollments")),
    )
    op.create_index(
        "ix_face_enrollments_status_id", "face_enrollments", ["status", "id"], unique=False
    )
    op.create_index(
        "uq_face_enrollments_one_open_per_user",
        "face_enrollments",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('consented', 'pending', 'approved')"),
    )

    op.add_column("users", sa.Column("deactivated_at", sa.DateTime(timezone=True), nullable=True))
    # The row's last change is the closest record we have for accounts that are already inactive:
    # never earlier than the real deactivation, so their data is kept at least as long as promised.
    op.execute("UPDATE users SET deactivated_at = updated_at WHERE status = 'inactive'")

    grant = sa.text(
        "UPDATE roles SET permissions = (permissions - CAST(:keys AS text[]))"
        " || to_jsonb(CAST(:keys AS text[])) WHERE name = :name"
    )
    for name, keys in NEW_PERMISSIONS.items():
        op.get_bind().execute(grant, {"name": name, "keys": keys})


def downgrade() -> None:
    # Custom roles may hold the key too; it means nothing once the feature is gone.
    op.get_bind().execute(
        sa.text("UPDATE roles SET permissions = permissions - CAST(:keys AS text[])"),
        {"keys": NEW_PERMISSIONS["Super Admin"]},
    )
    op.drop_column("users", "deactivated_at")
    op.drop_index(
        "uq_face_enrollments_one_open_per_user",
        table_name="face_enrollments",
        postgresql_where=sa.text("status IN ('consented', 'pending', 'approved')"),
    )
    op.drop_index("ix_face_enrollments_status_id", table_name="face_enrollments")
    # Stored selfies in object storage are not touched here; the data goes with the table, and
    # the audit rows stay.
    op.drop_table("face_enrollments")
