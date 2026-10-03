from datetime import datetime

from sqlalchemy import CheckConstraint, ForeignKey, Index, String, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base

DEVICE_ACTIVE = "active"
DEVICE_PENDING = "pending"
DEVICE_REVOKED = "revoked"


class UserDevice(Base):
    __tablename__ = "user_devices"
    __table_args__ = (CheckConstraint("status IN ('active', 'pending', 'revoked')", name="status"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    device_id: Mapped[str] = mapped_column(String(128))
    model: Mapped[str] = mapped_column(String(120))
    os: Mapped[str] = mapped_column(String(64))
    app_version: Mapped[str] = mapped_column(String(32))
    fcm_token: Mapped[str | None] = mapped_column(String(512))
    status: Mapped[str] = mapped_column(String(16))
    approved_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())


# One phone per account (US-1.2): at most one active and one pending device per user.
Index(
    "uq_user_devices_one_active",
    UserDevice.user_id,
    unique=True,
    postgresql_where=text("status = 'active'"),
)
Index(
    "uq_user_devices_one_pending",
    UserDevice.user_id,
    unique=True,
    postgresql_where=text("status = 'pending'"),
)
