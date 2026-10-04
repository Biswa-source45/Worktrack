from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from pydantic import StringConstraints
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.modules.auth.deps import (
    AuthContext,
    authenticated,
    require_any_permission,
    require_permission,
)
from app.modules.auth.permissions import BRANCHES_MANAGE, EMPLOYEES_MANAGE
from app.modules.branches import geo, service
from app.modules.branches.schemas import (
    BranchCreate,
    BranchOut,
    BranchPage,
    BranchUpdate,
    LinkIn,
    PlaceOut,
    SearchHit,
)
from app.modules.employees.schemas import Ref

router = APIRouter(tags=["branches"])

Session = Annotated[AsyncSession, Depends(get_session)]
Manager = Annotated[AuthContext, Depends(require_permission(BRANCHES_MANAGE))]
SignedIn = Annotated[AuthContext, Depends(authenticated)]
# A pin is placed on the branch form and on an employee's home-location form.
PinPlacer = Annotated[
    AuthContext, Depends(require_any_permission(BRANCHES_MANAGE, EMPLOYEES_MANAGE))
]
SearchText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=120)]


@router.get("/admin/branches", response_model=BranchPage)
async def list_branches(
    session: Session,
    _: Manager,
    is_active: bool | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: str | None = None,
) -> BranchPage:
    rows, next_cursor = await service.list_branches(
        session, is_active=is_active, limit=limit, cursor=cursor
    )
    return BranchPage(items=[BranchOut.model_validate(r) for r in rows], next_cursor=next_cursor)


@router.post("/admin/branches", response_model=BranchOut, status_code=201)
async def create_branch(
    body: BranchCreate, request: Request, session: Session, actor: Manager
) -> BranchOut:
    branch = await service.create_branch(session, actor.audit(request), body)
    return BranchOut.model_validate(branch)


@router.get("/admin/branches/{branch_id}", response_model=BranchOut)
async def get_branch(branch_id: int, session: Session, _: Manager) -> BranchOut:
    return BranchOut.model_validate(await service.get_branch(session, branch_id))


@router.patch("/admin/branches/{branch_id}", response_model=BranchOut)
async def update_branch(
    branch_id: int, body: BranchUpdate, request: Request, session: Session, actor: Manager
) -> BranchOut:
    branch = await service.update_branch(session, actor.audit(request), branch_id, body)
    return BranchOut.model_validate(branch)


@router.get("/branches", response_model=list[Ref])
async def branch_names(session: Session, _: SignedIn) -> list[Ref]:
    # Employee forms run under employees.manage, not branches.manage, and still need a picker.
    return [Ref.model_validate(r) for r in await service.active_branch_names(session)]


@router.post("/admin/geo/resolve-link", response_model=PlaceOut)
async def resolve_link(body: LinkIn, request: Request, _: PinPlacer) -> PlaceOut:
    return await geo.resolve_link(request.app.state.http, body.url)


@router.get("/admin/geo/search", response_model=list[SearchHit])
async def search_places(
    request: Request, _: PinPlacer, q: Annotated[SearchText, Query()]
) -> list[SearchHit]:
    state = request.app.state
    user_agent = f"WorkTrack/{request.app.version} (admin geocoding)"
    return await geo.search(state.http, state.redis, state.settings.geocoder_url, user_agent, q)
