from typing import Annotated

from fastapi import APIRouter, Path, Request, Response

from app.core import storage
from app.core.errors import AppError
from app.core.security import decode_file_token

router = APIRouter(tags=["files"])


def file_url(token: str) -> str:
    """Relative on purpose: each client adds its own base (web proxy, ngrok), never localhost."""
    return f"/api/v1/files/{token}"


@router.get(
    "/files/{token}", response_class=Response, responses={200: {"content": {"image/jpeg": {}}}}
)
async def get_file(request: Request, token: Annotated[str, Path(max_length=2048)]) -> Response:
    """The signed link is the credential: no sign-in header, because `<img>` cannot send one."""
    state = request.app.state
    key = decode_file_token(state.settings, token)
    if key is None:
        raise AppError("FILE_LINK_INVALID", "This link is invalid or has expired.", 404)
    try:
        data = await storage.get(state.s3, state.settings.s3_bucket, key)
    except storage.ObjectMissing:
        raise AppError("FILE_LINK_INVALID", "This file no longer exists.", 404) from None
    # Photos are JPEGs; task briefs may be PDFs (checked by magic bytes before they are stored).
    return Response(
        data,
        media_type="application/pdf" if key.endswith(".pdf") else "image/jpeg",
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )
