import datetime as dt

from sqlalchemy import ForeignKey, Index, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class Notification(Base):
    """An in-app record for one person. Push delivery and the notification centre come in M8."""

    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    type: Mapped[str] = mapped_column(String(48))
    title: Mapped[str] = mapped_column(String(120))
    body: Mapped[str] = mapped_column(String(500))
    deep_link: Mapped[str | None] = mapped_column(String(255))
    read_at: Mapped[dt.datetime | None]
    # Makes "once per day" jobs idempotent: a second insert with the same key is refused.
    dedupe_key: Mapped[str | None] = mapped_column(String(120), unique=True)
    created_at: Mapped[dt.datetime] = mapped_column(server_default=func.now())


Index("ix_notifications_user_id_id", Notification.user_id, Notification.id)
