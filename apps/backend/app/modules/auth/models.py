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


class AuthSession(Base):
    """One sign-in: the refresh-token family, with where it came from and when it ended."""

    __tablename__ = "auth_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    family_id: Mapped[uuid.UUID]
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    client: Mapped[str] = mapped_column(String(8))
    # Set for mobile sign-ins only; a web session is never a phone.
    device_row_id: Mapped[int | None] = mapped_column(ForeignKey("user_devices.id"))
    user_agent: Mapped[str | None] = mapped_column(String(512))
    browser: Mapped[str | None] = mapped_column(String(64))
    os: Mapped[str | None] = mapped_column(String(64))
    ip: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    last_seen_at: Mapped[datetime] = mapped_column(server_default=func.now())
    # When the newest refresh token runs out; a session nobody ended is over at this time.
    expires_at: Mapped[datetime]
    ended_at: Mapped[datetime | None]
    end_reason: Mapped[str | None] = mapped_column(String(32))


Index("uq_auth_sessions_family_id", AuthSession.family_id, unique=True)
Index("ix_auth_sessions_user_id", AuthSession.user_id)
Index("ix_auth_sessions_device_row_id", AuthSession.device_row_id)
Index("ix_auth_sessions_ended_at", AuthSession.ended_at)

Index("uq_refresh_tokens_token_hash", RefreshToken.token_hash, unique=True)
Index("ix_refresh_tokens_family_id", RefreshToken.family_id)
Index("ix_refresh_tokens_user_id", RefreshToken.user_id)
Index("ix_refresh_tokens_device_row_id", RefreshToken.device_row_id)
