"""Seed fictional demo data: branches, a shift, holidays and one user per system role.

    uv run python scripts/seed.py [--dev] [--local path/to/seed.local.json]

Safe to run twice: what already exists is left alone. It runs only against a database whose name
ends in _e2e or _test, or with --dev, and never when APP_ENV=production.

The demo users' password comes from WORKTRACK_SEED_PASSWORD, or is generated and printed once.
A local overlay file adds real branches and per-employee settings: seed.local.json next to this
folder is used with --dev, any other file with --local. Nothing from it is ever printed except
names and codes.
"""

import argparse
import asyncio
import json
import os
import sys
from collections.abc import Callable
from datetime import date, time
from decimal import Decimal
from pathlib import Path

# `python scripts/x.py` puts scripts/ on the path, not the backend root that holds `app`.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pydantic import BaseModel, ConfigDict, ValidationError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.clock import today_ist
from app.core.config import get_settings
from app.core.errors import AppError
from app.core.security import MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, generate_temp_password
from app.modules.audit import service as audit
from app.modules.audit.service import AuditCtx
from app.modules.branches import service as branches
from app.modules.branches.models import Branch
from app.modules.branches.schemas import BranchCreate, BranchUpdate
from app.modules.employees import service as employees
from app.modules.employees.models import Department, Designation, Role, User
from app.modules.employees.schemas import EmployeeCreate
from app.modules.schedule import home
from app.modules.schedule import service as schedule
from app.modules.schedule.schemas import Days, HomeSet, ScheduleSet
from app.modules.shifts import service as shifts
from app.modules.shifts.models import Holiday, Shift
from app.modules.shifts.schemas import HolidayCreate, ShiftCreate, WeeklyOff

Say = Callable[[str], None]

CTX = AuditCtx(None, "cli")
DEFAULT_LOCAL = Path(__file__).resolve().parents[1] / "seed.local.json"
SAFE_SUFFIXES = ("_e2e", "_test")

DEPARTMENT = "Demo Department"
HQ, BRANCH_2, SHIFT = "Demo HQ", "Demo Branch 2", "General"
# Public landmarks, in two cities.
DEMO_BRANCHES = [
    BranchCreate(name=HQ, address="India Gate, New Delhi", lat=28.6129, lng=77.2295),
    BranchCreate(name=BRANCH_2, address="Gateway of India, Mumbai", lat=18.9220, lng=72.8347),
]
DEMO_SHIFT = ShiftCreate(
    name=SHIFT,
    start_time=time(10, 0),
    end_time=time(18, 0),
    grace_min=10,
    half_day_hours=Decimal(4),
    # Half an hour less than the shift: arriving within the grace period is still a full day.
    full_day_hours=Decimal("7.5"),
    weekly_offs=[WeeklyOff(weekday=6), WeeklyOff(weekday=5, weeks=[2, 4])],
)
# (month, day, name), in the current year, for every branch.
DEMO_HOLIDAYS = [(1, 26, "Republic Day"), (8, 15, "Independence Day"), (10, 2, "Gandhi Jayanti")]
# (emp_code, name, role, designation, manager). Managers come first. Indian mobile numbers never
# start with 0, so these can belong to nobody.
DEMO_USERS = [
    ("DEMO-SA", "Demo Super Admin", "Super Admin", "MD", None),
    ("DEMO-HR", "Demo Admin", "Admin/HR", "Manager", "DEMO-SA"),
    ("DEMO-TA", "Demo Assigner", "Task Assigner", "Manager", "DEMO-HR"),
    ("DEMO-FE", "Demo Field Employee", "Field Employee", "Engineer", "DEMO-TA"),
    ("DEMO-OE", "Demo Office Employee", "Office Employee", "Operations", "DEMO-TA"),
]


class OverlayEmployee(BaseModel):
    model_config = ConfigDict(extra="forbid")

    emp_code: str
    home_branch: str | None = None
    shift: str | None = None
    schedule: Days | None = None
    home: HomeSet | None = None


