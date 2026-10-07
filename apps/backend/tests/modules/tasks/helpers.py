"""Helpers for the task tests: people, requests and a tiny JPEG."""

import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import cv2
import httpx
import numpy as np
from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.employees.models import User
from tests.factories import ASSIGNER, FIELD, auth_headers, device, make_user
from tests.modules.employees.helpers import API
from tests.modules.employees.helpers import actor as web_actor

TASKS = f"{API}/tasks"
Headers = dict[str, str]
SITE = {"address": "12 Client Road, Bhubaneswar", "lat": 20.3, "lng": 85.85, "radius_m": 200}
SCHEDULED = "2027-03-01T05:30:00Z"  # Monday 11:00 IST


def key() -> str:
    return str(uuid.uuid4())


def jpeg(width: int = 64, height: int = 48) -> bytes:
    image = np.zeros((height, width, 3), np.uint8)
    image[:, : width // 2] = (40, 120, 200)
    return cv2.imencode(".jpg", image)[1].tobytes()


async def field_person(
    client: httpx.AsyncClient, db: AsyncSession, n: int, **fields: Any
) -> tuple[User, Headers]:
    """A field-eligible employee on their own approved phone (device n)."""
    user = await make_user(db, FIELD, field_eligible=True, **fields)
    return user, await auth_headers(client, user, kind="mobile", device_info=device(n))


async def assigner(client: httpx.AsyncClient, db: AsyncSession) -> tuple[User, Headers]:
    return await web_actor(client, db, ASSIGNER)


def body(assignee_ids: list[int], **over: Any) -> dict[str, Any]:
    return {
        "title": "Install firewall",
        "type_id": over.pop("type_id", 1),
        "client_name": "Acme Pvt Ltd",
        "site": SITE,
        "scheduled_at": SCHEDULED,
        "assignee_ids": assignee_ids,
        **over,
    }


async def type_id(client: httpx.AsyncClient, headers: Headers, name: str = "Other") -> int:
    types = (await client.get(f"{API}/task-types", headers=headers)).json()
    return next(t["id"] for t in types if t["name"] == name)


async def make_task(
    client: httpx.AsyncClient,
    headers: Headers,
    assignee_ids: list[int],
    **over: Any,
) -> dict[str, Any]:
    over.setdefault("type_id", await type_id(client, headers))
    response = await client.post(
        TASKS, json=body(assignee_ids, **over), headers={**headers, "Idempotency-Key": key()}
    )
    assert response.status_code == 201, response.text
    task: dict[str, Any] = response.json()["task"]
    return task


async def act(
    client: httpx.AsyncClient,
    headers: Headers,
    task_id: int,
    action: str,
    *,
    idem: str | None = None,
    files: Any = None,
    **data: Any,
) -> httpx.Response:
    """An assignee action (multipart form fields, like the phone sends them)."""
    form = {k: str(v).lower() if isinstance(v, bool) else v for k, v in data.items()}
    return await client.post(
        f"{TASKS}/{task_id}/{action}",
        data=form,
        files=files,
        headers={**headers, "Idempotency-Key": idem or key()},
    )


async def post(
    client: httpx.AsyncClient,
    headers: Headers,
    path: str,
    json: Any = None,
    *,
    idem: str | None = None,
    method: str = "POST",
) -> httpx.Response:
    """An assigner call with a JSON body."""
    return await client.request(
        method,
        f"{TASKS}/{path}" if path else TASKS,
        json=json,
        headers={**headers, "Idempotency-Key": idem or key()},
    )


async def detail(client: httpx.AsyncClient, headers: Headers, task_id: int) -> dict[str, Any]:
    response = await client.get(f"{TASKS}/{task_id}", headers=headers)
    assert response.status_code == 200, response.text
    out: dict[str, Any] = response.json()
    return out


def status_of(task: dict[str, Any], user_id: int) -> str:
    return next(a["status"] for a in task["assignees"] if a["user"]["id"] == user_id)


@contextmanager
def count_statements(db: AsyncSession) -> Iterator[list[str]]:
    """The SQL statements run on the test's connection while the block is open."""
    connection = db.sync_session.get_bind()
    seen: list[str] = []

    def on_execute(*args: Any) -> None:
        seen.append(args[2])

    event.listen(connection, "before_cursor_execute", on_execute)
    try:
        yield seen
    finally:
        event.remove(connection, "before_cursor_execute", on_execute)


async def point_from_site(
    db: AsyncSession, task_id: int, metres: float, bearing: float = 90.0
) -> dict[str, float]:
    """The point exactly `metres` from the task's site (PostGIS projects it on the spheroid)."""
    row = (
        await db.execute(
            text(
                "SELECT ST_Y(p::geometry) AS lat, ST_X(p::geometry) AS lng FROM (SELECT"
                " ST_Project(site_location, CAST(:metres AS float8),"
                " radians(CAST(:bearing AS float8))) AS p FROM tasks WHERE id = :id) AS projected"
            ),
            {"metres": metres, "bearing": bearing, "id": task_id},
        )
    ).one()
    return {"lat": row.lat, "lng": row.lng}
