"""auth users roles devices audit

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-03 21:45:13.691727

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0002"
down_revision: str | Sequence[str] | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "departments",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_departments")),
    )
    op.create_index(
        "uq_departments_name_lower", "departments", [sa.literal_column("lower(name)")], unique=True
    )
    op.create_table(
        "designations",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_designations")),
    )
    op.create_index(
        "uq_designations_name_lower",
        "designations",
        [sa.literal_column("lower(name)")],
        unique=True,
    )
    op.create_table(
        "roles",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("permissions", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("is_system", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_roles")),
    )
    op.create_index("uq_roles_name_lower", "roles", [sa.literal_column("lower(name)")], unique=True)
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("emp_code", sa.String(length=32), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("mobile", sa.String(length=16), nullable=False),
        sa.Column("email", sa.String(length=254), nullable=True),
        sa.Column("password_hash", sa.String(length=255), nullable=False),
        sa.Column("role_id", sa.Integer(), nullable=False),
        sa.Column("designation_id", sa.Integer(), nullable=False),
        sa.Column("department_id", sa.Integer(), nullable=True),
        sa.Column("home_branch_id", sa.Integer(), nullable=True),
        sa.Column("shift_id", sa.Integer(), nullable=True),
        sa.Column("manager_id", sa.Integer(), nullable=True),
        sa.Column("field_eligible", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("status", sa.String(length=16), server_default="active", nullable=False),
        sa.Column("joined_on", sa.Date(), nullable=False),
        sa.Column("must_change_password", sa.Boolean(), server_default="true", nullable=False),
        sa.Column("failed_attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("locked_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("status IN ('active', 'inactive')", name=op.f("ck_users_status")),
        sa.CheckConstraint("failed_attempts >= 0", name=op.f("ck_users_failed_attempts")),
        sa.ForeignKeyConstraint(
            ["department_id"], ["departments.id"], name=op.f("fk_users_department_id_departments")
        ),
        sa.ForeignKeyConstraint(
            ["designation_id"],
            ["designations.id"],
            name=op.f("fk_users_designation_id_designations"),
        ),
        sa.ForeignKeyConstraint(
            ["manager_id"], ["users.id"], name=op.f("fk_users_manager_id_users")
        ),
        sa.ForeignKeyConstraint(["role_id"], ["roles.id"], name=op.f("fk_users_role_id_roles")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_users")),
    )
    op.create_index("ix_users_manager_id", "users", ["manager_id"], unique=False)
    op.create_index(
        "uq_users_email_lower", "users", [sa.literal_column("lower(email)")], unique=True
    )
    op.create_index(
        "uq_users_emp_code_lower", "users", [sa.literal_column("lower(emp_code)")], unique=True
    )
    op.create_index("uq_users_mobile", "users", ["mobile"], unique=True)
    op.create_table(
        "audit_logs",
        sa.Column("id", sa.BigInteger(), nullable=False),
        sa.Column("actor_id", sa.Integer(), nullable=True),
        sa.Column("action", sa.String(length=64), nullable=False),
        sa.Column("entity", sa.String(length=64), nullable=False),
        sa.Column("entity_id", sa.String(length=64), nullable=True),
        sa.Column("before", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("after", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("ip", sa.String(length=64), nullable=True),
        sa.Column("device_id", sa.String(length=128), nullable=True),
        sa.Column(
            "at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["actor_id"], ["users.id"], name=op.f("fk_audit_logs_actor_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_audit_logs")),
    )
    op.create_index("ix_audit_logs_actor_id_at", "audit_logs", ["actor_id", "at"], unique=False)
    op.create_index("ix_audit_logs_entity", "audit_logs", ["entity", "entity_id"], unique=False)
    op.create_table(
        "user_devices",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("device_id", sa.String(length=128), nullable=False),
        sa.Column("model", sa.String(length=120), nullable=False),
        sa.Column("os", sa.String(length=64), nullable=False),
        sa.Column("app_version", sa.String(length=32), nullable=False),
        sa.Column("fcm_token", sa.String(length=512), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("approved_by", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('active', 'pending', 'revoked')", name=op.f("ck_user_devices_status")
        ),
        sa.ForeignKeyConstraint(
            ["approved_by"], ["users.id"], name=op.f("fk_user_devices_approved_by_users")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_user_devices_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_user_devices")),
    )
    op.create_index(
        "uq_user_devices_one_active",
        "user_devices",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
    )
    op.create_index(
        "uq_user_devices_one_pending",
        "user_devices",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("status = 'pending'"),
    )
    op.create_table(
        "refresh_tokens",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("device_row_id", sa.Integer(), nullable=True),
        sa.Column("family_id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("client", sa.String(length=8), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["device_row_id"],
            ["user_devices.id"],
            name=op.f("fk_refresh_tokens_device_row_id_user_devices"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_refresh_tokens_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_refresh_tokens")),
    )
    op.create_index(
        "ix_refresh_tokens_device_row_id", "refresh_tokens", ["device_row_id"], unique=False
    )
    op.create_index("ix_refresh_tokens_family_id", "refresh_tokens", ["family_id"], unique=False)
    op.create_index("ix_refresh_tokens_user_id", "refresh_tokens", ["user_id"], unique=False)
    op.create_index("uq_refresh_tokens_token_hash", "refresh_tokens", ["token_hash"], unique=True)

    # Audit logs are append-only (FR-AUD-02): the database itself refuses edits and deletes.
    op.execute(
        """
        CREATE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
        BEGIN
            RAISE EXCEPTION 'audit_logs is append-only';
        END;
        $$ LANGUAGE plpgsql
        """
    )
    op.execute(
        """
        CREATE TRIGGER audit_logs_no_change BEFORE UPDATE OR DELETE ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable()
        """
    )
    op.execute(
        """
        CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
        FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_immutable()
        """
    )

    # Permission keys are frozen here; later milestones add theirs in their own migration.
    roles = sa.table(
        "roles",
        sa.column("name", sa.String),
        sa.column("permissions", postgresql.JSONB),
        sa.column("is_system", sa.Boolean),
    )
    op.bulk_insert(
        roles,
        [
            {
                "name": "Super Admin",
                "permissions": [
                    "web.access",
                    "employees.manage",
                    "devices.manage",
                    "roles.manage",
                    "team.view",
                ],
                "is_system": True,
            },
            {
                "name": "Admin/HR",
                "permissions": ["web.access", "employees.manage", "devices.manage", "team.view"],
                "is_system": True,
            },
            {
                "name": "Task Assigner",
                "permissions": ["web.access", "team.view"],
                "is_system": True,
            },
            {"name": "Field Employee", "permissions": [], "is_system": True},
            {"name": "Office Employee", "permissions": [], "is_system": True},
        ],
    )
    designations = sa.table("designations", sa.column("name", sa.String))
    op.bulk_insert(
        designations,
        [
            {"name": name}
            for name in (
                "MD",
                "CEO",
                "Pre-sales",
                "Sales",
                "Manager",
                "Developer",
                "Engineer",
                "Operations",
                "Finance",
            )
        ],
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER audit_logs_no_truncate ON audit_logs")
    op.execute("DROP TRIGGER audit_logs_no_change ON audit_logs")
    op.execute("DROP FUNCTION audit_logs_immutable()")
    op.drop_index("uq_refresh_tokens_token_hash", table_name="refresh_tokens")
    op.drop_index("ix_refresh_tokens_user_id", table_name="refresh_tokens")
    op.drop_index("ix_refresh_tokens_family_id", table_name="refresh_tokens")
    op.drop_index("ix_refresh_tokens_device_row_id", table_name="refresh_tokens")
    op.drop_table("refresh_tokens")
    op.drop_index(
        "uq_user_devices_one_pending",
        table_name="user_devices",
        postgresql_where=sa.text("status = 'pending'"),
    )
    op.drop_index(
        "uq_user_devices_one_active",
        table_name="user_devices",
        postgresql_where=sa.text("status = 'active'"),
    )
    op.drop_table("user_devices")
    op.drop_index("ix_audit_logs_entity", table_name="audit_logs")
    op.drop_index("ix_audit_logs_actor_id_at", table_name="audit_logs")
    op.drop_table("audit_logs")
    op.drop_index("uq_users_mobile", table_name="users")
    op.drop_index("uq_users_emp_code_lower", table_name="users")
    op.drop_index("uq_users_email_lower", table_name="users")
    op.drop_index("ix_users_manager_id", table_name="users")
    op.drop_table("users")
    op.drop_index("uq_roles_name_lower", table_name="roles")
    op.drop_table("roles")
    op.drop_index("uq_designations_name_lower", table_name="designations")
    op.drop_table("designations")
    op.drop_index("uq_departments_name_lower", table_name="departments")
    op.drop_table("departments")
