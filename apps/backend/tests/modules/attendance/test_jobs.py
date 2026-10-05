"""The housekeeping job: missed punch-outs at the cut-off, rows for everyone else, expiry of old
requests and the shift-end reminder."""

import datetime as dt

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.attendance.jobs import housekeeping
from app.modules.attendance.models import AttendanceDay
from app.modules.notifications.models import Notification
from app.workers.main import WorkerSettings, attendance_housekeeping
from tests.modules.attendance.conftest import MONDAY, SUNDAY, Clock, Scene, employee, ist
from tests.modules.attendance.test_punch import at_branch, send
from tests.modules.attendance.test_requests import REQUESTS, decide, request_out, request_row
from tests.modules.employees.helpers import API, audit_rows
from tests.modules.schedule.test_schedule import add_holiday


async def statuses(db: AsyncSession, day: dt.date = MONDAY) -> dict[int, str]:
    rows = await db.execute(
        select(AttendanceDay.user_id, AttendanceDay.status)
        .where(AttendanceDay.date == day)
        .execution_options(populate_existing=True)
    )
    return {row[0]: row[1] for row in rows}


async def punched_in(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    clock.at(10, 5)
    response = await send(client, scene.headers, "punch-in", await at_branch(db, scene))
    assert response.status_code == 201


async def test_before_the_cut_off_nothing_is_closed(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    await punched_in(client, db, scene, clock)
    # Shift end plus thirty minutes has passed, so the reminder is due; nothing is closed yet.
    assert await housekeeping(db, ist(23, 58)) == {
        "expired": 0,
        "missed": 0,
        "rows": 0,
        "reminders": 1,
    }
    assert await statuses(db) == {scene.user.id: "working"}


async def test_at_the_cut_off_a_missing_punch_out_is_missed_and_the_rest_get_a_row(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    other, _ = await employee(client, db, scene, 2)
    await punched_in(client, db, scene, clock)
    result = await housekeeping(db, ist(23, 59))
    assert result["missed"] == 1
    got = await statuses(db)
    assert (got[scene.user.id], got[other.id]) == ("missed_punch_out", "absent")
    day = (
        await db.execute(select(AttendanceDay).where(AttendanceDay.user_id == scene.user.id))
    ).scalar_one()
    assert (day.worked_minutes, day.first_in_at) == (0, ist(10, 5))  # hours are not counted
    assert len(await audit_rows(db, "attendance.missed_punch_out")) == 1
    finalize = (await audit_rows(db, "attendance.finalize"))[-1].after
    assert finalize is not None and finalize["date"] == "2027-03-01"
    assert finalize["rows_created"] == result["rows"] >= 1


async def test_running_it_again_changes_nothing(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    await employee(client, db, scene, 2)
    await punched_in(client, db, scene, clock)
    await housekeeping(db, ist(23, 59))
    assert await housekeeping(db, ist(23, 59)) == {
        "expired": 0,
        "missed": 0,
        "rows": 0,
        "reminders": 0,
    }


async def test_a_worker_that_was_down_catches_up(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    await punched_in(client, db, scene, clock)
    result = await housekeeping(db, ist(9, 0, day=MONDAY + dt.timedelta(days=2)))  # Wednesday
    assert result["missed"] == 1
    assert (await statuses(db))[scene.user.id] == "missed_punch_out"
    # Tuesday had no punches: a row for it too (absent), none for Wednesday which is not over.
    assert (await statuses(db, MONDAY + dt.timedelta(days=1)))[scene.user.id] == "absent"
    assert await statuses(db, MONDAY + dt.timedelta(days=2)) == {}


async def test_days_off_get_their_own_status_and_the_first_run_does_not_back_fill(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    # Nobody has any attendance yet: a Monday-morning run must not mark last week absent.
    assert (await housekeeping(db, ist(8, 0)))["rows"] == 0
    assert await statuses(db, SUNDAY - dt.timedelta(days=1)) == {}
    # Once there is history, the days since then are filled: a Sunday and a holiday.
    wednesday = MONDAY + dt.timedelta(days=2)
    await add_holiday(db, wednesday)
    db.add(
        AttendanceDay(
            user_id=scene.user.id, date=MONDAY, status="present", shift_id=scene.shift.id, flags=[]
        )
    )
    await db.flush()
    await housekeeping(db, ist(1, 0, day=SUNDAY + dt.timedelta(days=1)))  # Monday 8 March, 01:00
    assert (await statuses(db, SUNDAY))[scene.user.id] == "weekly_off"
    assert (await statuses(db, wednesday))[scene.user.id] == "holiday"
    assert (await statuses(db, MONDAY + dt.timedelta(days=1)))[scene.user.id] == "absent"
    assert (await statuses(db, MONDAY))[scene.user.id] == "present"  # never rewritten


async def test_people_who_have_not_joined_or_have_left_get_no_row(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    later, _ = await employee(client, db, scene, 2)
    later.joined_on = dt.date(2027, 3, 2)
    gone, _ = await employee(client, db, scene, 3)
    gone.status = "inactive"
    await db.flush()
    await punched_in(client, db, scene, clock)
    await housekeeping(db, ist(23, 59))
    got = set(await statuses(db))
    assert scene.user.id in got and later.id not in got and gone.id not in got


async def test_a_waiting_request_keeps_the_day_pending_until_it_expires(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    request_id = await request_out(client, db, scene, clock)
    assert (await housekeeping(db, ist(23, 59)))["missed"] == 0
    assert (await statuses(db))[scene.user.id] == "pending"
    row = await request_row(db, request_id)
    assert row.expires_at == ist(18, 0) + dt.timedelta(hours=48)  # BR-07, from Settings
    just_before = row.expires_at - dt.timedelta(minutes=1)
    assert (await housekeeping(db, just_before))["expired"] == 0
    assert (await housekeeping(db, row.expires_at))["expired"] == 1
    assert (await request_row(db, request_id)).status == "expired"
    assert (await statuses(db))[scene.user.id] == "missed_punch_out"
    assert len(await audit_rows(db, "punch_out_request.expire")) == 1
    # An admin can still decide it later (BR-07); the day then counts.
    clock.at(10, 0, day=MONDAY + dt.timedelta(days=3))
    assert (
        await decide(client, scene.admin, request_id, approved_time=ist(18, 0).isoformat())
    ).status_code == 200
    assert (await statuses(db))[scene.user.id] == "present"
    assert (await client.get(REQUESTS, params={"status": "approved"}, headers=scene.admin)).json()[
        "items"
    ]


async def test_the_reminder_comes_at_shift_end_plus_thirty_minutes_once(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    await punched_in(client, db, scene, clock)
    assert (await housekeeping(db, ist(18, 29)))["reminders"] == 0
    assert (await housekeeping(db, ist(18, 30)))["reminders"] == 1
    assert (await housekeeping(db, ist(18, 40)))["reminders"] == 0
    [note] = (
        await db.execute(select(Notification).where(Notification.user_id == scene.user.id))
    ).scalars()
    assert (note.type, note.read_at, note.deep_link) == ("punch_out_reminder", None, "/attendance")
    mine = (await client.get(f"{API}/notifications", headers=scene.headers)).json()["items"]
    assert [n["title"] for n in mine] == ["Punch out"]


async def test_no_reminder_for_someone_who_punched_out_or_never_came(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    await employee(client, db, scene, 2)  # never punched in
    where = await at_branch(db, scene)
    await send(client, scene.headers, "punch-in", where)
    clock.at(17, 50)
    await send(client, scene.headers, "punch-out", where)
    assert (await housekeeping(db, ist(19, 0)))["reminders"] == 0


async def test_the_reminder_waits_for_a_pending_request_too(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene, clock: Clock
) -> None:
    await request_out(client, db, scene, clock, out_at=(17, 30))
    assert (await housekeeping(db, ist(19, 0)))["reminders"] == 0  # status is pending, not working


async def test_the_job_is_registered_and_runs_in_the_worker() -> None:
    assert "cron:attendance_housekeeping" in {job.name for job in WorkerSettings.cron_jobs}
    assert "attendance_housekeeping" in {f.__name__ for f in WorkerSettings.functions}
    assert set(await attendance_housekeeping({})) == {"expired", "missed", "rows", "reminders"}
