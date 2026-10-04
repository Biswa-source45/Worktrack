from datetime import timedelta
from typing import Any

import httpx
import jwt
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.security import hash_token, utcnow
from app.modules.audit.models import AuditLog
from app.modules.auth.models import RefreshToken
from app.modules.employees.models import User
from tests.factories import ADMIN, FIELD, PASSWORD, auth_headers, device, login, make_user

REFRESH = "/api/v1/auth/refresh"
LOGOUT = "/api/v1/auth/logout"
CHANGE = "/api/v1/auth/change-password"
NEW_PASSWORD = "A-brand-new-pass-77"


async def _tokens(client: httpx.AsyncClient, user: User, **kwargs: Any) -> dict[str, Any]:
    response = await login(client, user, **kwargs)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def _bearer(tokens: dict[str, Any]) -> dict[str, str]:
    return {"Authorization": f"Bearer {tokens['access_token']}"}


async def _refresh(client: httpx.AsyncClient, tokens: dict[str, Any]) -> httpx.Response:
    return await client.post(REFRESH, json={"refresh_token": tokens["refresh_token"]})


async def test_refresh_rotates_the_token(client: httpx.AsyncClient, db: AsyncSession) -> None:
    user = await make_user(db, ADMIN)
    first = await _tokens(client, user)
    response = await _refresh(client, first)
    assert response.status_code == 200
    second = response.json()
    assert second["refresh_token"] != first["refresh_token"] and second["expires_in"] == 900
    assert (await client.get("/api/v1/me", headers=_bearer(second))).status_code == 200


async def test_reusing_a_rotated_refresh_token_kills_the_whole_session(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, ADMIN)
    first = await _tokens(client, user)
    second = (await _refresh(client, first)).json()
    replay = await _refresh(client, first)
    assert replay.status_code == 401 and replay.json()["error"]["code"] == "INVALID_TOKEN"
    # The legitimate newest token is revoked too, because the family is compromised.
    assert (await _refresh(client, second)).status_code == 401
    reuse = (
        (await db.execute(select(AuditLog).where(AuditLog.action == "auth.refresh_reuse")))
        .scalars()
        .all()
    )
    assert reuse and {r.actor_id for r in reuse} == {user.id}


async def test_other_logins_survive_a_reuse_attack_on_one_family(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, ADMIN)
    web = await _tokens(client, user)
    phone = await _tokens(client, user, kind="mobile", device_info=device(1))
    await _refresh(client, web)
    await _refresh(client, web)  # replay
    assert (await _refresh(client, phone)).status_code == 200


async def test_expired_and_unknown_refresh_tokens_are_refused(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, ADMIN)
    tokens = await _tokens(client, user)
    assert (await client.post(REFRESH, json={"refresh_token": "nope"})).status_code == 401
    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.token_hash == hash_token(tokens["refresh_token"]))
        .values(expires_at=utcnow() - timedelta(seconds=1))
    )
    assert (await _refresh(client, tokens)).status_code == 401


async def test_refresh_token_lasts_thirty_days_and_only_its_hash_is_stored(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, ADMIN)
    tokens = await _tokens(client, user)
    row = (
        await db.execute(
            select(RefreshToken).where(
                RefreshToken.token_hash == hash_token(tokens["refresh_token"])
            )
        )
    ).scalar_one()
    assert timedelta(days=29, hours=23) < row.expires_at - utcnow() <= timedelta(days=30)
    assert row.token_hash != tokens["refresh_token"]


async def test_logout_revokes_the_refresh_token(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, ADMIN)
    tokens = await _tokens(client, user)
    out = await client.post(LOGOUT, json={"refresh_token": tokens["refresh_token"]})
    assert out.status_code == 204
    assert (await _refresh(client, tokens)).status_code == 401
    assert (await client.post(LOGOUT, json={"refresh_token": "unknown"})).status_code == 204
    entry = (
        await db.execute(select(AuditLog).where(AuditLog.action == "auth.logout"))
    ).scalar_one()
    assert entry.actor_id == user.id


async def test_a_deactivated_employee_is_locked_out_at_once(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, ADMIN)
    tokens = await _tokens(client, user)
    user.status = "inactive"
    await db.flush()
    assert (await _refresh(client, tokens)).status_code == 401
    assert (await client.get("/api/v1/me", headers=_bearer(tokens))).status_code == 401


