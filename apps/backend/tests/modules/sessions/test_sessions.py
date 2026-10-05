"""Sign-in sessions: one per login, visible to admins and to their owner, and revocable."""

from datetime import timedelta
from typing import Any

import httpx
from sqlalchemy import event, select, update
from sqlalchemy.engine import Engine
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.security import create_access_token, utcnow
from app.modules.auth.models import AuthSession, RefreshToken
from app.modules.devices.models import UserDevice
from app.modules.employees.models import User
from app.modules.sessions.service import purge_ended
from app.workers.main import WorkerSettings, purge_sessions
from tests.factories import ADMIN, PASSWORD, SUPER_ADMIN, device, login, make_user
from tests.modules.employees.helpers import API, actor, audit_rows, error_code

SESSIONS = f"{API}/admin/sessions"
MINE = f"{API}/me/sessions"
CHROME = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)"
    " Chrome/141.0.0.0 Safari/537.36"
)
SAFARI = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)"
    " Version/19.0 Safari/605.1.15"
)

Tokens = dict[str, Any]


async def _web(client: httpx.AsyncClient, user: User, agent: str = CHROME) -> Tokens:
    response = await client.post(
        f"{API}/auth/login",
        json={"identifier": user.emp_code, "password": PASSWORD, "client": "web"},
        headers={"User-Agent": agent},
    )
    assert response.status_code == 200, response.text
    body: Tokens = response.json()
    return body


async def _mobile(client: httpx.AsyncClient, user: User, phone: int = 1) -> Tokens:
    response = await login(client, user, kind="mobile", device_info=device(phone))
    assert response.status_code == 200, response.text
    body: Tokens = response.json()
    return body


def _bearer(tokens: Tokens) -> dict[str, str]:
    return {"Authorization": f"Bearer {tokens['access_token']}"}


async def _refresh_status(client: httpx.AsyncClient, tokens: Tokens) -> int:
    response = await client.post(
        f"{API}/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
    )
    return response.status_code


async def _of(
    client: httpx.AsyncClient, headers: dict[str, str], user: User, **params: str
) -> list[dict[str, Any]]:
    """The user's sessions as the admin list shows them (newest first)."""
    response = await client.get(SESSIONS, params={"user_id": user.id, **params}, headers=headers)
    assert response.status_code == 200, response.text
    items: list[dict[str, Any]] = response.json()["items"]
    return items


# --- creation and listing ---------------------------------------------------------------------


async def test_a_web_login_creates_a_session_with_browser_os_and_ip_and_no_phone(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, ADMIN)
    await _web(client, user)
    _, headers = await actor(client, db)

    (item,) = await _of(client, headers, user)
    assert item["client"] == "web"
    assert (item["browser"], item["os"]) == ("Chrome 141", "Windows")
    assert item["device_model"] is None
    assert item["ip"]
    assert (item["emp_code"], item["user_name"]) == (user.emp_code, user.name)
    assert (item["status"], item["ended_at"], item["end_reason"]) == ("active", None, None)
    assert item["current"] is False
    assert item["created_at"] and item["last_seen_at"]

    # A web session is never a phone.
    phones = (await db.execute(select(UserDevice).where(UserDevice.user_id == user.id))).all()
    assert phones == []
    listed = await client.get(f"{API}/admin/devices", params={"user_id": user.id}, headers=headers)
    assert listed.json()["items"] == []


async def test_a_mobile_login_shows_the_phone_instead_of_a_browser(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db)
    await _mobile(client, user)
    _, headers = await actor(client, db)
    (item,) = await _of(client, headers, user)
    assert (item["client"], item["browser"]) == ("mobile", None)
    assert (item["device_model"], item["os"]) == ("Pixel 8", "Android 14")


async def test_refreshing_keeps_the_same_session_and_moves_last_seen(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, ADMIN)
    tokens = await _web(client, user)
    row = (await db.execute(select(AuthSession).where(AuthSession.user_id == user.id))).scalar_one()
    await db.execute(
        update(AuthSession)
        .where(AuthSession.id == row.id)
        .values(last_seen_at=utcnow() - timedelta(hours=3))
    )
    assert await _refresh_status(client, tokens) == 200

    _, headers = await actor(client, db)
    (item,) = await _of(client, headers, user)
    assert item["id"] == row.id
    await db.refresh(row)
    assert utcnow() - row.last_seen_at < timedelta(minutes=1)


