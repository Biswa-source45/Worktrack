from typing import Annotated, Literal, Self

from pydantic import BaseModel, Field, StringConstraints, model_validator

from app.core.security import MAX_PASSWORD_LENGTH
from app.modules.employees.schemas import Password, Ref

Client = Literal["web", "mobile"]
DeviceStatus = Literal["active", "pending", "revoked"]
PendingReason = Literal["phone_in_use"]


class DeviceInfo(BaseModel):
    device_id: Annotated[str, StringConstraints(min_length=8, max_length=128)]
    model: Annotated[str, StringConstraints(min_length=1, max_length=120)]
    os: Annotated[str, StringConstraints(min_length=1, max_length=64)]
    app_version: Annotated[str, StringConstraints(min_length=1, max_length=32)]


class LoginRequest(BaseModel):
    identifier: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)
    ]
    password: Annotated[str, Field(min_length=1, max_length=MAX_PASSWORD_LENGTH)]
    client: Client
    device: DeviceInfo | None = None

    @model_validator(mode="after")
    def _mobile_needs_device(self) -> Self:
        if self.client == "mobile" and self.device is None:
            raise ValueError("device is required for mobile logins")
        return self


class RefreshRequest(BaseModel):
    refresh_token: Annotated[str, StringConstraints(min_length=1, max_length=256)]


class ChangePasswordRequest(BaseModel):
    current_password: Annotated[str, Field(min_length=1, max_length=MAX_PASSWORD_LENGTH)]
    new_password: Password


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: Literal["bearer"] = "bearer"  # noqa: S105  # OAuth token type, not a secret
    expires_in: int
    must_change_password: bool
    device_status: DeviceStatus | None


class MeDevice(BaseModel):
    id: int
    status: DeviceStatus
    # Why a pending phone waits, when it is more than a normal phone change.
    pending_reason: PendingReason | None


class MeResponse(BaseModel):
    id: int
    emp_code: str
    name: str
    mobile: str
    email: str | None
    role: Ref
    permissions: list[str]
    designation: Ref
    department: Ref | None
    manager_id: int | None
    field_eligible: bool
    must_change_password: bool
    client: Client
    device: MeDevice | None
