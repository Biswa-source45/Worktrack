from typing import cast

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.errors import AppError
from app.core.os_name import format_os
from app.modules.audit import service as audit
from app.modules.audit.service import AuditCtx
from app.modules.auth.deps import AuthContext
from app.modules.auth.schemas import DeviceStatus
from app.modules.auth.service import revoke_tokens
from app.modules.devices.models import (
    DEVICE_ACTIVE,
    DEVICE_PENDING,
    DEVICE_REVOKED,
    UserDevice,
)
from app.modules.devices.schemas import DeviceConflict, DeviceCounts, DeviceOut, DevicePage
from app.modules.employees.models import STATUS_ACTIVE, User
from app.modules.employees.service import ensure_can_manage, parse_cursor


def _out(device: UserDevice, user: User, holder: User | None = None) -> DeviceOut:
    return DeviceOut(
        id=device.id,
        user_id=user.id,
        emp_code=user.emp_code,
        user_name=user.name,
        device_id=device.device_id,
        model=device.model,
        os=format_os(device.os),
        app_version=device.app_version,
        status=cast(DeviceStatus, device.status),
        approved_by=device.approved_by,
        created_at=device.created_at,
        updated_at=device.updated_at,
        last_seen_at=device.last_seen_at,
        conflict=None
        if holder is None
        else DeviceConflict(user_id=holder.id, emp_code=holder.emp_code, name=holder.name),
    )


async def device_counts(session: AsyncSession) -> DeviceCounts:
    """Devices per status over the whole table (one grouped query), whatever the list filters."""
    result = await session.execute(
        select(UserDevice.status, func.count()).group_by(UserDevice.status)
    )
    by_status = dict(result.all())
    return DeviceCounts(
        pending=by_status.get(DEVICE_PENDING, 0),
        active=by_status.get(DEVICE_ACTIVE, 0),
        revoked=by_status.get(DEVICE_REVOKED, 0),
    )


async def list_devices(
    session: AsyncSession,
    *,
    status: str | None,
    user_id: int | None,
    limit: int,
    cursor: str | None,
) -> DevicePage:
    # A pending phone that is active for another employee carries that employee along (one join:
    # the unique index allows at most one such holder per phone).
    held, holder = aliased(UserDevice), aliased(User)
    stmt = (
        select(UserDevice, User, holder)
        .join(User, User.id == UserDevice.user_id)
        .outerjoin(
            held,
            and_(
                UserDevice.status == DEVICE_PENDING,
                held.device_id == UserDevice.device_id,
                held.user_id != UserDevice.user_id,
                held.status == DEVICE_ACTIVE,
            ),
        )
        .outerjoin(holder, holder.id == held.user_id)
        .where(UserDevice.id > parse_cursor(cursor))
        .order_by(UserDevice.id)
        .limit(limit + 1)
    )
    if status:
        stmt = stmt.where(UserDevice.status == status)
    if user_id:
        stmt = stmt.where(UserDevice.user_id == user_id)
    rows = (await session.execute(stmt)).all()
    next_cursor = str(rows[limit - 1][0].id) if len(rows) > limit else None
    return DevicePage(
        items=[_out(d, u, h) for d, u, h in rows[:limit]],
        counts=await device_counts(session),
        next_cursor=next_cursor,
    )


async def decide(
    session: AsyncSession,
    actor: AuthContext,
    ctx: AuditCtx,
    device_id: int,
    action: str,
) -> DeviceOut:
    device = await session.get(UserDevice, device_id)
    if device is None:
        raise AppError("NOT_FOUND", "Device not found.", 404)
    user = await session.get(User, device.user_id)
    assert user is not None  # noqa: S101  # foreign key guarantees it
    ensure_can_manage(actor, user)
    before = {"status": device.status}

    if action == "approve":
        if device.status != DEVICE_PENDING:
            raise AppError("CONFLICT", "Only a pending device can be approved.", 409)
        if user.status != STATUS_ACTIVE:
            raise AppError("CONFLICT", "The employee is inactive.", 409)
        # Approval replaces the employee's old phone and takes this phone from any other
        # employee it is active for: revoke those and their sessions before activating this one.
        old = (
            await session.execute(
                select(UserDevice.id, UserDevice.user_id).where(
                    UserDevice.status == DEVICE_ACTIVE,
                    or_(UserDevice.user_id == user.id, UserDevice.device_id == device.device_id),
                )
            )
        ).all()
        for _, owner_id in old:
            if owner_id != user.id:
                owner = await session.get(User, owner_id)
                assert owner is not None  # noqa: S101  # foreign key guarantees it
                ensure_can_manage(actor, owner)
        for old_id, owner_id in old:
            await session.execute(
                update(UserDevice).where(UserDevice.id == old_id).values(status=DEVICE_REVOKED)
            )
            await revoke_tokens(session, device_row_id=old_id, reason="device_revoked")
            after: dict[str, object] = {"status": DEVICE_REVOKED}
            if owner_id != user.id:
                after |= {"reason": "phone_reassigned", "new_user_id": user.id}
            audit.record(session, ctx, "device.revoked", "user_device", old_id, after=after)
        device.status = DEVICE_ACTIVE
        device.approved_by = actor.user.id
        audit_action = "device.approved"
    else:
        if device.status == DEVICE_REVOKED:
            raise AppError("CONFLICT", "The device is already revoked.", 409)
        if action == "reject" and device.status != DEVICE_PENDING:
            raise AppError("CONFLICT", "Only a pending device can be rejected.", 409)
        device.status = DEVICE_REVOKED
        await revoke_tokens(session, device_row_id=device.id, reason="device_revoked")
        audit_action = "device.rejected" if action == "reject" else "device.revoked"

    audit.record(
        session,
        ctx,
        audit_action,
        "user_device",
        device.id,
        before=before,
        after={"status": device.status, "user_id": user.id},
    )
    await session.commit()
    await session.refresh(device)
    return _out(device, user)