async def test_list_filters_counts_and_newest_first_paging(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, ADMIN)
    first = await _web(client, user)
    await _web(client, user, SAFARI)
    await _mobile(client, user)
    await client.post(f"{API}/auth/logout", json={"refresh_token": first["refresh_token"]})
    _, headers = await actor(client, db)

    everything = await _of(client, headers, user)
    assert [i["client"] for i in everything] == ["mobile", "web", "web"]  # newest first
    assert [i["status"] for i in everything] == ["active", "active", "ended"]
    assert everything[2]["end_reason"] == "signed_out"
    assert everything[1]["browser"] == "Safari 19" and everything[1]["os"] == "macOS"

    assert len(await _of(client, headers, user, status="active")) == 2
    assert [i["id"] for i in await _of(client, headers, user, status="ended")] == [
        everything[2]["id"]
    ]
    only_web = await client.get(
        SESSIONS, params={"user_id": user.id, "client": "web"}, headers=headers
    )
    assert len(only_web.json()["items"]) == 2

    page = (
        await client.get(SESSIONS, params={"user_id": user.id, "limit": 2}, headers=headers)
    ).json()
    assert [i["id"] for i in page["items"]] == [i["id"] for i in everything[:2]]
    rest = await client.get(
        SESSIONS,
        params={"user_id": user.id, "limit": 2, "cursor": page["next_cursor"]},
        headers=headers,
    )
    assert [i["id"] for i in rest.json()["items"]] == [everything[2]["id"]]
    assert rest.json()["next_cursor"] is None

    # Counts cover every session, whatever the filters (the admin's own login is one of them).
    counts = page["counts"]
    stored = (await db.execute(select(AuthSession))).scalars().all()
    assert counts["active"] + counts["ended"] == len(stored)
    assert counts["ended"] >= 1
    bad = await client.get(SESSIONS, params={"status": "lost"}, headers=headers)
    assert bad.status_code == 422


async def test_a_session_past_its_expiry_shows_as_ended(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, ADMIN)
    await _web(client, user)
    await db.execute(
        update(AuthSession)
        .where(AuthSession.user_id == user.id)
        .values(expires_at=utcnow() - timedelta(minutes=1))
    )
    _, headers = await actor(client, db)
    (item,) = await _of(client, headers, user)
    assert (item["status"], item["end_reason"]) == ("ended", "expired")
    assert item["ended_at"] is not None
    assert await _of(client, headers, user, status="active") == []


# --- an admin signs a session out -------------------------------------------------------------


async def test_revoking_a_session_ends_it_and_its_refresh_token_stops_working(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, ADMIN)
    tokens = await _web(client, user)
    other = await _web(client, user, SAFARI)
    admin, headers = await actor(client, db)
    newer, older = await _of(client, headers, user)

    response = await client.post(f"{SESSIONS}/{older['id']}/revoke", headers=headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["status"], body["end_reason"]) == ("ended", "revoked_by_admin")
    assert body["ended_at"] is not None

    assert await _refresh_status(client, tokens) == 401
    assert await _refresh_status(client, other) == 200  # the other sign-in is untouched
    (row,) = await audit_rows(db, "session.revoked")
    assert (row.actor_id, row.entity, row.entity_id) == (admin.id, "auth_session", str(older["id"]))
    assert row.after == {"user_id": user.id, "client": "web"}

    again = await client.post(f"{SESSIONS}/{older['id']}/revoke", headers=headers)
    assert again.status_code == 409 and error_code(again) == "CONFLICT"
    missing = await client.post(f"{SESSIONS}/999999999/revoke", headers=headers)
    assert missing.status_code == 404
    assert newer["status"] == "active"


