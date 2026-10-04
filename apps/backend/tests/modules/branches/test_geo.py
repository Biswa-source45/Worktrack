"""Pin helpers: Google Maps links and address search. No test touches the real network."""

from collections.abc import AsyncIterator, Callable
from typing import Any

import httpx
import pytest
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.modules.auth.permissions import BRANCHES_MANAGE, EMPLOYEES_MANAGE, SETTINGS_VIEW
from app.modules.branches.geo import MAX_HOPS, SEARCH_LOCK_KEY, parse_link
from tests.factories import headers_with
from tests.modules.employees.helpers import API, actor, error_code

RESOLVE = f"{API}/admin/geo/resolve-link"
SEARCH = f"{API}/admin/geo/search"
SHORT = "https://maps.app.goo.gl/AbCdEf123"
PLACE = (
    "https://www.google.com/maps/place/Lingaraj+Temple/@20.2382,85.8315,17z/data=!3m1!4b1!4m6"
    "!3m5!1s0x3a19a0:0x1!8m2!3d20.2382437!4d85.8337672!16zL20?entry=ttu"
)
NOMINATIM = [
    {
        "display_name": "Saheed Nagar, Bhubaneswar, Odisha, India",
        "lat": "20.2961",
        "lon": "85.8245",
    },
    {"display_name": "Saheed Nagar Road, Cuttack", "lat": "20.4625", "lon": "85.8830"},
]


