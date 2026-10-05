from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from app.modules.branches.models import RADIUS_MAX_M, RADIUS_MIN_M

BranchName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
Address = Annotated[str, StringConstraints(strip_whitespace=True, max_length=255)]
Lat = Annotated[float, Field(ge=-90, le=90)]
Lng = Annotated[float, Field(ge=-180, le=180)]
Radius = Annotated[int, Field(ge=RADIUS_MIN_M, le=RADIUS_MAX_M)]


class BranchCreate(BaseModel):
    name: BranchName
    address: Address | None = None
    lat: Lat
    lng: Lng
    # Omit to use the organisation's default radius (Settings).
    radius_m: Radius | None = None


class BranchUpdate(BaseModel):
    """Partial update: only the fields sent are changed (null clears the address)."""

    name: BranchName | None = None
    address: Address | None = None
    lat: Lat | None = None
    lng: Lng | None = None
    radius_m: Radius | None = None
    is_active: bool | None = None

    @model_validator(mode="after")
    def _required_fields_not_null(self) -> "BranchUpdate":
        for field in ("name", "lat", "lng", "radius_m", "is_active"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null")
        return self


class BranchOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    address: str | None
    lat: float
    lng: float
    radius_m: int
    is_active: bool


class BranchPage(BaseModel):
    items: list[BranchOut]
    next_cursor: str | None


class LinkIn(BaseModel):
    url: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2048)]


class PlaceOut(BaseModel):
    lat: Lat
    lng: Lng
    name: str | None


class SearchHit(BaseModel):
    label: str
    lat: Lat
    lng: Lng
