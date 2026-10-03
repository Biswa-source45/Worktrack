from typing import cast

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
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
from app.modules.devices.schemas import DeviceOut, DevicePage
from app.modules.employees.models import STATUS_ACTIVE, User
from app.modules.employees.service import ensure_can_manage, parse_cursor


def _out(device: UserDevice, user: User) -> DeviceOut:
    return DeviceOut(
        id=device.id,
        user_id=user.id,
        emp_code=user.emp_code,
        user_name=user.name,
        device_id=device.device_id,
        model=device.model,
        os=device.os,
        app_version=device.app_version,
        status=cast(DeviceStatus, device.status),
        approved_by=device.approved_by,
        created_at=device.created_at,
        updated_at=device.updated_at,
    )


async def list_devices(
    session: AsyncSession,
    *,
    status: str | None,
    user_id: int | None,
    limit: int,
    cursor: str | None,
) -> DevicePage:
    stmt = (
        select(UserDevice, User)
        .join(User, User.id == UserDevice.user_id)
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
    return DevicePage(items=[_out(d, u) for d, u in rows[:limit]], next_cursor=next_cursor)


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
        # Approval replaces the old phone: revoke it and its sessions before activating the new one.
        old_ids = (
            (
                await session.execute(
                    select(UserDevice.id).where(
                        UserDevice.user_id == user.id, UserDevice.status == DEVICE_ACTIVE
                    )
                )
            )
            .scalars()
            .all()
        )
        for old_id in old_ids:
            await session.execute(
                update(UserDevice).where(UserDevice.id == old_id).values(status=DEVICE_REVOKED)
            )
            await revoke_tokens(session, device_row_id=old_id)
            audit.record(
                session,
                ctx,
                "device.revoked",
                "user_device",
                old_id,
                after={"status": DEVICE_REVOKED},
            )
        device.status = DEVICE_ACTIVE
        device.approved_by = actor.user.id
        audit_action = "device.approved"
    else:
        if device.status == DEVICE_REVOKED:
            raise AppError("CONFLICT", "The device is already revoked.", 409)
        if action == "reject" and device.status != DEVICE_PENDING:
            raise AppError("CONFLICT", "Only a pending device can be rejected.", 409)
        device.status = DEVICE_REVOKED
        await revoke_tokens(session, device_row_id=device.id)
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
