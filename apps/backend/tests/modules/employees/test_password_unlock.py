import json

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.employees.models import User
from tests.factories import ASSIGNER, PASSWORD, SUPER_ADMIN, login, make_user
from tests.modules.employees.helpers import API, EMPLOYEES, actor, audit_rows, error_code, get_user


async def _lock_out(client: httpx.AsyncClient, user: User) -> None:
    for _ in range(5):  # login_max_failures
        assert (await login(client, user, password="wrong-password-1")).status_code == 401
    locked = await login(client, user)
    assert locked.status_code == 429
    assert error_code(locked) == "ACCOUNT_LOCKED"


async def test_reset_password_issues_a_working_temporary_password(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    admin, headers = await actor(client, db)
    target = await make_user(db, ASSIGNER)
    old_session = (await login(client, target)).json()

    response = await client.post(f"{EMPLOYEES}/{target.id}/reset-password", headers=headers)
    assert response.status_code == 200
    temp = response.json()["temporary_password"]
    assert len(temp) == 12
    assert temp != PASSWORD
    assert (await get_user(db, target.id)).must_change_password is True

    assert (await login(client, target, password=PASSWORD)).status_code == 401
    fresh = await login(client, target, password=temp)
    assert fresh.status_code == 200
    assert fresh.json()["must_change_password"] is True

    refresh = await client.post(
        f"{API}/auth/refresh", json={"refresh_token": old_session["refresh_token"]}
    )
    assert refresh.status_code == 401

    (row,) = await audit_rows(db, "employee.reset_password")
    assert row.actor_id == admin.id
    assert row.entity_id == str(target.id)
    assert temp not in json.dumps([row.before, row.after])


async def test_reset_password_clears_a_lockout(client: httpx.AsyncClient, db: AsyncSession) -> None:
    _, headers = await actor(client, db)
    target = await make_user(db, ASSIGNER)
    await _lock_out(client, target)

    temp = (await client.post(f"{EMPLOYEES}/{target.id}/reset-password", headers=headers)).json()[
        "temporary_password"
    ]
    assert (await login(client, target, password=temp)).status_code == 200


async def test_unlock_clears_a_lockout(client: httpx.AsyncClient, db: AsyncSession) -> None:
    admin, headers = await actor(client, db)
    target = await make_user(db, ASSIGNER)
    await _lock_out(client, target)

    response = await client.post(f"{EMPLOYEES}/{target.id}/unlock", headers=headers)
    assert response.status_code == 200
    assert response.json()["locked_until"] is None
    stored = await get_user(db, target.id)
    assert stored.locked_until is None
    assert stored.failed_attempts == 0
    assert (await login(client, target)).status_code == 200

    (row,) = await audit_rows(db, "employee.unlock")
    assert row.actor_id == admin.id
    assert row.entity_id == str(target.id)


async def test_reset_and_unlock_for_unknown_employee_are_404(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db)
    for action in ("reset-password", "unlock"):
        response = await client.post(f"{EMPLOYEES}/999999/{action}", headers=headers)
        assert response.status_code == 404
        assert error_code(response) == "NOT_FOUND"


async def test_reset_and_unlock_need_employees_manage(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    _, headers = await actor(client, db, ASSIGNER)
    target = await make_user(db, SUPER_ADMIN)
    for action in ("reset-password", "unlock"):
        assert (
            await client.post(f"{EMPLOYEES}/{target.id}/{action}", headers=headers)
        ).status_code == 403
        assert (await client.post(f"{EMPLOYEES}/{target.id}/{action}")).status_code == 401
    assert (await get_user(db, target.id)).must_change_password is False
