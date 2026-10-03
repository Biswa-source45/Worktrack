from dataclasses import dataclass
from typing import Any

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.audit.models import AuditLog


@dataclass(frozen=True)
class AuditCtx:
    """Who did it and from where; built once per request."""

    actor_id: int | None
    ip: str | None
    device_id: str | None = None

    @classmethod
    def from_request(
        cls, request: Request, actor_id: int | None, device_id: str | None = None
    ) -> "AuditCtx":
        return cls(actor_id, request.client.host if request.client else None, device_id)


def record(
    session: AsyncSession,
    ctx: AuditCtx,
    action: str,
    entity: str,
    entity_id: int | str | None = None,
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
) -> None:
    """Add an audit row to the caller's transaction, so it commits or rolls back with the change.

    Never pass passwords, tokens or hashes in before/after.
    """
    session.add(
        AuditLog(
            actor_id=ctx.actor_id,
            action=action,
            entity=entity,
            entity_id=None if entity_id is None else str(entity_id),
            before=before,
            after=after,
            ip=ctx.ip,
            device_id=ctx.device_id,
        )
    )