async def test_change_password_issues_a_new_pair_and_revokes_old_sessions(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, ADMIN, must_change=True)
    old = await _tokens(client, user)
    other = await _tokens(client, user)
    response = await client.post(
        CHANGE,
        headers=_bearer(old),
        json={"current_password": PASSWORD, "new_password": NEW_PASSWORD},
    )
    assert response.status_code == 200
    new = response.json()
    assert new["must_change_password"] is False
    assert (await _refresh(client, old)).status_code == 401
    assert (await _refresh(client, other)).status_code == 401
    assert (await _refresh(client, new)).status_code == 200
    assert (await login(client, user)).status_code == 401
    assert (await login(client, user, password=NEW_PASSWORD)).status_code == 200
    entry = (
        await db.execute(select(AuditLog).where(AuditLog.action == "auth.password_changed"))
    ).scalar_one()
    assert NEW_PASSWORD not in str(entry.after) and PASSWORD not in str(entry.after)


async def test_change_password_keeps_the_device_binding(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, FIELD, must_change=True)
    tokens = await _tokens(client, user, kind="mobile")
    response = await client.post(
        CHANGE,
        headers=_bearer(tokens),
        json={"current_password": PASSWORD, "new_password": NEW_PASSWORD},
    )
    me = (await client.get("/api/v1/me", headers=_bearer(response.json()))).json()
    assert me["device"]["status"] == "active" and me["client"] == "mobile"


async def test_change_password_rules(client: httpx.AsyncClient, db: AsyncSession) -> None:
    user = await make_user(db, ADMIN)
    headers = await auth_headers(client, user)
    wrong = await client.post(
        CHANGE, headers=headers, json={"current_password": "bad", "new_password": NEW_PASSWORD}
    )
    same = await client.post(
        CHANGE, headers=headers, json={"current_password": PASSWORD, "new_password": PASSWORD}
    )
    short = await client.post(
        CHANGE, headers=headers, json={"current_password": PASSWORD, "new_password": "short"}
    )
    assert (wrong.status_code, wrong.json()["error"]["code"]) == (400, "INVALID_CURRENT_PASSWORD")
    assert (same.status_code, same.json()["error"]["code"]) == (400, "PASSWORD_UNCHANGED")
    assert short.status_code == 422


async def test_wrong_current_password_counts_toward_the_lockout(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, ADMIN)
    headers = await auth_headers(client, user)
    for _ in range(5):
        await client.post(
            CHANGE, headers=headers, json={"current_password": "bad", "new_password": NEW_PASSWORD}
        )
    assert (await login(client, user)).status_code == 429


async def test_must_change_password_blocks_everything_except_me_and_change(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    admin = await make_user(db, ADMIN, must_change=True)
    headers = _bearer(await _tokens(client, admin))
    blocked = await client.get("/api/v1/admin/employees", headers=headers)
    assert blocked.status_code == 403
    assert blocked.json()["error"]["code"] == "PASSWORD_CHANGE_REQUIRED"
    me = await client.get("/api/v1/me", headers=headers)
    assert me.status_code == 200 and me.json()["must_change_password"] is True


async def test_me_describes_the_session(client: httpx.AsyncClient, db: AsyncSession) -> None:
    manager = await make_user(db, ADMIN)
    user = await make_user(db, FIELD, manager_id=manager.id, field_eligible=True)
    headers = await auth_headers(client, user, kind="mobile", device_info=device(5))
    body = (await client.get("/api/v1/me", headers=headers)).json()
    assert body["emp_code"] == user.emp_code and body["role"]["name"] == FIELD
    assert body["permissions"] == [] and body["field_eligible"] is True
    assert body["manager_id"] == manager.id and body["client"] == "mobile"
    assert body["device"]["status"] == "active" and "password_hash" not in str(body)


async def test_bad_bearer_tokens_are_refused(
    client: httpx.AsyncClient, db: AsyncSession, settings: Settings
) -> None:
    user = await make_user(db, ADMIN)
    expired = jwt.encode(
        {
            "sub": str(user.id),
            "typ": "access",
            "cli": "web",
            "iat": utcnow() - timedelta(hours=1),
            "exp": utcnow() - timedelta(minutes=1),
        },
        settings.jwt_secret,
        algorithm="HS256",
    )
    for header in (None, "Bearer garbage", f"Bearer {expired}", "Basic abc"):
        headers = {} if header is None else {"Authorization": header}
        response = await client.get("/api/v1/me", headers=headers)
        assert response.status_code == 401
        assert response.json()["error"]["code"] in {"UNAUTHENTICATED", "INVALID_TOKEN"}
