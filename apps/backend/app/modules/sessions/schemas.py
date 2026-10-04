from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.modules.auth.schemas import Client

SessionStatus = Literal["active", "ended"]


class SessionOut(BaseModel):
    id: int
    user_id: int
    emp_code: str
    user_name: str
    client: Client
    # Web: parsed from the browser's user agent. Mobile: the phone's own model and OS.
    browser: str | None
    os: str | None
    device_model: str | None
    ip: str | None
    created_at: datetime
    last_seen_at: datetime
    status: SessionStatus
    ended_at: datetime | None
    end_reason: str | None
    # The session this request itself is signed in with.
    current: bool


class SessionCounts(BaseModel):
    active: int
    ended: int


class SessionPage(BaseModel):
    items: list[SessionOut]
    counts: SessionCounts
    next_cursor: str | None


class RevokedOthers(BaseModel):
    revoked: int
