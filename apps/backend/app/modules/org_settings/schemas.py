from pydantic import BaseModel, ConfigDict, Field

from app.modules.branches.models import RADIUS_MAX_M, RADIUS_MIN_M


class OrgSettings(BaseModel):
    """Every organisation setting, with its default and bounds. There are no other keys.

    Also the PATCH body: every field has a default, so a request may send any subset, and only
    the fields it sent (`model_fields_set`) are changed.
    """

    model_config = ConfigDict(extra="forbid")

    geofence_default_radius_m: int = Field(100, ge=RADIUS_MIN_M, le=RADIUS_MAX_M)
    home_default_radius_m: int = Field(100, ge=RADIUS_MIN_M, le=RADIUS_MAX_M)
    gps_max_accuracy_m: int = Field(50, ge=5, le=500)
    geofence_accuracy_buffer_cap_m: int = Field(30, ge=0, le=100)
    punch_out_approval_levels: int = Field(1, ge=1, le=2)
    regularization_approval_levels: int = Field(1, ge=1, le=2)
    min_app_version: str = Field("0.0.0", pattern=r"^\d{1,4}\.\d{1,4}\.\d{1,4}$")