class Upstream:
    """Stands in for the internet: records every outbound request and answers with `reply`."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.reply: Callable[[httpx.Request], httpx.Response] = self._unexpected

    @staticmethod
    def _unexpected(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"unexpected outbound request to {request.url.host}")

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.reply(request)

    @property
    def urls(self) -> list[str]:
        return [str(request.url) for request in self.requests]


def _state(client: httpx.AsyncClient) -> Any:
    transport = client._transport
    assert isinstance(transport, httpx.ASGITransport)
    return transport.app.state


@pytest.fixture
async def upstream(client: httpx.AsyncClient) -> AsyncIterator[Upstream]:
    state = _state(client)
    fake = Upstream()
    await state.http.aclose()
    state.http = httpx.AsyncClient(transport=httpx.MockTransport(fake.handle))
    redis: Redis = state.redis
    await _forget_searches(redis)
    yield fake
    await _forget_searches(redis)


async def _forget_searches(redis: Redis) -> None:
    keys = [key async for key in redis.scan_iter("geo:search:*")]
    if keys:
        await redis.delete(*keys)


def redirect(location: str) -> httpx.Response:
    return httpx.Response(302, headers={"Location": location})


def redirects(hops: dict[str, str]) -> Callable[[httpx.Request], httpx.Response]:
    return lambda request: redirect(hops[str(request.url)])


# --- reading a full link (pure) ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        # The pin of a place wins over the camera position after the @.
        (PLACE, (20.2382437, 85.8337672, "Lingaraj Temple")),
        (
            "https://www.google.com/maps/place/Caf%C3%A9+Coffee+Day/@12.9716,77.5946,17z",
            (12.9716, 77.5946, "Café Coffee Day"),
        ),
        # Street View and plain map views only have the camera position.
        (
            "https://www.google.com/maps/@20.2961,85.8245,3a,75y,90t/data=!3m6!1e1!3m4",
            (20.2961, 85.8245, None),
        ),
        ("https://google.com/maps/@-33.8688,151.2093,15z", (-33.8688, 151.2093, None)),
        ("https://maps.google.com/?q=20.2961,85.8245", (20.2961, 85.8245, None)),
        ("https://maps.google.com/maps?q=20.2961,+85.8245&z=17", (20.2961, 85.8245, None)),
        ("https://www.google.com/maps?ll=-33.8688,151.2093&z=12", (-33.8688, 151.2093, None)),
        (
            "https://www.google.com/maps/search/?api=1&query=20.2961%2C85.8245",
            (20.2961, 85.8245, None),
        ),
        ("  https://maps.google.com/?q=20,85  ", (20.0, 85.0, None)),
    ],
)
def test_coordinates_are_read_from_a_full_link(
    url: str, expected: tuple[float, float, str | None]
) -> None:
    place = parse_link(url)
    assert place is not None
    assert (place.lat, place.lng, place.name) == expected


@pytest.mark.parametrize(
    "url",
    [
        # Foreign hosts, however much they look like Google.
        "https://evil.example/maps/@20.2961,85.8245,17z",
        "https://maps.google.com.evil.example/?q=20.2961,85.8245",
        "https://www.google.com@evil.example/maps/@20.2961,85.8245,17z",
        "https://www.google.co.in/maps/@20.2961,85.8245,17z",
        # Not https, or not the standard port.
        "http://maps.google.com/?q=20.2961,85.8245",
        "http://www.google.com/maps/@20.2961,85.8245,17z",
        "https://maps.google.com:8443/?q=20.2961,85.8245",
        "ftp://maps.google.com/?q=20.2961,85.8245",
        # google.com, but not Maps.
        "https://www.google.com/search?q=20.2961,85.8245",
        "https://google.com/url?q=20.2961,85.8245",
        "https://www.google.com/mapsearch/@20.2961,85.8245,17z",
        # Nothing to read.
        "https://www.google.com/maps/place/Lingaraj+Temple",
        "https://maps.google.com/?q=Lingaraj+Temple",
        "https://maps.google.com/?q=120.5,85.8245",
        "https://maps.google.com/?q=20.2961,185.8",
        SHORT,
        "not a link",
        "https://[broken/?q=20,85",
    ],
)
def test_other_links_are_refused(url: str) -> None:
    assert parse_link(url) is None


# --- resolve-link endpoint --------------------------------------------------------------------


async def test_a_full_link_is_resolved_without_any_network(
    client: httpx.AsyncClient, db: AsyncSession, upstream: Upstream
) -> None:
    _, headers = await actor(client, db)
    response = await client.post(RESOLVE, json={"url": PLACE}, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json() == {"lat": 20.2382437, "lng": 85.8337672, "name": "Lingaraj Temple"}
    assert upstream.requests == []


async def test_a_short_link_is_followed_to_the_full_link(
    client: httpx.AsyncClient, db: AsyncSession, upstream: Upstream
) -> None:
    _, headers = await actor(client, db)
    middle = "https://maps.google.com/?cid=1234567890"
    upstream.reply = redirects({SHORT: middle, middle: PLACE})
    response = await client.post(RESOLVE, json={"url": SHORT}, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json() == {"lat": 20.2382437, "lng": 85.8337672, "name": "Lingaraj Temple"}
    assert upstream.urls == [SHORT, middle]


async def test_a_relative_redirect_stays_on_the_same_host(
    client: httpx.AsyncClient, db: AsyncSession, upstream: Upstream
) -> None:
    _, headers = await actor(client, db)
    start = "https://maps.google.com/?cid=42"
    upstream.reply = redirects({start: "/maps?q=20.2961,85.8245"})
    response = await client.post(RESOLVE, json={"url": start}, headers=headers)
    assert response.json() == {"lat": 20.2961, "lng": 85.8245, "name": None}
    assert upstream.urls == [start]


@pytest.mark.parametrize(
    "target",
    [
        "https://evil.example/maps/@20.2961,85.8245,17z",
        "http://169.254.169.254/latest/meta-data/",
        "http://www.google.com/maps/@20.2961,85.8245,17z",
        "https://www.google.com/search?q=20.2961,85.8245",
        "https://localhost:8000/health",
    ],
)
async def test_a_redirect_off_google_maps_is_refused_and_never_fetched(
    client: httpx.AsyncClient, db: AsyncSession, upstream: Upstream, target: str
) -> None:
    _, headers = await actor(client, db)
    upstream.reply = redirects({SHORT: target})
    response = await client.post(RESOLVE, json={"url": SHORT}, headers=headers)
    assert (response.status_code, error_code(response)) == (422, "LINK_NOT_RESOLVED")
    assert "paste the full link" in response.json()["error"]["message"]
    assert upstream.urls == [SHORT]


async def test_a_foreign_link_is_refused_without_any_network(
    client: httpx.AsyncClient, db: AsyncSession, upstream: Upstream
) -> None:
    _, headers = await actor(client, db)
    for url in ("https://evil.example/?q=20,85", "http://maps.app.goo.gl/AbCdEf123"):
        response = await client.post(RESOLVE, json={"url": url}, headers=headers)
        assert (response.status_code, error_code(response)) == (422, "LINK_NOT_RESOLVED")
    assert upstream.requests == []


async def test_redirects_are_followed_only_so_far(
    client: httpx.AsyncClient, db: AsyncSession, upstream: Upstream
) -> None:
    _, headers = await actor(client, db)
    upstream.reply = lambda request: redirect(f"https://goo.gl/maps/{len(upstream.requests)}")
    response = await client.post(RESOLVE, json={"url": SHORT}, headers=headers)
    assert (response.status_code, error_code(response)) == (422, "LINK_NOT_RESOLVED")
    assert len(upstream.requests) == MAX_HOPS == 5


async def test_a_link_on_the_last_allowed_hop_still_resolves(
    client: httpx.AsyncClient, db: AsyncSession, upstream: Upstream
) -> None:
    _, headers = await actor(client, db)

    def reply(request: httpx.Request) -> httpx.Response:
        hop = len(upstream.requests)
        return redirect(PLACE if hop == MAX_HOPS else f"https://goo.gl/maps/{hop}")

    upstream.reply = reply
    response = await client.post(RESOLVE, json={"url": SHORT}, headers=headers)
    assert response.status_code == 200
    assert len(upstream.requests) == MAX_HOPS


@pytest.mark.parametrize(
    "failure", [httpx.ConnectTimeout("slow"), httpx.ReadTimeout("slow"), httpx.ConnectError("down")]
)
async def test_a_network_failure_is_reported_as_an_unreadable_link(
    client: httpx.AsyncClient, db: AsyncSession, upstream: Upstream, failure: httpx.HTTPError
) -> None:
    _, headers = await actor(client, db)

    def reply(request: httpx.Request) -> httpx.Response:
        raise failure

    upstream.reply = reply
    response = await client.post(RESOLVE, json={"url": SHORT}, headers=headers)
    assert (response.status_code, error_code(response)) == (422, "LINK_NOT_RESOLVED")


@pytest.mark.parametrize("status", [200, 404, 500])
async def test_a_link_that_leads_nowhere_is_not_resolved(
    client: httpx.AsyncClient, db: AsyncSession, upstream: Upstream, status: int
) -> None:
    _, headers = await actor(client, db)
    upstream.reply = lambda request: httpx.Response(status, text="<html>consent</html>")
    response = await client.post(RESOLVE, json={"url": SHORT}, headers=headers)
    assert (response.status_code, error_code(response)) == (422, "LINK_NOT_RESOLVED")
    assert upstream.urls == [SHORT]


@pytest.mark.parametrize("body", [{}, {"url": ""}, {"url": "   "}, {"url": "x" * 2049}])
async def test_resolve_link_validates_its_body(
    client: httpx.AsyncClient, db: AsyncSession, upstream: Upstream, body: dict[str, str]
) -> None:
    _, headers = await actor(client, db)
    response = await client.post(RESOLVE, json=body, headers=headers)
    assert (response.status_code, error_code(response)) == (422, "VALIDATION_ERROR")


# --- search endpoint --------------------------------------------------------------------------


def nominatim(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json=NOMINATIM)


async def test_search_maps_the_geocoder_answer(
    client: httpx.AsyncClient, db: AsyncSession, upstream: Upstream, settings: Settings
) -> None:
    _, headers = await actor(client, db)
    upstream.reply = nominatim
    response = await client.get(SEARCH, params={"q": " Saheed Nagar "}, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json() == [
        {"label": "Saheed Nagar, Bhubaneswar, Odisha, India", "lat": 20.2961, "lng": 85.8245},
        {"label": "Saheed Nagar Road, Cuttack", "lat": 20.4625, "lng": 85.883},
    ]
    [request] = upstream.requests
    assert str(request.url).split("?")[0] == settings.geocoder_url
    assert dict(request.url.params) == {"format": "jsonv2", "limit": "5", "q": "Saheed Nagar"}
    agent = request.headers["user-agent"]
    assert agent.startswith("WorkTrack/")
    assert agent.endswith(" (admin geocoding)")


async def test_search_returns_at_most_five_places(
    client: httpx.AsyncClient, db: AsyncSession, upstream: Upstream
) -> None:
    _, headers = await actor(client, db)
    many = [{"display_name": f"Place {n}", "lat": "20.0", "lon": "85.0"} for n in range(8)]
    upstream.reply = lambda request: httpx.Response(200, json=many)
    response = await client.get(SEARCH, params={"q": "many places"}, headers=headers)
    assert [hit["label"] for hit in response.json()] == [f"Place {n}" for n in range(5)]


async def test_a_repeated_search_is_answered_from_the_cache(
    client: httpx.AsyncClient, db: AsyncSession, upstream: Upstream
) -> None:
    _, headers = await actor(client, db)
    upstream.reply = nominatim
    first = await client.get(SEARCH, params={"q": "Saheed Nagar"}, headers=headers)
    # No wait is needed either: a cached answer does not count against the one-per-second limit.
    second = await client.get(SEARCH, params={"q": "saheed nagar"}, headers=headers)
    assert second.status_code == 200
    assert second.json() == first.json()
    assert len(upstream.requests) == 1
    redis: Redis = _state(client).redis
    [cached] = [key async for key in redis.scan_iter("geo:search:*") if key != b"geo:search:lock"]
    assert 86_000 < await redis.ttl(cached) <= 86_400


async def test_a_second_new_search_within_a_second_is_told_to_wait(
    client: httpx.AsyncClient, db: AsyncSession, upstream: Upstream
) -> None:
    _, headers = await actor(client, db)
    upstream.reply = nominatim
    assert (await client.get(SEARCH, params={"q": "first"}, headers=headers)).status_code == 200
    response = await client.get(SEARCH, params={"q": "second"}, headers=headers)
    assert (response.status_code, error_code(response)) == (429, "SEARCH_BUSY")
    assert len(upstream.requests) == 1
    assert 0 < await _state(client).redis.pttl(SEARCH_LOCK_KEY) <= 1000

    # Once the second has passed, the search goes through.
    await _state(client).redis.delete(SEARCH_LOCK_KEY)
    assert (await client.get(SEARCH, params={"q": "second"}, headers=headers)).status_code == 200


@pytest.mark.parametrize(
    "reply",
    [
        lambda request: httpx.Response(503, text="busy"),
        lambda request: httpx.Response(403, text="blocked"),
        lambda request: httpx.Response(200, text="<html>not json</html>"),
        lambda request: httpx.Response(200, json=[{"display_name": "No coordinates"}]),
        lambda request: httpx.Response(200, json=[{"display_name": "x", "lat": "n", "lon": "1"}]),
        lambda request: httpx.Response(200, json={"error": "nope"}),
    ],
)
async def test_a_geocoder_failure_is_a_502_and_is_not_cached(
    client: httpx.AsyncClient,
    db: AsyncSession,
    upstream: Upstream,
    reply: Callable[[httpx.Request], httpx.Response],
) -> None:
    _, headers = await actor(client, db)
    upstream.reply = reply
    response = await client.get(SEARCH, params={"q": "Saheed Nagar"}, headers=headers)
    assert (response.status_code, error_code(response)) == (502, "SEARCH_UNAVAILABLE")

    await _state(client).redis.delete(SEARCH_LOCK_KEY)
    upstream.reply = nominatim
    again = await client.get(SEARCH, params={"q": "Saheed Nagar"}, headers=headers)
    assert again.status_code == 200
    assert len(upstream.requests) == 2


async def test_a_geocoder_timeout_is_a_502(
    client: httpx.AsyncClient, db: AsyncSession, upstream: Upstream
) -> None:
    _, headers = await actor(client, db)

    def reply(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow")

    upstream.reply = reply
    response = await client.get(SEARCH, params={"q": "Saheed Nagar"}, headers=headers)
    assert (response.status_code, error_code(response)) == (502, "SEARCH_UNAVAILABLE")


@pytest.mark.parametrize("q", ["ab", " ab ", "x" * 121, None])
async def test_search_needs_three_to_120_characters(
    client: httpx.AsyncClient, db: AsyncSession, upstream: Upstream, q: str | None
) -> None:
    _, headers = await actor(client, db)
    params = {} if q is None else {"q": q}
    response = await client.get(SEARCH, params=params, headers=headers)
    assert (response.status_code, error_code(response)) == (422, "VALIDATION_ERROR")
    assert upstream.requests == []


# --- permissions ------------------------------------------------------------------------------


@pytest.mark.parametrize("permission", [BRANCHES_MANAGE, EMPLOYEES_MANAGE])
async def test_either_branches_or_employees_manage_may_place_a_pin(
    client: httpx.AsyncClient, db: AsyncSession, upstream: Upstream, permission: str
) -> None:
    headers = await headers_with(client, db, permission)
    upstream.reply = nominatim
    assert (await client.post(RESOLVE, json={"url": PLACE}, headers=headers)).status_code == 200
    found = await client.get(SEARCH, params={"q": "Saheed Nagar"}, headers=headers)
    assert found.status_code == 200


async def test_without_either_permission_the_pin_helpers_are_forbidden(
    client: httpx.AsyncClient, db: AsyncSession, upstream: Upstream
) -> None:
    headers = await headers_with(client, db, SETTINGS_VIEW)
    resolved = await client.post(RESOLVE, json={"url": PLACE}, headers=headers)
    assert (resolved.status_code, error_code(resolved)) == (403, "FORBIDDEN")
    found = await client.get(SEARCH, params={"q": "Saheed Nagar"}, headers=headers)
    assert (found.status_code, error_code(found)) == (403, "FORBIDDEN")
    assert upstream.requests == []
