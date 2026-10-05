import datetime as dt

from pydantic import BaseModel, ConfigDict


class NotificationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    type: str
    title: str
    body: str
    deep_link: str | None
    read_at: dt.datetime | None
    created_at: dt.datetime


class NotificationPage(BaseModel):
    items: list[NotificationOut]
    next_cursor: str | None
