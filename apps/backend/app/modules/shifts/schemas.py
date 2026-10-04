import datetime as dt
from decimal import Decimal
from typing import Annotated

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from app.modules.employees.schemas import MasterName

Hours = Annotated[Decimal, Field(gt=0, le=24, max_digits=4, decimal_places=2)]
GraceMin = Annotated[int, Field(ge=0, le=120)]
HolidayName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]


class WeeklyOff(BaseModel):
    # 0 = Monday, as in date.weekday().
    weekday: int = Field(ge=0, le=6)
    # Which occurrences of that weekday in the month are off; null means every week.
    weeks: list[Annotated[int, Field(ge=1, le=5)]] | None = None

    @field_validator("weeks")
    @classmethod
    def _sorted_unique(cls, weeks: list[int] | None) -> list[int] | None:
        if weeks is not None and (not weeks or weeks != sorted(set(weeks))):
            raise ValueError("weeks must be null or a sorted list of distinct weeks from 1 to 5")
        return weeks


def check_shift(
    start_time: dt.time, end_time: dt.time, half_day_hours: Decimal, full_day_hours: Decimal
) -> None:
    """Rules that span several fields; an update checks them against the stored values too."""
    if start_time.tzinfo is not None or end_time.tzinfo is not None:
        raise ValueError("Shift times are local times, without a time zone")
    if end_time <= start_time:
        raise ValueError(
            "The shift must end after it starts on the same day (overnight shifts are not"
            " supported)"
        )
    if half_day_hours > full_day_hours:
        raise ValueError("Half-day hours cannot be more than full-day hours")


def _one_entry_per_weekday(weekly_offs: list[WeeklyOff]) -> list[WeeklyOff]:
    weekdays = [off.weekday for off in weekly_offs]
    if len(weekdays) != len(set(weekdays)):
        raise ValueError("Each weekday may appear only once in weekly_offs")
    return weekly_offs


WeeklyOffs = Annotated[list[WeeklyOff], Field(max_length=7)]


class ShiftCreate(BaseModel):
    name: MasterName
    start_time: dt.time
    end_time: dt.time
    grace_min: GraceMin
    half_day_hours: Hours
    full_day_hours: Hours
    weekly_offs: WeeklyOffs = []

    @field_validator("weekly_offs")
    @classmethod
    def _weekdays(cls, weekly_offs: list[WeeklyOff]) -> list[WeeklyOff]:
        return _one_entry_per_weekday(weekly_offs)

    @model_validator(mode="after")
    def _consistent(self) -> "ShiftCreate":
        check_shift(self.start_time, self.end_time, self.half_day_hours, self.full_day_hours)
        return self


class ShiftUpdate(BaseModel):
    """Partial update: only the fields sent are changed. Nothing here can be null."""

    name: MasterName | None = None
    start_time: dt.time | None = None
    end_time: dt.time | None = None
    grace_min: GraceMin | None = None
    half_day_hours: Hours | None = None
    full_day_hours: Hours | None = None
    weekly_offs: WeeklyOffs | None = None
    is_active: bool | None = None

    @field_validator("weekly_offs")
    @classmethod
    def _weekdays(cls, weekly_offs: list[WeeklyOff] | None) -> list[WeeklyOff] | None:
        return None if weekly_offs is None else _one_entry_per_weekday(weekly_offs)

    @model_validator(mode="after")
    def _no_nulls(self) -> "ShiftUpdate":
        for field in self.model_fields_set:
            if getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null")
        return self


class ShiftOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    start_time: dt.time
    end_time: dt.time
    grace_min: int
    half_day_hours: float
    full_day_hours: float
    weekly_offs: list[WeeklyOff]
    is_active: bool


class ShiftPage(BaseModel):
    items: list[ShiftOut]
    next_cursor: str | None


class HolidayCreate(BaseModel):
    date: dt.date
    name: HolidayName
    # Omit or null: the holiday applies to every branch.
    branch_id: int | None = None


class HolidayUpdate(BaseModel):
    """Partial update: only the fields sent are changed (a null branch_id means every branch)."""

    date: dt.date | None = None
    name: HolidayName | None = None
    branch_id: int | None = None

    @model_validator(mode="after")
    def _required_fields_not_null(self) -> "HolidayUpdate":
        for field in ("date", "name"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null")
        return self


class HolidayOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    date: dt.date
    name: str
    branch_id: int | None


class HolidayPage(BaseModel):
    items: list[HolidayOut]
    next_cursor: str | None
