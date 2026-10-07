"""The employee is told, in-app, when the assigner decides their flagged Reached (push is M8)."""

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.notifications.models import Notification
from tests.modules.attendance.conftest import Scene
from tests.modules.tasks.helpers import key, post
from tests.modules.tasks.test_actions import notifications
from tests.modules.tasks.test_reached import flagged

KIND = "task_reach_reviewed"


async def notices(db: AsyncSession, user_id: int) -> list[Notification]:
    rows = await db.execute(
        select(Notification)
        .where(Notification.user_id == user_id, Notification.type == KIND)
        .order_by(Notification.id)
    )
    return list(rows.scalars())


async def test_an_approval_tells_the_employee_with_a_link_to_the_task(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    task, boss = await flagged(client, db, scene)
    path = f"{task['id']}/assignees/{scene.user.id}/reach-review"
    response = await post(client, boss, path, {"decision": "approve", "remarks": "Seen it"})
    assert response.status_code == 200, response.text
    [notice] = await notices(db, scene.user.id)
    assert "approved" in notice.title.lower() and task["code"] in notice.title
    assert "Seen it" in notice.body
    assert notice.deep_link == f"/tasks/{task['id']}"
    assert notice.read_at is None


async def test_a_rejection_tells_the_employee_and_carries_the_reason(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    task, boss = await flagged(client, db, scene)
    path = f"{task['id']}/assignees/{scene.user.id}/reach-review"
    response = await post(client, boss, path, {"decision": "reject", "remarks": "Not at the site"})
    assert response.status_code == 200, response.text
    [notice] = await notices(db, scene.user.id)
    assert "rejected" in notice.title.lower()
    assert "Not at the site" in notice.body


async def test_an_approval_without_a_note_still_tells_the_employee(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    task, boss = await flagged(client, db, scene)
    path = f"{task['id']}/assignees/{scene.user.id}/reach-review"
    assert (await post(client, boss, path, {"decision": "approve"})).status_code == 200
    assert len(await notices(db, scene.user.id)) == 1


async def test_a_replayed_decision_does_not_tell_the_employee_twice(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    task, boss = await flagged(client, db, scene)
    path = f"{task['id']}/assignees/{scene.user.id}/reach-review"
    used = key()
    body = {"decision": "approve", "remarks": "Seen it"}
    await post(client, boss, path, body, idem=used)
    again = await post(client, boss, path, body, idem=used)
    assert again.json()["replayed"] is True
    assert len(await notices(db, scene.user.id)) == 1


async def test_the_reviewer_is_not_told_about_their_own_decision(
    client: httpx.AsyncClient, db: AsyncSession, scene: Scene
) -> None:
    task, boss = await flagged(client, db, scene)
    path = f"{task['id']}/assignees/{scene.user.id}/reach-review"
    await post(client, boss, path, {"decision": "approve"})
    assert KIND not in await notifications(db, task["created_by"]["id"])