async def test_revoking_needs_the_right_to_manage_that_employee(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    boss = await make_user(db, SUPER_ADMIN)
    tokens = await _web(client, boss)
    _, headers = await actor(client, db, ADMIN)
    (item,) = await _of(client, headers, boss)

    response = await client.post(f"{SESSIONS}/{item['id']}/revoke", headers=headers)
    assert response.status_code == 403 and error_code(response) == "FORBIDDEN"
    assert await _refresh_status(client, tokens) == 200
    assert await audit_rows(db, "session.revoked") == []


async def test_other_ways_a_session_ends_record_their_reason(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db)
    await _mobile(client, user)
    _, headers = await actor(client, db)
    phone = (
        await client.get(f"{API}/admin/devices", params={"user_id": user.id}, headers=headers)
    ).json()["items"][0]
    await client.patch(
        f"{API}/admin/devices/{phone['id']}", json={"action": "revoke"}, headers=headers
    )
    (item,) = await _of(client, headers, user)
    assert (item["status"], item["end_reason"]) == ("ended", "device_revoked")

    web_user = await make_user(db, ADMIN)
    await _web(client, web_user)
    reset = await client.post(
        f"{API}/admin/employees/{web_user.id}/reset-password", headers=headers
    )
    assert reset.status_code == 200
    (item,) = await _of(client, headers, web_user)
    assert (item["status"], item["end_reason"]) == ("ended", "password_reset")


# --- the signed-in user's own sessions --------------------------------------------------------


async def test_my_sessions_lists_only_mine_and_marks_the_current_one(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user, stranger = await make_user(db, ADMIN), await make_user(db, ADMIN)
    here = await _web(client, user)
    await _web(client, user, SAFARI)
    await _mobile(client, user)
    await _web(client, stranger)

    response = await client.get(MINE, headers=_bearer(here))
    assert response.status_code == 200
    items = response.json()
    assert len(items) == 3
    assert {i["user_id"] for i in items} == {user.id}
    assert [i["current"] for i in items] == [False, False, True]  # newest first; `here` is oldest
    assert items[2]["browser"] == "Chrome 141"
    assert (await client.get(MINE)).status_code == 401


async def test_sign_out_other_sessions_keeps_only_the_current_one(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user, stranger = await make_user(db, ADMIN), await make_user(db, ADMIN)
    here = await _web(client, user)
    elsewhere = await _web(client, user, SAFARI)
    phone = await _mobile(client, user)
    theirs = await _web(client, stranger)

    response = await client.post(f"{MINE}/revoke-others", headers=_bearer(here))
    assert response.status_code == 200
    assert response.json() == {"revoked": 2}
    assert await _refresh_status(client, elsewhere) == 401
    assert await _refresh_status(client, phone) == 401
    assert await _refresh_status(client, here) == 200
    assert await _refresh_status(client, theirs) == 200

    (item,) = (await client.get(MINE, headers=_bearer(here))).json()
    assert item["current"] is True
    (row,) = await audit_rows(db, "session.revoked_others")
    assert (row.actor_id, row.after) == (user.id, {"count": 2})
    ended = (
        await db.execute(
            select(AuthSession.end_reason).where(
                AuthSession.user_id == user.id, AuthSession.ended_at.is_not(None)
            )
        )
    ).scalars()
    assert set(ended) == {"signed_out_elsewhere"}

    # Nothing left to sign out: no audit noise.
    assert (await client.post(f"{MINE}/revoke-others", headers=_bearer(here))).json() == {
        "revoked": 0
    }
    assert len(await audit_rows(db, "session.revoked_others")) == 1


# --- the one-phone rule is about phones only --------------------------------------------------


async def test_web_sessions_do_not_count_toward_the_one_phone_rule(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    alice, bob = await make_user(db, ADMIN), await make_user(db, ADMIN)
    await _web(client, alice)
    await _web(client, alice, SAFARI)
    await _web(client, bob)

    # With any number of web sessions, the first phone is still active at once...
    assert (await _mobile(client, alice, 1))["device_status"] == "active"
    # ...web sessions never make a phone "in use"...
    assert (await _mobile(client, bob, 2))["device_status"] == "active"
    # ...and only a phone that is active for someone else makes a second account wait.
    carol = await make_user(db)
    await _web(client, alice)
    assert (await _mobile(client, carol, 1))["device_status"] == "pending"

    phones = (await db.execute(select(UserDevice))).scalars().all()
    assert len(phones) == 3  # one row per mobile sign-in, none for the four web sign-ins


# --- retention --------------------------------------------------------------------------------


async def test_purge_drops_sessions_that_ended_before_the_retention_period(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, ADMIN)
    long_gone = await _web(client, user)
    recent = await _web(client, user)
    never_ended_but_expired = await _web(client, user)
    live = await _web(client, user)
    old, new, lapsed, kept = (
        (
            await db.execute(
                select(AuthSession).where(AuthSession.user_id == user.id).order_by(AuthSession.id)
            )
        )
        .scalars()
        .all()
    )
    now = utcnow()
    for row, ended_at in ((old, now - timedelta(days=91)), (new, now - timedelta(days=89))):
        await db.execute(
            update(AuthSession).where(AuthSession.id == row.id).values(ended_at=ended_at)
        )
    await db.execute(
        update(AuthSession)
        .where(AuthSession.id == lapsed.id)
        .values(expires_at=now - timedelta(days=91))
    )

    assert await purge_ended(db, 90) == 2
    left = (
        (await db.execute(select(AuthSession.id).where(AuthSession.user_id == user.id)))
        .scalars()
        .all()
    )
    assert sorted(left) == [new.id, kept.id]
    families = set((await db.execute(select(RefreshToken.family_id))).scalars())
    assert old.family_id not in families and lapsed.family_id not in families
    assert new.family_id in families and kept.family_id in families
    assert await _refresh_status(client, live) == 200
    assert await _refresh_status(client, long_gone) == 401
    assert recent and never_ended_but_expired


async def test_the_worker_runs_the_purge_every_day() -> None:
    assert purge_sessions in WorkerSettings.functions
    # Not the only daily job any more (M3 added the face purge): find this one by its function.
    job = next(j for j in WorkerSettings.cron_jobs if j.coroutine is purge_sessions)
    assert (job.hour, job.minute) == (21, 30)
    assert await purge_sessions({}) >= 0


# --- an ended session stops working at once ---------------------------------------------------


async def _status(client: httpx.AsyncClient, tokens: Tokens, path: str = "/me") -> int:
    return (await client.get(f"{API}{path}", headers=_bearer(tokens))).status_code


async def test_a_session_signed_out_by_an_admin_is_refused_on_its_very_next_call(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, ADMIN)
    tokens = await _web(client, user)
    other = await _web(client, user, SAFARI)
    _, headers = await actor(client, db, SUPER_ADMIN)
    assert await _status(client, tokens) == 200  # the access token is fresh: 15 minutes to run

    newer, older = await _of(client, headers, user)
    assert (
        await client.post(f"{SESSIONS}/{older['id']}/revoke", headers=headers)
    ).status_code == 200

    response = await client.get(f"{API}/me", headers=_bearer(tokens))
    assert response.status_code == 401
    assert error_code(response) == "INVALID_TOKEN"
    assert await _status(client, tokens, "/admin/employees") == 401
    assert await _status(client, tokens, "/me/sessions") == 401
    # The same user's other sign-in keeps working.
    assert await _status(client, other) == 200
    assert newer["status"] == "active"


async def test_logout_and_sign_out_others_end_access_at_once(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, ADMIN)
    here, elsewhere, gone = (
        await _web(client, user),
        await _web(client, user),
        await _web(client, user),
    )

    await client.post(f"{API}/auth/logout", json={"refresh_token": gone["refresh_token"]})
    assert await _status(client, gone) == 401

    assert (await client.post(f"{MINE}/revoke-others", headers=_bearer(here))).json() == {
        "revoked": 1
    }
    assert await _status(client, elsewhere) == 401
    assert await _status(client, here) == 200


async def test_a_password_reset_ends_access_at_once(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, ADMIN)
    tokens = await _web(client, user)
    _, headers = await actor(client, db, SUPER_ADMIN)
    assert (
        await client.post(f"{API}/admin/employees/{user.id}/reset-password", headers=headers)
    ).status_code == 200
    assert await _status(client, tokens) == 401


async def test_a_revoked_phone_can_only_read_why_it_stopped(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    user = await make_user(db, ADMIN)
    tokens = await _mobile(client, user)
    _, headers = await actor(client, db, SUPER_ADMIN)
    phone = (
        await client.get(f"{API}/admin/devices", params={"user_id": user.id}, headers=headers)
    ).json()["items"][0]
    await client.patch(
        f"{API}/admin/devices/{phone['id']}", json={"action": "revoke"}, headers=headers
    )

    # /me still answers, so the app can say "this phone is no longer approved"...
    me = await client.get(f"{API}/me", headers=_bearer(tokens))
    assert me.status_code == 200
    assert me.json()["device"]["status"] == "revoked"
    # ...and nothing else does.
    assert await _status(client, tokens, "/me/sessions") == 401
    assert await _status(client, tokens, "/admin/employees") == 401
    assert await _status(client, tokens, "/admin/devices") == 401


async def test_a_token_without_a_session_is_refused(
    client: httpx.AsyncClient, db: AsyncSession, settings: Settings
) -> None:
    user = await make_user(db, ADMIN)
    for session_id in (None, "00000000-0000-0000-0000-000000000000"):
        token, _ = create_access_token(
            settings, user_id=user.id, device_row_id=None, client="web", session_id=session_id
        )
        response = await client.get(f"{API}/me", headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 401
        assert error_code(response) == "INVALID_TOKEN"


async def test_a_session_cannot_be_used_by_another_user(
    client: httpx.AsyncClient, db: AsyncSession, settings: Settings
) -> None:
    owner, intruder = await make_user(db, ADMIN), await make_user(db, ADMIN)
    await _web(client, owner)
    family = (
        await db.execute(select(AuthSession.family_id).where(AuthSession.user_id == owner.id))
    ).scalar_one()
    token, _ = create_access_token(
        settings, user_id=intruder.id, device_row_id=None, client="web", session_id=str(family)
    )
    response = await client.get(f"{API}/me", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401


async def test_checking_the_session_costs_no_extra_query(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    """The user and their session are read in one statement on every authenticated request."""
    user = await make_user(db, ADMIN)
    headers = _bearer(await _web(client, user))
    statements: list[str] = []

    def record(_conn: object, _cursor: object, statement: str, *_: object) -> None:
        if not statement.startswith(("SAVEPOINT", "RELEASE")):
            statements.append(statement)

    event.listen(Engine, "before_cursor_execute", record)
    try:
        db.expunge_all()  # production opens a fresh session per request
        assert (await client.get(f"{API}/admin/roles", headers=headers)).status_code == 200
    finally:
        event.remove(Engine, "before_cursor_execute", record)
    authentication, endpoint = statements
    assert "FROM users" in authentication and "auth_sessions" in authentication
    assert "FROM roles" in endpoint