class Overlay(BaseModel):
    model_config = ConfigDict(extra="forbid")

    branches: list[BranchCreate] = []
    employees: list[OverlayEmployee] = []


def refusal(app_env: str, database_url: str, dev: bool) -> str | None:
    """Why the seed must not run against this database, or None when it may."""
    if app_env == "production":
        return "Refusing to seed: APP_ENV is production."
    name = database_url.rsplit("/", 1)[-1].split("?")[0]
    if dev or name.endswith(SAFE_SUFFIXES):
        return None
    return (
        f"Refusing to seed database '{name}': its name does not end in _e2e or _test."
        " Pass --dev to seed the development database on purpose."
    )


def load_overlay(path: Path) -> Overlay:
    """Read and validate the local overlay. Errors name the field, never the value."""
    try:
        return Overlay.model_validate(json.loads(path.read_text(encoding="utf-8")))
    except json.JSONDecodeError:
        raise ValueError(f"{path.name} is not valid JSON.") from None
    except ValidationError as exc:
        problems = "; ".join(
            f"{'.'.join(str(part) for part in error['loc'])}: {error['msg']}"
            for error in exc.errors(include_input=False)
        )
        raise ValueError(f"{path.name} is not valid: {problems}") from None


async def _id(session: AsyncSession, model: type, value: str, column: str = "name") -> int | None:
    found: int | None = await session.scalar(
        select(model.id).where(func.lower(getattr(model, column)) == value.lower())
    )
    return found


async def seed_demo(session: AsyncSession, password: str, say: Say = print) -> list[str]:
    """Create whatever demo data is missing. Returns the emp codes of the users it created."""
    if await _id(session, Department, DEPARTMENT) is None:
        await employees.create_master(session, CTX, "departments", DEPARTMENT)
    for branch in DEMO_BRANCHES:
        if await _id(session, Branch, branch.name) is None:
            await branches.create_branch(session, CTX, branch)
            say(f"branch {branch.name}: created")
    if await _id(session, Shift, SHIFT) is None:
        await shifts.create_shift(session, CTX, DEMO_SHIFT)
        say(f"shift {SHIFT}: created")
    year = today_ist().year
    for month, day, name in DEMO_HOLIDAYS:
        when = date(year, month, day)
        exists = await session.scalar(
            select(Holiday.id).where(Holiday.date == when, Holiday.branch_id.is_(None))
        )
        if exists is None:
            await shifts.create_holiday(session, CTX, HolidayCreate(date=when, name=name))
            say(f"holiday {when.isoformat()}: created")

    department = await _id(session, Department, DEPARTMENT)
    hq = await _id(session, Branch, HQ)
    shift = await _id(session, Shift, SHIFT)
    created: list[str] = []
    for number, (code, name, role, designation, manager) in enumerate(DEMO_USERS, start=1):
        if await _id(session, User, code, "emp_code") is not None:
            continue
        role_id = await _id(session, Role, role)
        designation_id = await _id(session, Designation, designation)
        if role_id is None or designation_id is None:
            raise AppError("NOT_MIGRATED", "Run the migrations first (alembic upgrade head).")
        data = EmployeeCreate(
            emp_code=code,
            name=name,
            mobile=f"+91000000000{number}",
            designation_id=designation_id,
            department_id=department,
            role_id=role_id,
            manager_id=await _id(session, User, manager, "emp_code") if manager else None,
            joined_on=date(year, 1, 1),
            field_eligible=role == "Field Employee",
            home_branch_id=hq,
            shift_id=shift,
            password=password,
        )
        await employees.create_employee(session, None, CTX, data)
        created.append(code)
        say(f"user {code}: created")
    return created


async def _apply_branch(session: AsyncSession, wanted: BranchCreate, say: Say) -> None:
    branch = await session.scalar(
        select(Branch).where(func.lower(Branch.name) == wanted.name.lower())
    )
    if branch is None:
        await branches.create_branch(session, CTX, wanted)
        say(f"branch {wanted.name}: created")
        return
    target = wanted.model_dump(exclude_none=True, exclude={"name"})
    changes = {key: value for key, value in target.items() if getattr(branch, key) != value}
    if changes:
        await branches.update_branch(session, CTX, branch.id, BranchUpdate(**changes))
        say(f"branch {wanted.name}: updated")


