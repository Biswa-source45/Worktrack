import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.audit.service import AuditCtx, record


async def _insert_row(db: AsyncSession) -> int:
    record(db, AuditCtx(None, "127.0.0.1"), "test.action", "thing", 1, after={"a": 1})
    await db.flush()
    return (await db.execute(text("SELECT max(id) FROM audit_logs"))).scalar_one()


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE audit_logs SET action = 'tampered' WHERE id = :id",
        "DELETE FROM audit_logs WHERE id = :id",
    ],
)
async def test_audit_rows_cannot_be_changed_or_deleted(db: AsyncSession, statement: str) -> None:
    row_id = await _insert_row(db)
    with pytest.raises(DBAPIError, match="append-only"):
        async with db.begin_nested():
            await db.execute(text(statement), {"id": row_id})


async def test_audit_log_cannot_be_truncated(db: AsyncSession) -> None:
    await _insert_row(db)
    with pytest.raises(DBAPIError, match="append-only"):
        async with db.begin_nested():
            await db.execute(text("TRUNCATE audit_logs"))


async def test_record_stores_who_where_and_when(db: AsyncSession) -> None:
    row_id = await _insert_row(db)
    row = (
        await db.execute(
            text("SELECT action, entity, entity_id, ip, after, at FROM audit_logs WHERE id = :id"),
            {"id": row_id},
        )
    ).one()
    assert (row.action, row.entity, row.entity_id, row.ip) == (
        "test.action",
        "thing",
        "1",
        "127.0.0.1",
    )
    assert row.after == {"a": 1} and row.at.tzinfo is not None
