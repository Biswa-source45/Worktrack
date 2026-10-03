import re
from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)

from app.core.security import MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH

_MOBILE_NOISE = re.compile(r"[\s\-.()]")
_E164 = re.compile(r"\+[1-9][0-9]{7,14}")
_INDIA_MOBILE = re.compile(r"[6-9][0-9]{9}")
_INDIA_WITH_CODE = re.compile(r"91[0-9]{10}")


def normalize_mobile(value: str) -> str:
    """One canonical E.164 string per phone number; bare Indian numbers get +91.

    Migration 0003 keeps a frozen copy of this function: change both together or add a migration.
    """
    cleaned = _MOBILE_NOISE.sub("", value)
    if cleaned.startswith("00"):
        cleaned = "+" + cleaned[2:]
    elif _INDIA_MOBILE.fullmatch(cleaned):
        cleaned = "+91" + cleaned
    elif cleaned.startswith("0") and _INDIA_MOBILE.fullmatch(cleaned[1:]):
        cleaned = "+91" + cleaned[1:]
    elif _INDIA_WITH_CODE.fullmatch(cleaned):
        cleaned = "+" + cleaned
    if not _E164.fullmatch(cleaned):
        raise ValueError("Enter a valid mobile number")
    return cleaned


def _normalize_email(value: str) -> str:
    cleaned = value.strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", cleaned) or len(cleaned) > 254:
        raise ValueError("Enter a valid email address")
    return cleaned


def _normalize_emp_code(value: str) -> str:
    cleaned = value.strip().upper()
    if not re.fullmatch(r"[A-Z0-9][A-Z0-9_\-/]{0,31}", cleaned):
        raise ValueError("Use letters, digits, '-', '_' or '/' (max 32 characters)")
    return cleaned


Mobile = Annotated[str, AfterValidator(normalize_mobile)]
Email = Annotated[str, AfterValidator(_normalize_email)]
EmpCode = Annotated[str, AfterValidator(_normalize_emp_code)]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
Password = Annotated[str, Field(min_length=MIN_PASSWORD_LENGTH, max_length=MAX_PASSWORD_LENGTH)]
MasterName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)]


class Ref(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str


class EmployeeCreate(BaseModel):
    emp_code: EmpCode
    name: Name
    mobile: Mobile
    email: Email | None = None
    designation_id: int
    department_id: int | None = None
    role_id: int
    manager_id: int | None = None
    joined_on: date
    field_eligible: bool = False
    # Omit to have the server generate a temporary password (returned once).
    password: Password | None = None


class EmployeeUpdate(BaseModel):
    """Partial update: only the fields sent are changed (null clears email/department/manager)."""

    name: Name | None = None
    mobile: Mobile | None = None
    email: Email | None = None
    designation_id: int | None = None
    department_id: int | None = None
    role_id: int | None = None
    manager_id: int | None = None
    joined_on: date | None = None
    field_eligible: bool | None = None
    status: Literal["active", "inactive"] | None = None

    @model_validator(mode="after")
    def _required_fields_not_null(self) -> "EmployeeUpdate":
        required = ("name", "mobile", "designation_id", "role_id", "joined_on", "field_eligible")
        for field in (*required, "status"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null")
        return self


class EmployeeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    emp_code: str
    name: str
    mobile: str
    email: str | None
    role: Ref
    designation: Ref
    department: Ref | None
    manager_id: int | None
    field_eligible: bool
    status: str
    joined_on: date
    must_change_password: bool
    locked_until: datetime | None
    created_at: datetime


class EmployeeCreated(BaseModel):
    employee: EmployeeOut
    temporary_password: str | None


class EmployeePage(BaseModel):
    items: list[EmployeeOut]
    next_cursor: str | None


class DashboardOut(BaseModel):
    employees_total: int
    employees_active: int
    employees_inactive: int
    pending_devices: int


class TeamMemberOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    emp_code: str
    name: str
    designation: Ref
    field_eligible: bool
    manager_id: int | None


class TeamPage(BaseModel):
    items: list[TeamMemberOut]
    next_cursor: str | None


class TemporaryPassword(BaseModel):
    temporary_password: str


class MasterIn(BaseModel):
    name: MasterName


class RoleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    permissions: list[str]
    is_system: bool


class RoleCreate(BaseModel):
    name: MasterName
    permissions: list[str]


class RoleUpdate(BaseModel):
    name: MasterName | None = None
    permissions: list[str] | None = None


class ImportRowError(BaseModel):
    row: int
    message: str


class ImportCredential(BaseModel):
    emp_code: str
    name: str
    temporary_password: str


class ImportResult(BaseModel):
    dry_run: bool
    total_rows: int
    created: int
    errors: list[ImportRowError]
    # Only on a committed import; shown once and never stored.
    credentials: list[ImportCredential]
