"""Face enrollment (SRS 4.3, 9.7) and the face check the punch endpoints will call (M4).

Privacy: the template (`embeddings`) is decrypted only in `verify_face`; photos leave only through
signed links; lists, audit rows and logs carry neither.
"""

import datetime as dt
import logging
import uuid
from functools import lru_cache
from typing import TYPE_CHECKING, Any

import numpy as np
from cryptography.exceptions import InvalidTag
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core import crypto, storage
from app.core.config import Settings
from app.core.errors import AppError
from app.core.security import create_file_token, utcnow
from app.modules.audit import service as audit
from app.modules.audit.service import AuditCtx
from app.modules.auth.deps import AuthContext
from app.modules.employees.models import Role, User
from app.modules.employees.service import ensure_can_manage, get_employee, parse_cursor
from app.modules.face.models import (
    APPROVED,
    CONSENTED,
    OPEN_STATUSES,
    PENDING,
    REJECTED,
    RESET,
    FaceEnrollment,
)
from app.modules.face.provider import (
    REQUIRED_PHOTOS,
    FaceCheck,
    FaceInconsistent,
    FaceProvider,
    FaceQualityError,
    Gates,
    OpenCVSFaceProvider,
    Thresholds,
)
from app.modules.face.schemas import (
    EnrollmentDetail,
    EnrollmentItem,
    MyEnrollment,
    PhotoQuality,
)
from app.modules.files.router import file_url
from app.modules.org_settings.schemas import OrgSettings
from app.modules.org_settings.service import get_org_settings
from app.modules.schedule.schemas import EmployeeBrief

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client

logger = logging.getLogger(__name__)

MAX_PHOTO_BYTES = 5 * 1024 * 1024
_EMBEDDING_SHAPE = (REQUIRED_PHOTOS, 128)


@lru_cache
def get_provider() -> FaceProvider:
    return OpenCVSFaceProvider()


def gates_from(settings: OrgSettings) -> Gates:
    return Gates(
        settings.face_min_detection_confidence,
        settings.face_min_face_px,
        settings.face_min_sharpness,
        settings.face_min_brightness,
        settings.face_max_brightness,
    )


def thresholds_from(settings: OrgSettings) -> Thresholds:
    return Thresholds(settings.face_verify_threshold, settings.face_review_threshold)


def _aad(user_id: int, enrollment_id: int) -> bytes:
    # Binds a template to its owner and row: a blob copied elsewhere does not decrypt.
    return f"face:{user_id}:{enrollment_id}".encode()


def _seal(row: FaceEnrollment, embeddings: "np.ndarray[Any, Any]") -> bytes:
    plain = embeddings.astype("<f4").tobytes()
    return crypto.encrypt(crypto.face_key(), plain, _aad(row.user_id, row.id))


def _unseal(row: FaceEnrollment) -> "np.ndarray[Any, Any]":
    # The CHECK constraint guarantees a template on approved rows; an empty one fails to decrypt.
    blob = row.embeddings or b""
    plain = crypto.decrypt(crypto.face_key(), blob, _aad(row.user_id, row.id))
    return np.frombuffer(plain, dtype="<f4").reshape(_EMBEDDING_SHAPE).astype(np.float32)


async def _delete_photos(s3: "S3Client", bucket: str, keys: list[str]) -> None:
    """After the database change is committed. A failure leaves orphan files, not a wrong state."""
    try:
        await storage.delete(s3, bucket, keys)
    except Exception:  # the caller's work is already saved; the daily sweep removes leftovers
        # Only the count: storage keys are not logged.
        logger.exception("could not delete %d face photo(s)", len(keys))


async def _open_row(
    session: AsyncSession, user_id: int, *, lock: bool = False
) -> FaceEnrollment | None:
    stmt = select(FaceEnrollment).where(
        FaceEnrollment.user_id == user_id, FaceEnrollment.status.in_(OPEN_STATUSES)
    )
    if lock:
        # Re-read the columns too: this session may hold an older copy of the row.
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    return (await session.execute(stmt)).scalar_one_or_none()


def _mine(row: FaceEnrollment | None) -> MyEnrollment:
    if row is None:
        return MyEnrollment(
            status="none", consent_at=None, submitted_at=None, decided_at=None, reason=None
        )
    return MyEnrollment(
        status=row.status,  # the CHECK constraint keeps it in the allowed set
        consent_at=row.consent_at,
        submitted_at=row.submitted_at,
        decided_at=row.decided_at,
        reason=row.reason,
    )


def _audit_view(row: FaceEnrollment) -> dict[str, Any]:
    """What an audit row may say about an enrollment: never the face, the keys or the template."""
    return {"user_id": row.user_id, "status": row.status}


# --- the employee -----------------------------------------------------------------------------


