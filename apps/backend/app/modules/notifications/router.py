from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.modules.auth.deps import AuthContext, authenticated
from app.modules.employees.service import parse_cursor
from app.modules.notifications.models import Notification
from app.modules.notifications.schemas import NotificationOut, NotificationPage

router = APIRouter(tags=["notifications"])


@router.get("/notifications", response_model=NotificationPage)
async def my_notifications(
    session: Annotated[AsyncSession, Depends(get_session)],
    auth: Annotated[AuthContext, Depends(authenticated)],
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
    cursor: str | None = None,
) -> NotificationPage:
    """The person's own notifications, newest first. `cursor` is the id of the last one seen."""
    stmt = (
        select(Notification)
        .where(Notification.user_id == auth.user.id)
        .order_by(Notification.id.desc())
        .limit(limit + 1)
    )
    if cursor is not None:
        stmt = stmt.where(Notification.id < parse_cursor(cursor))
    rows = list((await session.execute(stmt)).scalars())
    items = [NotificationOut.model_validate(row) for row in rows[:limit]]
    return NotificationPage(
        items=items, next_cursor=str(items[-1].id) if len(rows) > limit else None
    )