async def _apply_employee(session: AsyncSession, wanted: OverlayEmployee, say: Say) -> None:
    code = wanted.emp_code
    user = await session.scalar(select(User).where(func.lower(User.emp_code) == code.lower()))
    if user is None:
        say(f"skipped {code}: not found")
        return
    code = user.emp_code

    # update_employee needs a signed-in actor, so the two links are set here, with the audit row.
    before = employees.snapshot(user)
    for label, column, model, name in (
        ("branch", "home_branch_id", Branch, wanted.home_branch),
        ("shift", "shift_id", Shift, wanted.shift),
    ):
        if name is None:
            continue
        found = await session.scalar(
            select(model.id).where(func.lower(model.name) == name.lower(), model.is_active)
        )
        if found is None:
            say(f"{code}: {label} '{name}' not found")
        else:
            setattr(user, column, found)
    after = employees.snapshot(user)
    if after != before:
        audit.record(session, CTX, "employee.update", "user", user.id, before=before, after=after)
        await session.commit()
        say(f"{code}: branch and shift set")

    if wanted.schedule is not None:
        today = today_ist()
        rows = await schedule.schedule_rows(session, user.id, today)
        if not rows or rows[0].days != wanted.schedule:
            await schedule.set_schedule(
                session, CTX, user, ScheduleSet(effective_from=today, days=wanted.schedule)
            )
            say(f"{code}: schedule set from {today.isoformat()}")

    if wanted.home is not None:
        approved = (await home.admin_view(session, user.id)).approved
        same = approved is not None and (
            (approved.lat, approved.lng) == (wanted.home.lat, wanted.home.lng)
            and wanted.home.radius_m in (None, approved.radius_m)
        )
        if not same:
            await home.set_approved(session, CTX, user, wanted.home)
            say(f"{code}: home location set")


async def apply_overlay(session: AsyncSession, overlay: Overlay, say: Say = print) -> None:
    """Apply the local overlay. Only names, codes and dates are printed, never coordinates."""
    for branch in overlay.branches:
        await _apply_branch(session, branch, say)
    for employee in overlay.employees:
        await _apply_employee(session, employee, say)


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("--dev", action="store_true", help="allow the development database")
    parser.add_argument("--local", type=Path, help="overlay file (default: seed.local.json)")
    args = parser.parse_args()

    settings = get_settings()
    refused = refusal(settings.app_env, settings.database_url, args.dev)
    if refused is not None:
        print(refused, file=sys.stderr)
        return 2
    password = os.environ.get("WORKTRACK_SEED_PASSWORD")
    generated = password is None
    password = password or generate_temp_password()
    if not MIN_PASSWORD_LENGTH <= len(password) <= MAX_PASSWORD_LENGTH:
        print(
            f"WORKTRACK_SEED_PASSWORD must be {MIN_PASSWORD_LENGTH} to {MAX_PASSWORD_LENGTH}"
            " characters.",
            file=sys.stderr,
        )
        return 1
    # The default overlay holds real places: it is picked up only for the development database,
    # so the e2e and test databases never receive it unless --local names a file.
    local = args.local or (DEFAULT_LOCAL if args.dev and DEFAULT_LOCAL.exists() else None)
    try:
        overlay = None if local is None else load_overlay(local)
    except (OSError, ValueError) as exc:
        print(f"Could not read the overlay: {exc}", file=sys.stderr)
        return 1

    engine = create_async_engine(settings.database_url)
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            try:
                created = await seed_demo(session, password)
                if overlay is not None:
                    await apply_overlay(session, overlay)
            except AppError as exc:
                print(f"Seeding failed: {exc.code}: {exc.message}", file=sys.stderr)
                return 1
    finally:
        await engine.dispose()
    if created and generated:
        print(f"Password for the new demo users (shown once): {password}")
    print("Seed complete." if created else "Seed complete: the demo users already existed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
