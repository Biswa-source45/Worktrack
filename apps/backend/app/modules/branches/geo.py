"""Helpers for placing a pin: read a Google Maps link, or search for an address.

Pasted links, queries and coordinates are never logged.
"""

import hashlib
import logging
import re
from urllib.parse import SplitResult, parse_qs, unquote_plus, urljoin, urlsplit

import httpx
from pydantic import TypeAdapter
from redis.asyncio import Redis
from redis.exceptions import RedisError

from app.core.errors import AppError
from app.modules.branches.schemas import PlaceOut, SearchHit

logger = logging.getLogger(__name__)

SHORT_HOSTS = frozenset({"maps.app.goo.gl", "goo.gl"})
# Only on google.com itself does the path decide whether a URL is a Maps URL.
MAPS_PATH_HOSTS = frozenset({"www.google.com", "google.com"})
ALLOWED_HOSTS = SHORT_HOSTS | MAPS_PATH_HOSTS | {"maps.google.com"}
MAX_HOPS = 5
TIMEOUT_SECONDS = 5

_NUMBER = r"(-?\d{1,3}(?:\.\d+)?)"
# The pin of a place. `@lat,lng` is only where the camera looks, so the pin is preferred.
_PIN = re.compile(rf"!3d{_NUMBER}!4d{_NUMBER}")
_VIEW = re.compile(rf"@{_NUMBER},{_NUMBER}")
_PAIR = re.compile(rf"\s*{_NUMBER}\s*,\s*{_NUMBER}\s*")
_NAME = re.compile(r"^/maps/place/([^/@]+)")
_QUERY_KEYS = ("q", "ll", "query")

SEARCH_CACHE_SECONDS = 24 * 60 * 60
# The geocoder's usage policy: at most one request per second, for the whole deployment.
SEARCH_LOCK_KEY = "geo:search:lock"
SEARCH_LOCK_MS = 1000
_hits = TypeAdapter(list[SearchHit])


def _not_resolved() -> AppError:
    return AppError(
        "LINK_NOT_RESOLVED",
        "Could not read that link. Open it in a browser and paste the full link from the"
        " address bar.",
        422,
    )


def _maps_url(url: str) -> SplitResult | None:
    """The parsed URL if it is an https Google Maps URL, else None."""
    try:
        parts = urlsplit(url.strip())
        port = parts.port
    except ValueError:
        return None
    host = parts.hostname
    if parts.scheme != "https" or host not in ALLOWED_HOSTS or port not in (None, 443):
        return None
    if parts.username is not None or parts.password is not None:
        return None
    if host in MAPS_PATH_HOSTS and not (parts.path == "/maps" or parts.path.startswith("/maps/")):
        return None
    return parts


def _place(lat: str, lng: str, name: str | None) -> PlaceOut | None:
    if abs(float(lat)) > 90 or abs(float(lng)) > 180:
        return None
    return PlaceOut(lat=float(lat), lng=float(lng), name=name)


def _coordinates(parts: SplitResult) -> PlaceOut | None:
    found = _NAME.match(parts.path)
    name = unquote_plus(found.group(1)).strip() or None if found else None
    match = _PIN.search(parts.path) or _VIEW.search(parts.path)
    if match:
        return _place(match.group(1), match.group(2), name)
    query = parse_qs(parts.query)
    for key in _QUERY_KEYS:
        for value in query.get(key, []):
            pair = _PAIR.fullmatch(value)
            if pair:
                return _place(pair.group(1), pair.group(2), name)
    return None


def parse_link(url: str) -> PlaceOut | None:
    """Coordinates (and the place name, if any) in a full Google Maps URL. No network."""
    parts = _maps_url(url)
    return None if parts is None else _coordinates(parts)


async def resolve_link(http: httpx.AsyncClient, url: str) -> PlaceOut:
    """Read a pasted Google Maps link, following a short link's redirects to the full URL.

    Redirects are followed by hand so that every hop is checked against the host allow-list
    before it is fetched: the server never requests a URL outside Google Maps.
    """
    for hop in range(MAX_HOPS + 1):
        parts = _maps_url(url)
        if parts is None:
            raise _not_resolved()
        place = _coordinates(parts)
        if place is not None:
            return place
        if hop == MAX_HOPS:
            break
        try:
            # Streamed and closed unread: only the Location header matters.
            async with http.stream(
                "GET", url, follow_redirects=False, timeout=TIMEOUT_SECONDS
            ) as response:
                location = response.headers.get("location") if response.is_redirect else None
        except (httpx.HTTPError, httpx.InvalidURL):
            raise _not_resolved() from None
        if not location:
            break
        url = urljoin(url, location)
    raise _not_resolved()


async def search(
    http: httpx.AsyncClient, redis: Redis, geocoder_url: str, user_agent: str, query: str
) -> list[SearchHit]:
    """Up to five places matching the query. Answers are cached for a day."""
    key = "geo:search:" + hashlib.sha256(query.lower().encode()).hexdigest()
    try:
        cached = await redis.get(key)
        if cached is not None:
            return _hits.validate_json(cached)
        if not await redis.set(SEARCH_LOCK_KEY, 1, nx=True, px=SEARCH_LOCK_MS):
            raise AppError("SEARCH_BUSY", "Search is busy. Try again in a moment.", 429)
        response = await http.get(
            geocoder_url,
            params={"format": "jsonv2", "limit": 5, "q": query},
            headers={"User-Agent": user_agent},
            timeout=TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        hits = [
            SearchHit(label=item["display_name"], lat=item["lat"], lng=item["lon"])
            for item in response.json()[:5]
        ]
        await redis.set(key, _hits.dump_json(hits), ex=SEARCH_CACHE_SECONDS)
    except (httpx.HTTPError, RedisError, ValueError, KeyError, TypeError) as exc:
        # Without Redis the one-per-second limit cannot be kept, so the search is refused too.
        logger.error("Address search failed: %s", type(exc).__name__)
        raise AppError(
            "SEARCH_UNAVAILABLE", "Address search is not available right now.", 502
        ) from None
    return hits
