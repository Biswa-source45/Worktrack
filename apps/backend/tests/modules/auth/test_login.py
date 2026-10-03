from datetime import timedelta

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.security import decode_access_token, utcnow
from app.modules.audit.models import AuditLog
from app.modules.employees.models import User
from tests.factories import (
    ADMIN,
    ASSIGNER,
    FIELD,
    OFFICE,
    PASSWORD,
    SUPER_ADMIN,
    device,
    login,
    make_user,
)

LOGIN = "/api/v1/auth/login"


async def test_web_login_returns_a_15_minute_access_token(
    client: httpx.AsyncClient, db: AsyncSession, settings: Settings
) -> None:
    user = await make_user(db, ADMIN)
    response = await login(client, user)
    assert response.status_code == 200
    body = response.json()
    assert body["expires_in"] == 900 and body["token_type"] == "bearer"
    assert body["must_change_password"] is False and body["device_status"] is None
    claims = decode_access_token(settings, body["access_token"])
    assert claims is not None and claims["exp"] - claims["iat"] == 900
    assert claims["sub"] == str(user.id)


@pytest.mark.parametrize("identifier", ["{code}", "{code_lower}", "  {code}  "])
async def test_login_by_employee_code_ignores_case_and_spaces(
    client: httpx.AsyncClient, db: AsyncSession, identifier: str
) -> None:
    user = await make_user(db, ADMIN, emp_code="EMP-77")
    shown = identifier.format(code=user.emp_code, code_lower=user.emp_code.lower())
    response = await client.post(
        LOGIN, json={"identifier": shown, "password": PASSWORD, "client": "web"}
    )
    assert response.status_code == 200


@pytest.mark.parametrize("formatted", ["9811122233", "98111 22233", "98111-22233"])
async def test_login_by_mobile_number(
    client: httpx.AsyncClient, db: AsyncSession, formatted: str
) -> None:
    await make_user(db, ADMIN, mobile="9811122233")
    response = await client.post(
        LOGIN, json={"identifier": formatted, "password": PASSWORD, "client": "web"}
    )
    assert response.status_code == 200


async def test_wrong_password_unknown_user_and_inactive_user_look_identical(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, ADMIN)
    gone = await make_user(db, ADMIN, status="inactive")
    wrong = await login(client, user, password="not-the-password")
    unknown = await client.post(
        LOGIN, json={"identifier": "NOBODY-9", "password": "x" * 12, "client": "web"}
    )
    inactive = await login(client, gone)
    assert wrong.status_code == unknown.status_code == inactive.status_code == 401
    assert wrong.json() == unknown.json() == inactive.json()
    assert wrong.json()["error"]["code"] == "INVALID_CREDENTIALS"


async def test_five_failures_lock_the_account_for_fifteen_minutes(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, ADMIN)
    for _ in range(5):
        assert (await login(client, user, password="bad-password")).status_code == 401
    # Locked: even the right password is refused, and so is a wrong one, with the same answer.
    right = await login(client, user)
    wrong = await login(client, user, password="bad-password")
    assert right.status_code == wrong.status_code == 429
    error = right.json()["error"]
    assert error["code"] == wrong.json()["error"]["code"] == "ACCOUNT_LOCKED"
    assert 14 * 60 < error["details"]["retry_after_seconds"] <= 15 * 60 + 1
    await db.refresh(user)
    assert user.locked_until is not None
    assert timedelta(minutes=14) < user.locked_until - utcnow() <= timedelta(minutes=15)


async def test_login_works_again_once_the_lock_has_expired(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, ADMIN)
    for _ in range(5):
        await login(client, user, password="bad-password")
    await db.refresh(user)
    user.locked_until = utcnow() - timedelta(seconds=1)
    await db.flush()
    assert (await login(client, user)).status_code == 200
    await db.refresh(user)
    assert user.locked_until is None and user.failed_attempts == 0


async def test_a_good_login_resets_the_failure_counter(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, ADMIN)
    for _ in range(4):
        await login(client, user, password="bad-password")
    assert (await login(client, user)).status_code == 200
    for _ in range(4):
        await login(client, user, password="bad-password")
    assert (await login(client, user)).status_code == 200  # 4 + 4 never reached 5 in a row


async def test_lock_failures_and_logins_are_audited(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, ADMIN)
    for _ in range(5):
        await login(client, user, password="bad-password")
    actions = (
        (await db.execute(select(AuditLog.action).where(AuditLog.actor_id == user.id)))
        .scalars()
        .all()
    )
    assert actions.count("auth.login_failed") == 5 and "auth.account_locked" in actions
    await db.refresh(user)
    user.locked_until = None
    await db.flush()
    await login(client, user)
    row = (
        await db.execute(
            select(AuditLog).where(AuditLog.action == "auth.login", AuditLog.actor_id == user.id)
        )
    ).scalar_one()
    assert row.ip is not None and "password" not in str(row.after)


@pytest.mark.parametrize(
    ("role", "web_allowed"), [(ASSIGNER, True), (FIELD, False), (OFFICE, False)]
)
async def test_web_portal_is_only_for_roles_with_web_access(
    client: httpx.AsyncClient, db: AsyncSession, role: str, web_allowed: bool
) -> None:
    user = await make_user(db, role)
    response = await login(client, user)
    assert (response.status_code == 200) is web_allowed
    if not web_allowed:
        wrong = await login(client, user, password="bad-password")
        assert response.status_code == 401 and response.json() == wrong.json()
        assert response.json()["error"]["code"] == "INVALID_CREDENTIALS"
        await db.refresh(user)
        assert user.failed_attempts == 1  # only the genuinely wrong password counted


@pytest.mark.parametrize("role", [FIELD, OFFICE, ASSIGNER])
async def test_mobile_login_does_not_need_web_access(
    client: httpx.AsyncClient, db: AsyncSession, role: str
) -> None:
    user = await make_user(db, role)
    assert (await login(client, user, kind="mobile")).status_code == 200


async def test_mobile_login_requires_device_info(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, FIELD)
    response = await client.post(
        LOGIN, json={"identifier": user.emp_code, "password": PASSWORD, "client": "mobile"}
    )
    assert response.status_code == 422 and response.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_validation_errors_never_echo_the_password(client: httpx.AsyncClient) -> None:
    response = await client.post(
        LOGIN, json={"identifier": "", "password": "s3cret-value", "client": "tablet"}
    )
    assert response.status_code == 422 and "s3cret-value" not in response.text


async def test_first_mobile_device_is_active_and_a_second_phone_is_pending(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, FIELD)
    first = await login(client, user, kind="mobile", device_info=device(1))
    again = await login(client, user, kind="mobile", device_info=device(1))
    second = await login(client, user, kind="mobile", device_info=device(2))
    assert first.json()["device_status"] == "active" == again.json()["device_status"]
    assert second.status_code == 200 and second.json()["device_status"] == "pending"


async def test_login_response_carries_the_must_change_password_flag(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, SUPER_ADMIN, must_change=True)
    assert (await login(client, user)).json()["must_change_password"] is True


async def test_inactive_users_are_never_locked_or_counted(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, ADMIN, status="inactive")
    for _ in range(6):
        assert (await login(client, user, password="bad-password")).status_code == 401
    refreshed = await db.get(User, user.id)
    assert refreshed is not None and refreshed.locked_until is None
