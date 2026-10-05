"""home locations forget their coordinates once they are no longer in use

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-04 23:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0008"
down_revision: str | Sequence[str] | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column("home_locations", "location", nullable=True)
    # Where someone lives is kept only while it is needed to check a punch or decide a request.
    op.execute(
        "UPDATE home_locations SET location = NULL WHERE status NOT IN ('pending', 'approved')"
    )
    op.create_check_constraint(
        op.f("ck_home_locations_location_only_in_use"),
        "home_locations",
        "(status IN ('pending', 'approved')) = (location IS NOT NULL)",
    )


def downgrade() -> None:
    op.drop_constraint(
        op.f("ck_home_locations_location_only_in_use"), "home_locations", type_="check"
    )
    # The cleared coordinates cannot be brought back, and the column was NOT NULL before, so the
    # rows without them go. Their audit rows stay.
    op.execute("DELETE FROM home_locations WHERE location IS NULL")
    op.alter_column("home_locations", "location", nullable=False)
