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
    # Face matching (SRS 9.7). Cosine scores: at or above `verify` is VERIFIED, from `review` up to
    # `verify` goes to an admin, below `review` is a MISMATCH.
    face_verify_threshold: float = Field(0.40, ge=0.2, le=0.9)
    face_review_threshold: float = Field(0.30, ge=0.1, le=0.8)
    # Photo quality gates, checked on the server for every enrollment photo and punch selfie.
    face_min_detection_confidence: float = Field(0.90, ge=0.5, le=0.99)
    face_min_face_px: int = Field(80, ge=40, le=400)
    face_min_sharpness: float = Field(60, ge=1, le=2000)
    face_min_brightness: int = Field(50, ge=0, le=254)
    face_max_brightness: int = Field(200, ge=1, le=255)
    # Photos and templates are deleted this many days after an employee is deactivated.
    face_retention_days_after_exit: int = Field(30, ge=0, le=365)