async def my_status(session: AsyncSession, user_id: int) -> MyEnrollment:
    row = (
        await session.execute(
            select(FaceEnrollment)
            .where(FaceEnrollment.user_id == user_id)
            .order_by(FaceEnrollment.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    return _mine(row)


async def give_consent(session: AsyncSession, ctx: AuditCtx, user: User) -> MyEnrollment:
    """FR-FACE-04: the notice must be accepted before any photo; the time is the server's."""
    row = await _open_row(session, user.id, lock=True)
    if row is not None:
        if row.status == APPROVED:
            raise AppError("ALREADY_APPROVED", "Your face is already enrolled.", 409)
        return _mine(row)  # accepted before: nothing to record again
    try:
        async with session.begin_nested():
            row = FaceEnrollment(user_id=user.id, status=CONSENTED, consent_at=utcnow())
            session.add(row)
    except IntegrityError:  # a second tap at the same moment: the first one won
        return _mine(await _open_row(session, user.id))
    audit.record(
        session, ctx, "face_enrollment.consent", "face_enrollment", row.id, after=_audit_view(row)
    )
    await session.commit()
    return _mine(row)


def _quality_error(error: FaceQualityError) -> AppError:
    photos = [{"index": index, "code": issue.value} for index, issue in error.issues]
    return AppError("FACE_QUALITY", "Some photos need to be retaken.", 422, {"photos": photos})


async def submit(
    session: AsyncSession,
    ctx: AuditCtx,
    s3: "S3Client",
    bucket: str,
    user: User,
    photos: list[bytes],
) -> MyEnrollment:
    """FR-FACE-02: check the three photos on the server, keep them and the encrypted template."""
    if len(photos) != REQUIRED_PHOTOS:
        raise AppError("PHOTO_COUNT", f"Send exactly {REQUIRED_PHOTOS} photos.", 422)
    row = await _open_row(session, user.id)
    if row is None:
        raise AppError("CONSENT_REQUIRED", "Accept the biometric notice first.", 409)
    if row.status == APPROVED:
        raise AppError("ALREADY_APPROVED", "Your face is already enrolled.", 409)
    org = await get_org_settings(session)
    try:
        result = await run_in_threadpool(
            get_provider().enroll, photos, gates_from(org), org.face_verify_threshold
        )
    except FaceQualityError as error:
        raise _quality_error(error) from None
    except FaceInconsistent:
        raise AppError(
            "FACE_INCONSISTENT",
            "The three photos do not look like the same person. Retake all of them.",
            422,
        ) from None

    folder = uuid.uuid4().hex
    keys = [f"face/{user.id}/{folder}/{n}.jpg" for n in range(REQUIRED_PHOTOS)]
    try:
        for key, jpeg in zip(keys, result.photos, strict=True):
            await storage.put(s3, bucket, key, jpeg)
        # Locked again: the first look was before the slow part, and an admin may have acted.
        row = await _open_row(session, user.id, lock=True)
        if row is None or row.status == APPROVED:
            raise AppError("CONFLICT", "Your enrollment changed. Start again.", 409)
        old_keys = row.image_keys or []
        before = _audit_view(row)
        row.status = PENDING
        row.submitted_at = utcnow()
        row.image_keys = keys
        row.embeddings = _seal(row, result.embeddings)
        row.model_version = get_provider().model_version
        row.quality = [q.as_dict() for q in result.qualities]
        row.consistency_score = result.consistency
        row.decided_by = row.decided_at = row.reason = None
        audit.record(
            session,
            ctx,
            "face_enrollment.submit",
            "face_enrollment",
            row.id,
            before=before,
            after={**_audit_view(row), "consistency": round(result.consistency, 3)},
        )
        await session.commit()
    except BaseException:
        await session.rollback()
        await _delete_photos(s3, bucket, keys)
        raise
    await _delete_photos(s3, bucket, old_keys)  # photos of a submission this one replaced
    return _mine(row)


# --- the admin --------------------------------------------------------------------------------

_ITEM_COLUMNS = (
    FaceEnrollment.id,
    FaceEnrollment.status,
    FaceEnrollment.consent_at,
    FaceEnrollment.submitted_at,
    FaceEnrollment.decided_at,
    User.id.label("employee_id"),
    User.emp_code,
    User.name,
)


def _item(row: Any) -> EnrollmentItem:
    return EnrollmentItem(
        id=row.id,
        employee=EmployeeBrief(id=row.employee_id, emp_code=row.emp_code, name=row.name),
        status=row.status,
        consent_at=row.consent_at,
        submitted_at=row.submitted_at,
        decided_at=row.decided_at,
    )


async def list_enrollments(
    session: AsyncSession, actor: AuthContext, *, status: str, limit: int, cursor: str | None
) -> tuple[list[EnrollmentItem], str | None]:
    """Only employees the actor may manage (the same rule as ensure_can_manage), decided in SQL."""
    stmt = (
        select(*_ITEM_COLUMNS)
        .join(User, User.id == FaceEnrollment.user_id)
        .join(Role, Role.id == User.role_id)
        .where(
            FaceEnrollment.status == status,
            FaceEnrollment.id > parse_cursor(cursor),
            Role.__table__.c.permissions.contained_by(sorted(actor.permissions)),
        )
        .order_by(FaceEnrollment.id)
        .limit(limit + 1)
    )
    rows = (await session.execute(stmt)).all()
    items = [_item(row) for row in rows[:limit]]
    return items, str(items[-1].id) if len(rows) > limit else None


async def _managed(
    session: AsyncSession, actor: AuthContext, enrollment_id: int, *, lock: bool
) -> tuple[FaceEnrollment, User]:
    row = await session.get(FaceEnrollment, enrollment_id, with_for_update=lock)
    if row is None:
        raise AppError("NOT_FOUND", "Enrollment not found.", 404)
    user = await get_employee(session, row.user_id)
    ensure_can_manage(actor, user)
    return row, user


async def detail(
    session: AsyncSession,
    actor: AuthContext,
    ctx: AuditCtx,
    settings: Settings,
    enrollment_id: int,
) -> EnrollmentDetail:
    """One enrollment with signed photo links. Looking at someone's face is itself audited."""
    row, user = await _managed(session, actor, enrollment_id, lock=False)
    keys = row.image_keys or []
    if keys:
        audit.record(
            session, ctx, "face_enrollment.view", "face_enrollment", row.id, after=_audit_view(row)
        )
        await session.commit()
    return EnrollmentDetail(
        id=row.id,
        employee=EmployeeBrief.model_validate(user),
        status=row.status,
        consent_at=row.consent_at,
        submitted_at=row.submitted_at,
        decided_at=row.decided_at,
        photos=[file_url(create_file_token(settings, key)) for key in keys],
        qualities=[PhotoQuality(**q) for q in row.quality or []] if keys else [],
        consistency_score=row.consistency_score,
        model_version=row.model_version,
        decided_by=row.decided_by,
        reason=row.reason,
    )


def _close(row: FaceEnrollment, status: str, actor: User, reason: str | None) -> list[str]:
    """End an attempt: keep who, when and why; drop the face. Returns the photos to delete."""
    keys = row.image_keys or []
    row.status = status
    row.image_keys = row.embeddings = None
    row.decided_by, row.decided_at, row.reason = actor.id, utcnow(), reason
    return keys


async def approve(
    session: AsyncSession,
    actor: AuthContext,
    ctx: AuditCtx,
    enrollment_id: int,
    seen_submitted_at: dt.datetime,
) -> EnrollmentItem:
    row, user = await _managed(session, actor, enrollment_id, lock=True)
    if row.status != PENDING:
        raise AppError(
            "ENROLLMENT_ALREADY_DECIDED", "This enrollment is not waiting for a decision.", 409
        )
    if row.submitted_at != seen_submitted_at:
        raise AppError(
            "ENROLLMENT_CHANGED",
            "The employee sent new photos after you opened this. Review them again.",
            409,
        )
    before = _audit_view(row)
    row.status = APPROVED
    row.decided_by, row.decided_at, row.reason = actor.user.id, utcnow(), None
    audit.record(
        session,
        ctx,
        "face_enrollment.approve",
        "face_enrollment",
        row.id,
        before=before,
        after=_audit_view(row),
    )
    await session.commit()
    return _decided(row, user)


async def _end(
    session: AsyncSession,
    actor: AuthContext,
    ctx: AuditCtx,
    s3: "S3Client",
    bucket: str,
    enrollment_id: int,
    *,
    allowed: tuple[str, ...],
    status: str,
    action: str,
    reason: str,
) -> EnrollmentItem:
    row, user = await _managed(session, actor, enrollment_id, lock=True)
    if row.status not in allowed:
        code = "ENROLLMENT_ALREADY_DECIDED" if status == REJECTED else "ENROLLMENT_NOT_RESETTABLE"
        raise AppError(code, f"This enrollment cannot be {status} now.", 409)
    before = _audit_view(row)
    keys = _close(row, status, actor.user, reason)
    audit.record(
        session,
        ctx,
        action,
        "face_enrollment",
        row.id,
        before=before,
        after={**_audit_view(row), "reason": reason},
    )
    await session.commit()
    await _delete_photos(s3, bucket, keys)
    return _decided(row, user)


async def reject(
    session: AsyncSession,
    actor: AuthContext,
    ctx: AuditCtx,
    s3: "S3Client",
    bucket: str,
    enrollment_id: int,
    reason: str,
) -> EnrollmentItem:
    return await _end(
        session, actor, ctx, s3, bucket, enrollment_id,
        allowed=(PENDING,), status=REJECTED, action="face_enrollment.reject", reason=reason,
    )  # fmt: skip


async def reset(
    session: AsyncSession,
    actor: AuthContext,
    ctx: AuditCtx,
    s3: "S3Client",
    bucket: str,
    enrollment_id: int,
    reason: str,
) -> EnrollmentItem:
    """FR-FACE-03: the person enrolls again and the new enrollment needs approval."""
    return await _end(
        session, actor, ctx, s3, bucket, enrollment_id,
        allowed=(PENDING, APPROVED), status=RESET, action="face_enrollment.reset", reason=reason,
    )  # fmt: skip


def _decided(row: FaceEnrollment, user: User) -> EnrollmentItem:
    return EnrollmentItem(
        id=row.id,
        employee=EmployeeBrief.model_validate(user),
        status=row.status,
        consent_at=row.consent_at,
        submitted_at=row.submitted_at,
        decided_at=row.decided_at,
    )


# --- for the punch endpoints (M4) -------------------------------------------------------------


async def ensure_face_approved(session: AsyncSession, user_id: int) -> FaceEnrollment:
    """Punches are blocked until an admin has approved the enrollment (US-3.2)."""
    row = await _open_row(session, user_id)
    if row is None or row.status != APPROVED:
        raise AppError("FACE_NOT_APPROVED", "Your face enrollment is not approved yet.", 409)
    return row


async def verify_face(session: AsyncSession, user_id: int, image: bytes) -> FaceCheck:
    """Compare a fresh selfie with the approved template; thresholds come from Settings."""
    row = await ensure_face_approved(session, user_id)
    try:
        enrolled = _unseal(row)
    except (InvalidTag, ValueError):
        logger.error("face template %s does not decrypt: wrong FACE_ENCRYPTION_KEY?", row.id)
        raise AppError(
            "FACE_UNAVAILABLE", "Face matching is not available right now.", 503
        ) from None
    org = await get_org_settings(session)
    return await run_in_threadpool(
        get_provider().verify, image, enrolled, gates_from(org), thresholds_from(org)
    )


# --- retention --------------------------------------------------------------------------------


async def purge_departed(session: AsyncSession, s3: "S3Client", bucket: str, ctx: AuditCtx) -> int:
    """Delete the photos and template of people deactivated longer ago than the retention period.

    The row stays (status reset, reason "Employee left") so the history of who was enrolled and
    when is kept; the face is not. Someone reactivated later must enroll again. SRS 13.
    """
    days = (await get_org_settings(session)).face_retention_days_after_exit
    cutoff = utcnow() - dt.timedelta(days=days)
    rows = (
        (
            await session.execute(
                select(FaceEnrollment)
                .join(User, User.id == FaceEnrollment.user_id)
                .where(
                    FaceEnrollment.status.in_((PENDING, APPROVED)),
                    User.status == "inactive",
                    User.deactivated_at <= cutoff,
                )
                .with_for_update(of=FaceEnrollment)
                .execution_options(populate_existing=True)
            )
        )
        .scalars()
        .all()
    )
    keys: list[str] = []
    for row in rows:
        before = _audit_view(row)
        keys += row.image_keys or []
        row.status, row.reason, row.decided_at = RESET, "Employee left", utcnow()
        row.image_keys = row.embeddings = None
        audit.record(
            session,
            ctx,
            "face_enrollment.purge",
            "face_enrollment",
            row.id,
            before=before,
            after={**_audit_view(row), "reason": row.reason},
        )
    await session.commit()
    await _delete_photos(s3, bucket, keys)
    return len(rows)


async def sweep_orphans(
    session: AsyncSession,
    s3: "S3Client",
    bucket: str,
    min_age: dt.timedelta = dt.timedelta(hours=1),
) -> int:
    """Delete stored photos that no enrollment refers to.

    A delete after a rejection, reset or replacement can fail (the storage may be down for a
    moment) and nothing would retry it. Photos younger than `min_age` are left alone: they may
    belong to a submission that is still being saved.
    """
    old = await storage.list_keys(s3, bucket, "face/", utcnow() - min_age)
    if not old:
        return 0
    referenced = set(
        (
            await session.execute(
                select(func.unnest(FaceEnrollment.image_keys)).where(
                    FaceEnrollment.image_keys.is_not(None)
                )
            )
        ).scalars()
    )
    orphans = [key for key in old if key not in referenced]
    await storage.delete(s3, bucket, orphans)
    return len(orphans)
