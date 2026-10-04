"""sign-in sessions

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-04 15:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0005"
down_revision: str | Sequence[str] | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "auth_sessions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("family_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("client", sa.String(length=8), nullable=False),
        sa.Column("device_row_id", sa.Integer(), nullable=True),
        sa.Column("user_agent", sa.String(length=512), nullable=True),
        sa.Column("browser", sa.String(length=64), nullable=True),
        sa.Column("os", sa.String(length=64), nullable=True),
        sa.Column("ip", sa.String(length=64), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("end_reason", sa.String(length=32), nullable=True),
        sa.ForeignKeyConstraint(
            ["device_row_id"],
            ["user_devices.id"],
            name=op.f("fk_auth_sessions_device_row_id_user_devices"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_auth_sessions_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_auth_sessions")),
    )
    op.create_index("uq_auth_sessions_family_id", "auth_sessions", ["family_id"], unique=True)
    op.create_index("ix_auth_sessions_user_id", "auth_sessions", ["user_id"], unique=False)
    op.create_index(
        "ix_auth_sessions_device_row_id", "auth_sessions", ["device_row_id"], unique=False
    )
    op.create_index("ix_auth_sessions_ended_at", "auth_sessions", ["ended_at"], unique=False)
    # Sign-ins that already exist get a session too (browser and IP were not recorded then), so
    # they show up in the list and can be signed out. A family is over once all its tokens are
    # revoked.
    op.execute(
        """
        INSERT INTO auth_sessions (family_id, user_id, client, device_row_id, created_at,
                                   last_seen_at, expires_at, ended_at, end_reason)
        SELECT family_id, min(user_id), min(client), min(device_row_id), min(created_at),
               max(created_at), max(expires_at),
               CASE WHEN bool_and(revoked_at IS NOT NULL) THEN max(revoked_at) END,
               CASE WHEN bool_and(revoked_at IS NOT NULL) THEN 'before_tracking' END
        FROM refresh_tokens
        GROUP BY family_id
        ORDER BY min(created_at)
        """
    )


def downgrade() -> None:
    op.drop_index("ix_auth_sessions_ended_at", table_name="auth_sessions")
    op.drop_index("ix_auth_sessions_device_row_id", table_name="auth_sessions")
    op.drop_index("ix_auth_sessions_user_id", table_name="auth_sessions")
    op.drop_index("uq_auth_sessions_family_id", table_name="auth_sessions")
    op.drop_table("auth_sessions")
