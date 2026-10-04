"""canonical E.164 mobile numbers, devices.last_seen_at

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-04 10:00:00.000000

"""

import re
from collections import defaultdict
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0003"
down_revision: str | Sequence[str] | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Frozen copy of app.modules.employees.schemas.normalize_mobile as of this revision.
# Migrations must not import application code, which changes after this file is written.
_NOISE = re.compile(r"[\s\-.()]")
_E164 = re.compile(r"\+[1-9][0-9]{7,14}")
_INDIA_MOBILE = re.compile(r"[6-9][0-9]{9}")
_INDIA_WITH_CODE = re.compile(r"91[0-9]{10}")


def _normalize(value: str) -> str | None:
    cleaned = _NOISE.sub("", value)
    if cleaned.startswith("00"):
        cleaned = "+" + cleaned[2:]
    elif _INDIA_MOBILE.fullmatch(cleaned):
        cleaned = "+91" + cleaned
    elif cleaned.startswith("0") and _INDIA_MOBILE.fullmatch(cleaned[1:]):
        cleaned = "+91" + cleaned[1:]
    elif _INDIA_WITH_CODE.fullmatch(cleaned):
        cleaned = "+" + cleaned
    return cleaned if _E164.fullmatch(cleaned) else None


def _describe(user: sa.Row[tuple[int, str, str, str]]) -> str:
    return f"emp_code={user.emp_code}, name={user.name!r}, mobile={user.mobile!r}"


def upgrade() -> None:
    bind = op.get_bind()
    users = bind.execute(sa.text("SELECT id, emp_code, name, mobile FROM users ORDER BY id")).all()

    canonical: dict[int, str] = {}
    invalid: list[str] = []
    owners: dict[str, list[sa.Row[tuple[int, str, str, str]]]] = defaultdict(list)
    for user in users:
        number = _normalize(user.mobile)
        if number is None:
            invalid.append(f"  - {_describe(user)}")
        else:
            canonical[user.id] = number
            owners[number].append(user)
    clashes = [
        f"  - {_describe(user)} clashes with emp_code={other.emp_code}"
        for number, group in owners.items()
        if len(group) > 1
        for user in group
        for other in group
        if other is not user
    ]
    if invalid or clashes:
        lines = ["Cannot convert mobile numbers to the canonical +<country code><number> form."]
        if invalid:
            lines += ["These numbers are not valid:", *invalid]
        if clashes:
            lines += ["These users end up with the same number:", *clashes]
        lines.append(
            "Nothing was changed. Fix these numbers in the users table and run the migration again."
        )
        raise RuntimeError("\n".join(lines))

    for user in users:
        if canonical[user.id] != user.mobile:
            bind.execute(
                sa.text("UPDATE users SET mobile = :mobile WHERE id = :id"),
                {"mobile": canonical[user.id], "id": user.id},
            )
    op.create_check_constraint(
        op.f("ck_users_mobile_e164"), "users", r"mobile ~ '^\+[1-9][0-9]{7,14}$'"
    )
    op.add_column(
        "user_devices",
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("user_devices", "last_seen_at")
    op.drop_constraint(op.f("ck_users_mobile_e164"), "users", type_="check")
