from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, ForeignKey, Index, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class AuditLog(Base):
    """Append-only: a database trigger rejects UPDATE and DELETE (FR-AUD-02)."""

    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    actor_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    action: Mapped[str] = mapped_column(String(64))
    entity: Mapped[str] = mapped_column(String(64))
    entity_id: Mapped[str | None] = mapped_column(String(64))
    before: Mapped[dict[str, Any] | None]
    after: Mapped[dict[str, Any] | None]
    ip: Mapped[str | None] = mapped_column(String(64))
    device_id: Mapped[str | None] = mapped_column(String(128))
    at: Mapped[datetime] = mapped_column(server_default=func.now())


Index("ix_audit_logs_entity", AuditLog.entity, AuditLog.entity_id)
Index("ix_audit_logs_actor_id_at", AuditLog.actor_id, AuditLog.at)
