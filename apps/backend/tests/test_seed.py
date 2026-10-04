"""scripts/seed.py: the safety guard, the demo data and the local overlay.

The overlay tests use a temporary file with made-up coordinates; the real seed.local.json is
never opened.
"""

import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import today_ist
from app.modules.audit.models import AuditLog
from app.modules.branches.models import Branch
from app.modules.employees.models import Department, User
from app.modules.schedule.models import HomeLocation, WorkSchedule
from app.modules.shifts.models import Holiday, Shift
from scripts.seed import apply_overlay, load_overlay, refusal, seed_demo
from tests.factories import PASSWORD, login, make_shift, make_user

DEV = "postgresql+asyncpg://worktrack:worktrack@127.0.0.1:5432/worktrack"
CODES = ["DEMO-SA", "DEMO-HR", "DEMO-TA", "DEMO-FE", "DEMO-OE"]
# Distinctive digits, so any leak into the output is easy to spot.
OVERLAY: dict[str, Any] = {
    "branches": [
        {"name": "Overlay Office", "address": "1 Test Road", "lat": 11.7654321, "lng": 76.7654321}
    ],
    "employees": [
        {
            "emp_code": "ovr-1",
            "home_branch": "overlay office",
            "shift": "Overlay Shift",
            "schedule": ["office", "home", "office", "home", "office", None, "off"],
            "home": {"lat": 11.9123456, "lng": 76.9123456, "radius_m": 150},
        },
        {"emp_code": "GHOST-1", "shift": "Overlay Shift"},
    ],
}


def no_coordinates(lines: list[str]) -> bool:
    text = "\n".join(lines)
    return not any(digits in text for digits in ("7654321", "9123456", "11.", "76."))


def overlay_file(tmp_path: Path, content: Any = OVERLAY) -> Path:
    path = tmp_path / "overlay.json"
    path.write_text(json.dumps(content), encoding="utf-8")
    return path


async def counts(db: AsyncSession) -> dict[str, int]:
    models = (User, Branch, Shift, Holiday, Department, WorkSchedule, HomeLocation, AuditLog)
    return {
        model.__tablename__: int(await db.scalar(select(func.count()).select_from(model)) or 0)
        for model in models
    }


# --- the guard --------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("app_env", "url", "dev", "allowed"),
    [
        ("development", f"{DEV}_e2e", False, True),
        ("development", f"{DEV}_test", False, True),
        ("test", f"{DEV}_test?ssl=disable", False, True),
        ("development", DEV, True, True),
        ("development", DEV, False, False),
        ("test", DEV, False, False),
        ("development", f"{DEV}_tests", False, False),
        ("development", f"{DEV}_e2e_copy", False, False),
        # Production is refused whatever the name or the flag.
        ("production", DEV, True, False),
        ("production", f"{DEV}_test", False, False),
        ("production", f"{DEV}_e2e", True, False),
    ],
)
def test_the_seed_runs_only_where_it_is_safe(
    app_env: str, url: str, dev: bool, allowed: bool
) -> None:
    message = refusal(app_env, url, dev)
    assert (message is None) == allowed
    if message is not None:
        assert message.startswith("Refusing to seed")
        assert "worktrack:worktrack" not in message  # never echo credentials


# --- demo data --------------------------------------------------------------------------------


