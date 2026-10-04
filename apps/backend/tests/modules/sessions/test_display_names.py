"""OS and browser names as shown to people."""

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.os_name import format_os
from app.modules.sessions.user_agent import parse_user_agent
from tests.factories import device, login, make_user
from tests.modules.employees.helpers import API, actor


@pytest.mark.parametrize(
    ("stored", "shown"),
    [
        # Rows written by the first app version: Platform.OS + Platform.Version.
        ("ios 27.0.1", "iOS 27.0.1"),
        ("android 33", "Android 13"),  # an API level, not a version
        ("android 34", "Android 14"),
        ("android 32", "Android 12L"),
        ("android 99", "Android (API 99)"),
        # Rows written since: already proper, and unchanged.
        ("iOS 27.0.1", "iOS 27.0.1"),
        ("Android 13", "Android 13"),
        ("Android 14", "Android 14"),
        ("iPadOS 18.2", "iPadOS 18.2"),
        ("ipados 18.2", "iPadOS 18.2"),
        # Anything unknown is left alone.
        ("HarmonyOS 4", "HarmonyOS 4"),
        ("android", "Android"),
        ("", ""),
    ],
)
def test_format_os(stored: str, shown: str) -> None:
    assert format_os(stored) == shown


async def test_the_devices_list_shows_old_rows_with_proper_os_names(
    client: httpx.AsyncClient, db: AsyncSession
) -> None:
    old_iphone, old_android = await make_user(db), await make_user(db)
    await login(client, old_iphone, kind="mobile", device_info=device(1, os="ios 27.0.1"))
    await login(client, old_android, kind="mobile", device_info=device(2, os="android 33"))
    _, headers = await actor(client, db)
    items = (await client.get(f"{API}/admin/devices", headers=headers)).json()["items"]
    assert {i["user_id"]: i["os"] for i in items} == {
        old_iphone.id: "iOS 27.0.1",
        old_android.id: "Android 13",
    }


WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)"
MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)"


@pytest.mark.parametrize(
    ("user_agent", "browser", "system"),
    [
        (f"{WINDOWS} Chrome/141.0.0.0 Safari/537.36", "Chrome 141", "Windows"),
        (f"{WINDOWS} Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0", "Edge 141", "Windows"),
        (f"{WINDOWS} Chrome/126.0.0.0 Safari/537.36 OPR/112.0.0.0", "Opera 112", "Windows"),
        (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0",
            "Firefox 143",
            "Windows",
        ),
        (f"{MAC} Version/19.0 Safari/605.1.15", "Safari 19", "macOS"),
        (
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15"
            " (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
            "Safari 18",
            "iOS 18.5",
        ),
        (
            "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko)"
            " Chrome/141.0.0.0 Mobile Safari/537.36",
            "Chrome 141",
            "Android 14",
        ),
        (
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)"
            " Chrome/141.0.0.0 Safari/537.36",
            "Chrome 141",
            "Linux",
        ),
        ("okhttp/4.12.0", None, None),
        ("node", None, None),
        ("", None, None),
        (None, None, None),
    ],
)
def test_parse_user_agent(user_agent: str | None, browser: str | None, system: str | None) -> None:
    assert parse_user_agent(user_agent) == (browser, system)
