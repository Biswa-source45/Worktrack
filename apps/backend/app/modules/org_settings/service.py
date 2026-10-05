from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.modules.audit import service as audit
from app.modules.audit.service import AuditCtx
from app.modules.org_settings.models import Setting
from app.modules.org_settings.schemas import OrgSettings


async def get_org_settings(session: AsyncSession) -> OrgSettings:
    """The stored values over the defaults, in one query."""
    rows = (await session.execute(select(Setting.key, Setting.value))).all()
    return OrgSettings.model_validate(
        {key: value for key, value in rows if key in OrgSettings.model_fields}
    )


def _check_pairs(merged: OrgSettings) -> None:
    """Rules that span two keys; they are checked on the result, not on the request alone."""
    if merged.face_review_threshold >= merged.face_verify_threshold:
        raise AppError(
            "VALIDATION_ERROR", "The face review threshold must be below the verify threshold.", 422
        )
    if merged.face_min_brightness >= merged.face_max_brightness:
        raise AppError("VALIDATION_ERROR", "The minimum brightness must be below the maximum.", 422)


async def update(session: AsyncSession, ctx: AuditCtx, data: OrgSettings) -> OrgSettings:
    """Change the settings the request sent; the audit row holds only the keys that changed."""
    current = await get_org_settings(session)
    changes = {
        key: value
        for key, value in data.model_dump(exclude_unset=True).items()
        if getattr(current, key) != value
    }
    if not changes:
        return current
    _check_pairs(current.model_copy(update=changes))
    stmt = insert(Setting).values(
        [{"key": key, "value": value, "updated_by": ctx.actor_id} for key, value in changes.items()]
    )
    await session.execute(
        stmt.on_conflict_do_update(
            index_elements=[Setting.key],
            set_={
                "value": stmt.excluded.value,
                "updated_by": stmt.excluded.updated_by,
                "updated_at": func.now(),
            },
        )
    )
    audit.record(
        session,
        ctx,
        "settings.update",
        "settings",
        before={key: getattr(current, key) for key in changes},
        after=changes,
    )
    await session.commit()
    return current.model_copy(update=changes)
