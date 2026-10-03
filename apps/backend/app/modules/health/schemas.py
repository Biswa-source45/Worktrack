from typing import Literal

from pydantic import BaseModel

Status = Literal["ok", "error"]


class HealthChecks(BaseModel):
    database: Status
    redis: Status
    storage: Status


class HealthResponse(BaseModel):
    status: Status
    checks: HealthChecks