async def test_the_demo_seed_creates_the_expected_rows(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    said: list[str] = []
    created = await seed_demo(db, PASSWORD, said.append)
    assert created == CODES

    users = {
        user.emp_code: user
        for user in (await db.execute(select(User).where(User.emp_code.in_(CODES))))
        .scalars()
        .unique()
    }
    assert {code: user.role.name for code, user in users.items()} == {
        "DEMO-SA": "Super Admin",
        "DEMO-HR": "Admin/HR",
        "DEMO-TA": "Task Assigner",
        "DEMO-FE": "Field Employee",
        "DEMO-OE": "Office Employee",
    }
    team = {code for code, user in users.items() if user.manager_id == users["DEMO-TA"].id}
    assert team == {"DEMO-FE", "DEMO-OE"}
    assert users["DEMO-SA"].manager_id is None
    for user in users.values():
        assert user.home_branch is not None and user.home_branch.name == "Demo HQ"
        assert user.shift is not None and user.shift.name == "General"
        assert user.mobile.startswith("+910000")
        assert user.must_change_password is True
    assert users["DEMO-FE"].field_eligible is True

    branches = {
        b.name: b
        for b in (await db.execute(select(Branch).where(Branch.name.like("Demo %")))).scalars()
    }
    assert set(branches) == {"Demo HQ", "Demo Branch 2"}
    assert {b.radius_m for b in branches.values()} == {100}  # the organisation default
    assert abs(branches["Demo HQ"].lat - branches["Demo Branch 2"].lat) > 5  # two cities

    shift = users["DEMO-SA"].shift
    assert shift is not None
    assert (shift.start_time.isoformat(), shift.end_time.isoformat()) == ("10:00:00", "18:00:00")
    assert (shift.grace_min, shift.half_day_hours, shift.full_day_hours) == (10, 4, 8)
    assert shift.weekly_offs == [
        {"weekday": 6, "weeks": None},
        {"weekday": 5, "weeks": [2, 4]},
    ]
    year = today_ist().year
    holidays = (await db.execute(select(Holiday.date, Holiday.branch_id))).all()
    assert sorted(h.date.isoformat() for h in holidays) == [
        f"{year}-01-26",
        f"{year}-08-15",
        f"{year}-10-02",
    ]
    assert {h.branch_id for h in holidays} == {None}
    assert (await counts(db))["home_locations"] == 0

    # The users can sign in with the seed password, and the writes were audited.
    assert (await login(client, users["DEMO-HR"])).status_code == 200
    audited = await db.scalar(
        select(func.count()).select_from(AuditLog).where(AuditLog.action == "employee.create")
    )
    assert audited == 5
    assert PASSWORD not in "\n".join(said)


async def test_a_second_run_changes_nothing(db: AsyncSession) -> None:
    await seed_demo(db, PASSWORD, lambda _: None)
    before = await counts(db)
    hashes = dict((await db.execute(select(User.emp_code, User.password_hash))).all())
    said: list[str] = []
    assert await seed_demo(db, "Another-Password-99", said.append) == []
    assert said == []
    assert await counts(db) == before
    # Existing users keep their password.
    assert dict((await db.execute(select(User.emp_code, User.password_hash))).all()) == hashes


async def test_a_partly_seeded_database_is_completed(db: AsyncSession) -> None:
    await make_user(db, emp_code="DEMO-SA")
    await make_shift(db, "general")
    created = await seed_demo(db, PASSWORD, lambda _: None)
    assert created == CODES[1:]
    shifts = (await db.execute(select(Shift.name).where(func.lower(Shift.name) == "general"))).all()
    assert len(shifts) == 1


# --- the local overlay ------------------------------------------------------------------------


async def test_the_overlay_applies_branch_schedule_and_home_without_printing_coordinates(
    db: AsyncSession, tmp_path: Path
) -> None:
    user = await make_user(db, emp_code="OVR-1")
    shift = await make_shift(db, "Overlay Shift")
    said: list[str] = []
    overlay = load_overlay(overlay_file(tmp_path))
    await apply_overlay(db, overlay, said.append)

    branch = (await db.execute(select(Branch).where(Branch.name == "Overlay Office"))).scalar_one()
    assert (branch.lat, branch.lng, branch.radius_m) == (11.7654321, 76.7654321, 100)
    await db.refresh(user)
    assert (user.home_branch_id, user.shift_id) == (branch.id, shift.id)
    [row] = (
        await db.execute(select(WorkSchedule).where(WorkSchedule.user_id == user.id))
    ).scalars()
    assert row.effective_from == today_ist()
    assert row.days == OVERLAY["employees"][0]["schedule"]
    [home] = (
        await db.execute(select(HomeLocation).where(HomeLocation.user_id == user.id))
    ).scalars()
    assert (home.status, home.source, home.radius_m) == ("approved", "admin", 150)
    assert (home.requested_by, home.decided_by) == (None, None)

    assert said == [
        "branch Overlay Office: created",
        "OVR-1: branch and shift set",
        f"OVR-1: schedule set from {today_ist().isoformat()}",
        "OVR-1: home location set",
        "skipped GHOST-1: not found",
    ]
    assert no_coordinates(said)
    # The audit rows of the overlay carry no coordinates for the home location either.
    home_rows = (
        await db.execute(select(AuditLog).where(AuditLog.action == "home_location.set"))
    ).scalars()
    assert [set(r.after or {}) & {"lat", "lng", "location"} for r in home_rows] == [set()]

    # Applying it again changes nothing.
    before = await counts(db)
    again: list[str] = []
    await apply_overlay(db, overlay, again.append)
    assert again == ["skipped GHOST-1: not found"]
    assert await counts(db) == before


async def test_the_overlay_updates_only_what_differs(db: AsyncSession, tmp_path: Path) -> None:
    user = await make_user(db, emp_code="OVR-1")
    await make_shift(db, "Overlay Shift")
    await apply_overlay(db, load_overlay(overlay_file(tmp_path)), lambda _: None)
    changed = json.loads(json.dumps(OVERLAY))
    changed["branches"][0]["radius_m"] = 220
    changed["employees"][0]["home"]["radius_m"] = 90
    changed["employees"][0]["shift"] = "No Such Shift"
    said: list[str] = []
    await apply_overlay(db, load_overlay(overlay_file(tmp_path, changed)), said.append)
    assert said == [
        "branch Overlay Office: updated",
        "OVR-1: shift 'No Such Shift' not found",
        "OVR-1: home location set",
        "skipped GHOST-1: not found",
    ]
    statuses = (
        await db.execute(
            select(HomeLocation.status, HomeLocation.radius_m)
            .where(HomeLocation.user_id == user.id)
            .order_by(HomeLocation.id)
        )
    ).all()
    assert [tuple(row) for row in statuses] == [("replaced", 150), ("approved", 90)]
    schedules = await db.scalar(select(func.count()).select_from(WorkSchedule))
    assert schedules == 1


@pytest.mark.parametrize(
    "content",
    [
        {"branches": [{"name": "X", "lat": 95.7654321, "lng": 76.7654321}]},
        {"employees": [{"emp_code": "A", "home": {"lat": 11.7654321, "lng": 276.7654321}}]},
        {"employees": [{"emp_code": "A", "schedule": ["office"]}]},
        {"employees": [{"emp_code": "A", "nickname": "x"}]},
        {"people": []},
    ],
)
def test_an_invalid_overlay_is_refused_without_echoing_its_values(
    tmp_path: Path, content: dict[str, Any]
) -> None:
    with pytest.raises(ValueError, match=r"overlay\.json is not valid") as failure:
        load_overlay(overlay_file(tmp_path, content))
    assert no_coordinates([str(failure.value)])


def test_an_overlay_that_is_not_json_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "overlay.json"
    path.write_text("{lat: 11.7654321", encoding="utf-8")
    with pytest.raises(ValueError, match="not valid JSON") as failure:
        load_overlay(path)
    assert no_coordinates([str(failure.value)])


def test_the_example_overlay_is_valid_and_holds_only_placeholders() -> None:
    example = Path(__file__).resolve().parents[1] / "seed.local.example.json"
    overlay = load_overlay(example)
    assert [(b.lat, b.lng) for b in overlay.branches] == [(0, 0)]
    [employee] = overlay.employees
    assert employee.home is not None and (employee.home.lat, employee.home.lng) == (0, 0)
