from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.modules.health import service
from app.modules.health.schemas import HealthResponse

router = APIRouter(tags=["health"])


@router.get(
    "/health",
    response_model=HealthResponse,
    # Probes read the status code, so a failure keeps this body shape instead of the error envelope.
    responses={503: {"model": HealthResponse}},
)
async def health(
    request: Request, response: Response, session: Annotated[AsyncSession, Depends(get_session)]
) -> HealthResponse:
    state = request.app.state
    result = await service.check_health(session, state.redis, state.s3, state.settings.s3_bucket)
    if result.status != "ok":
        response.status_code = 503
    return result
