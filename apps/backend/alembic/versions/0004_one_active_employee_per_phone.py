"""one active employee per phone

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-04 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0004"
down_revision: str | Sequence[str] | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Which binding should survive is an admin's decision, so duplicates are reported, not fixed.
    shared = (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT d.device_id, d.model, u.emp_code, u.name"
                " FROM user_devices d JOIN users u ON u.id = d.user_id"
                " WHERE d.status = 'active' AND d.device_id IN ("
                "   SELECT device_id FROM user_devices WHERE status = 'active'"
                "   GROUP BY device_id HAVING count(*) > 1)"
                " ORDER BY d.device_id, d.id"
            )
        )
        .all()
    )
    if shared:
        lines = [
            "Cannot allow only one active employee per phone.",
            "These phones are active for more than one employee:",
            *(
                f"  - device_id={row.device_id}, model={row.model!r}:"
                f" emp_code={row.emp_code}, name={row.name!r}"
                for row in shared
            ),
            "Nothing was changed. Revoke all but one employee on each phone (web portal,"
            " Devices page) and run the migration again.",
        ]
        raise RuntimeError("\n".join(lines))
    op.create_index(
        "uq_user_devices_one_active_per_phone",
        "user_devices",
        ["device_id"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
    )


def downgrade() -> None:
    op.drop_index(
        "uq_user_devices_one_active_per_phone",
        table_name="user_devices",
        postgresql_where=sa.text("status = 'active'"),
    )
