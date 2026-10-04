from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.modules.auth.schemas import DeviceStatus


class DeviceConflict(BaseModel):
    """The other employee this phone is currently active for."""

    user_id: int
    emp_code: str
    name: str


class DeviceOut(BaseModel):
    id: int
    user_id: int
    emp_code: str
    user_name: str
    device_id: str
    model: str
    os: str
    app_version: str
    status: DeviceStatus
    approved_by: int | None
    created_at: datetime
    updated_at: datetime
    last_seen_at: datetime
    # Set on a pending phone that is active for another employee: approving it revokes theirs.
    conflict: DeviceConflict | None


class DeviceCounts(BaseModel):
    pending: int
    active: int
    revoked: int


class DevicePage(BaseModel):
    items: list[DeviceOut]
    counts: DeviceCounts
    next_cursor: str | None


class DeviceDecision(BaseModel):
    action: Literal["approve", "reject", "revoke"]
