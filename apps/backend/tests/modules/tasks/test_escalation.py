"""Unaccepted tasks escalate to the assigner once, after the configured wait (FR-TASK-03)."""

import datetime as dt

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.notifications.models import Notification
from app.modules.tasks.escalation import escalate_unaccepted
from app.modules.tasks.models import Task, TaskAssignee
from app.workers.main import WorkerSettings, task_escalation
from tests.factories import SUPER_ADMIN
from tests.modules.attendance.conftest import Clock
from tests.modules.employees.helpers import API, actor, audit_rows
from tests.modules.tasks.helpers import (
    act,
    assigner,
    detail,
    field_person,
    make_task,
    post,
)
from tests.modules.tasks.test_actions import events, set_status


async def escalations(db: AsyncSession) -> list[Notification]:
    rows = await db.execute(
        select(Notification)
        .where(Notification.type == "task_not_accepted")
        .order_by(Notification.id)
    )
    return list(rows.scalars())


async def test_nobody_is_escalated_before_the_wait_is_over(
    client: httpx.AsyncClient, db: AsyncSession, clock: Clock
) -> None:
    _, boss = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    await make_task(client, boss, [ann.id])  # assigned at 10:05
    assert await escalate_unaccepted(db, clock.now + dt.timedelta(minutes=29, seconds=59)) == 0
    assert await escalations(db) == []


async def test_after_the_wait_the_assigner_is_told_once(
    client: httpx.AsyncClient, db: AsyncSession, clock: Clock
) -> None:
    boss_user, boss = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    task = await make_task(client, boss, [ann.id])
    later = clock.now + dt.timedelta(minutes=30)
    assert await escalate_unaccepted(db, later) == 1
    [note] = await escalations(db)
    assert (note.user_id, note.deep_link) == (boss_user.id, f"/tasks/{task['id']}")
    assert ann.name in note.body and "30 minutes" in note.body
    row = (
        await db.execute(select(TaskAssignee).execution_options(populate_existing=True))
    ).scalar_one()
    assert row.escalated_at == later
    [event] = [e for e in await events(db, task["id"]) if e.event == "escalated"]
    assert (event.actor_id, event.subject_user_id, event.at) == (None, ann.id, later)
    [audit_row] = await audit_rows(db, "task.escalate")
    assert (audit_row.actor_id, audit_row.entity_id) == (None, str(task["id"]))
    # Running again, now or much later, changes nothing.
    assert await escalate_unaccepted(db, later) == 0
    assert await escalate_unaccepted(db, later + dt.timedelta(days=1)) == 0
    assert len(await escalations(db)) == 1
    shown = await detail(client, boss, task["id"])
    assert shown["assignees"][0]["escalated_at"] is not None
    assert shown["events"][-1]["event"] == "escalated" and shown["events"][-1]["actor"] is None


async def test_only_people_who_are_still_waiting_are_escalated(
    client: httpx.AsyncClient, db: AsyncSession, clock: Clock
) -> None:
    _, boss = await assigner(client, db)
    waiting, _ = await field_person(client, db, 1)
    accepted, accepted_headers = await field_person(client, db, 2)
    declined, declined_headers = await field_person(client, db, 3)
    cancelled, _ = await field_person(client, db, 4)
    task = await make_task(client, boss, [waiting.id, accepted.id, declined.id, cancelled.id])
    await act(client, accepted_headers, task["id"], "accept")
    await act(client, declined_headers, task["id"], "decline", reason="Not free")
    await post(client, boss, f"{task['id']}/assignees/{cancelled.id}", method="DELETE")
    assert await escalate_unaccepted(db, clock.now + dt.timedelta(hours=1)) == 1
    [note] = await escalations(db)
    assert waiting.name in note.body


async def test_a_cancelled_or_closed_task_is_not_escalated(
    client: httpx.AsyncClient, db: AsyncSession, clock: Clock
) -> None:
    _, boss = await assigner(client, db)
    ann, _ = await field_person(client, db, 1)
    for status in ("cancelled", "closed"):
        task = await make_task(client, boss, [ann.id])
        row = await db.get(Task, task["id"], populate_existing=True)
        assert row is not None
        row.status = status
    await db.flush()
    assert await escalate_unaccepted(db, clock.now + dt.timedelta(hours=1)) == 0


async def test_the_wait_comes_from_settings(
    client: httpx.AsyncClient, db: AsyncSession, clock: Clock
) -> None:
    _, boss = await assigner(client, db)
    _, super_admin = await actor(client, db, SUPER_ADMIN)
    ann, _ = await field_person(client, db, 1)
    await make_task(client, boss, [ann.id])
    changed = await client.patch(
        f"{API}/admin/settings", json={"task_accept_escalation_minutes": 120}, headers=super_admin
    )
    assert changed.status_code == 200
    assert await escalate_unaccepted(db, clock.now + dt.timedelta(minutes=119)) == 0
    assert await escalate_unaccepted(db, clock.now + dt.timedelta(minutes=120)) == 1
    assert "120 minutes" in (await escalations(db))[0].body


async def test_someone_asked_again_is_escalated_again(
    client: httpx.AsyncClient, db: AsyncSession, clock: Clock
) -> None:
    _, boss = await assigner(client, db)
    ann, ann_headers = await field_person(client, db, 1)
    task = await make_task(client, boss, [ann.id])
    assert await escalate_unaccepted(db, clock.now + dt.timedelta(minutes=31)) == 1
    await act(client, ann_headers, task["id"], "decline", reason="Not free")
    clock.now += dt.timedelta(hours=2)
    assert (
        await post(client, boss, f"{task['id']}/assignees", {"user_ids": [ann.id]})
    ).status_code == 200
    assert await escalate_unaccepted(db, clock.now + dt.timedelta(minutes=29)) == 0
    assert await escalate_unaccepted(db, clock.now + dt.timedelta(minutes=30)) == 1
    assert len(await escalations(db)) == 2


async def test_an_accepted_task_stays_quiet(
    client: httpx.AsyncClient, db: AsyncSession, clock: Clock
) -> None:
    _, boss = await assigner(client, db)
    ann, headers = await field_person(client, db, 1)
    task = await make_task(client, boss, [ann.id])
    await act(client, headers, task["id"], "accept")
    await set_status(db, task["id"], ann.id, "accepted")
    assert await escalate_unaccepted(db, clock.now + dt.timedelta(days=2)) == 0


async def test_the_job_is_registered_every_five_minutes_and_runs_in_the_worker() -> None:
    job = next(j for j in WorkerSettings.cron_jobs if j.coroutine is task_escalation)
    assert job.name == "cron:task_escalation"
    assert job.minute == set(range(0, 60, 5))
    assert task_escalation in WorkerSettings.functions
    assert await task_escalation({}) >= 0
