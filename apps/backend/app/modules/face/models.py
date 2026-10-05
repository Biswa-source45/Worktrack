import datetime as dt
from typing import Any

from sqlalchemy import CheckConstraint, ForeignKey, Index, LargeBinary, String, func, text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base

CONSENTED = "consented"
PENDING = "pending"
APPROVED = "approved"
REJECTED = "rejected"
RESET = "reset"
OPEN_STATUSES = (CONSENTED, PENDING, APPROVED)


class FaceEnrollment(Base):
    """One enrollment attempt: consent, then 3 photos, then an admin's decision.

    The photos and the encrypted template exist only while the row is pending or approved; a
    rejected or reset row keeps who, when and why, not the face. Never read `embeddings` outside
    `face.service`.
    """

    __tablename__ = "face_enrollments"
    __table_args__ = (
        CheckConstraint(
            "status IN ('consented', 'pending', 'approved', 'rejected', 'reset')", name="status"
        ),
        CheckConstraint(
            "(status IN ('pending', 'approved'))"
            " = (embeddings IS NOT NULL AND image_keys IS NOT NULL)",
            name="face_data_only_in_use",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    status: Mapped[str] = mapped_column(String(16))
    consent_at: Mapped[dt.datetime]
    submitted_at: Mapped[dt.datetime | None]
    image_keys: Mapped[list[str] | None] = mapped_column(ARRAY(String))
    # AES-GCM: nonce || ciphertext of 3 x 128 float32, bound to the user and this row.
    embeddings: Mapped[bytes | None] = mapped_column(LargeBinary)
    model_version: Mapped[str | None] = mapped_column(String(64))
    quality: Mapped[list[dict[str, Any]] | None] = mapped_column(JSONB)
    consistency_score: Mapped[float | None]
    decided_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    decided_at: Mapped[dt.datetime | None]
    reason: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[dt.datetime] = mapped_column(server_default=func.now())


# One enrollment in progress or in force per person; closed attempts pile up as history.
Index(
    "uq_face_enrollments_one_open_per_user",
    FaceEnrollment.user_id,
    unique=True,
    postgresql_where=text("status IN ('consented', 'pending', 'approved')"),
)
Index("ix_face_enrollments_status_id", FaceEnrollment.status, FaceEnrollment.id)
