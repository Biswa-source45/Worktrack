import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, Index, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class RefreshToken(Base):
    """Only the SHA-256 of the token is stored. Tokens of one login share a family."""

    __tablename__ = "refresh_tokens"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    device_row_id: Mapped[int | None] = mapped_column(ForeignKey("user_devices.id"))
    family_id: Mapped[uuid.UUID]
    token_hash: Mapped[str] = mapped_column(String(64))
    client: Mapped[str] = mapped_column(String(8))
    expires_at: Mapped[datetime]
    revoked_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


Index("uq_refresh_tokens_token_hash", RefreshToken.token_hash, unique=True)
Index("ix_refresh_tokens_family_id", RefreshToken.family_id)
Index("ix_refresh_tokens_user_id", RefreshToken.user_id)
Index("ix_refresh_tokens_device_row_id", RefreshToken.device_row_id)
