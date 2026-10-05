"""The OpenCV provider: photo gates, enrollment, verification, decisions (SRS 9.7.6)."""

import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pytest

from app.core.errors import AppError
from app.modules.face import provider as face
from app.modules.face.provider import (
    Decision,
    FaceInconsistent,
    FaceQualityError,
    Gates,
    Issue,
    OpenCVSFaceProvider,
    Thresholds,
)
from app.modules.org_settings.schemas import OrgSettings
from tests.modules.face import images

DEFAULTS = OrgSettings()
GATES = Gates(
    DEFAULTS.face_min_detection_confidence,
    DEFAULTS.face_min_face_px,
    DEFAULTS.face_min_sharpness,
    DEFAULTS.face_min_brightness,
    DEFAULTS.face_max_brightness,
)
THRESHOLDS = Thresholds(DEFAULTS.face_verify_threshold, DEFAULTS.face_review_threshold)


@pytest.fixture(scope="module")
def provider() -> OpenCVSFaceProvider:
    return OpenCVSFaceProvider()


def enrolled(provider: OpenCVSFaceProvider, name: str) -> np.ndarray:
    photos = [images.photo(name), images.same_person(name, 1), images.same_person(name, 2)]
    return provider.enroll(photos, GATES, THRESHOLDS.verify).embeddings


def issue_of(provider: OpenCVSFaceProvider, data: bytes, gates: Gates = GATES) -> Issue:
    check = provider.verify(data, enrolled(provider, "a"), gates, THRESHOLDS)
    assert check.decision is Decision.RETAKE
    assert check.score is None
    assert check.issue is not None
    return check.issue


# --- photo gates (every one of these is a retake, nothing is stored) ---------------------------


@pytest.mark.parametrize("name", images.PEOPLE)
def test_a_clear_single_face_passes_every_gate(provider: OpenCVSFaceProvider, name: str) -> None:
    check = provider.verify(images.photo(name), enrolled(provider, name), GATES, THRESHOLDS)
    assert check.decision is Decision.VERIFIED


@pytest.mark.parametrize(
    ("make_photo", "expected"),
    [
        (images.empty_wall, Issue.NO_FACE),
        (images.noise, Issue.NO_FACE),
        (images.two_faces, Issue.MULTIPLE_FACES),
        (lambda: images.blurred("a"), Issue.BLURRY),
        (lambda: images.darkened("b", 0.3), Issue.TOO_DARK),
        (lambda: images.brightened("a"), Issue.TOO_BRIGHT),
        (lambda: b"not an image at all", Issue.UNREADABLE_IMAGE),
        (lambda: b"", Issue.UNREADABLE_IMAGE),
    ],
)
def test_bad_photos_are_a_retake_with_the_reason(
    provider: OpenCVSFaceProvider, make_photo: object, expected: Issue
) -> None:
    assert issue_of(provider, make_photo()) is expected  # type: ignore[operator]


def test_gates_come_from_the_arguments_not_from_the_code(provider: OpenCVSFaceProvider) -> None:
    clear = images.photo("a")
    assert issue_of(provider, clear, Gates(0.99, 80, 60, 50, 200)) is Issue.LOW_CONFIDENCE
    assert issue_of(provider, clear, Gates(0.9, 400, 60, 50, 200)) is Issue.FACE_TOO_SMALL
    assert issue_of(provider, clear, Gates(0.9, 80, 5000, 50, 200)) is Issue.BLURRY
    assert issue_of(provider, clear, Gates(0.9, 80, 60, 250, 255)) is Issue.TOO_DARK
    assert issue_of(provider, clear, Gates(0.9, 80, 60, 0, 20)) is Issue.TOO_BRIGHT


def test_a_large_photo_is_shrunk_to_640_and_the_exif_rotation_is_applied() -> None:
    assert max(face.decode(images.large("a")).shape[:2]) == face.MAX_SIDE_PX
    upright = face.decode(images.photo("a")).astype(int)
    turned = face.decode(images.exif_rotated("a")).astype(int)
    assert np.abs(upright - turned).mean() < 8


def test_a_phone_photo_saved_on_its_side_still_works(provider: OpenCVSFaceProvider) -> None:
    check = provider.verify(images.exif_rotated("a"), enrolled(provider, "a"), GATES, THRESHOLDS)
    assert check.decision is Decision.VERIFIED


def test_missing_models_answer_503_with_a_clear_message(tmp_path: Path) -> None:
    with pytest.raises(AppError) as caught:
        OpenCVSFaceProvider(tmp_path).verify(
            images.photo("a"), np.zeros((1, 128), np.float32), GATES, THRESHOLDS
        )
    assert (caught.value.code, caught.value.status_code) == ("FACE_UNAVAILABLE", 503)


# --- enrollment -------------------------------------------------------------------------------


def test_enrollment_returns_three_unit_embeddings_and_clean_jpegs(
    provider: OpenCVSFaceProvider,
) -> None:
    photos = [images.photo("c"), images.same_person("c", 1), images.large("c")]
    result = provider.enroll(photos, GATES, THRESHOLDS.verify)
    assert result.embeddings.shape == (3, 128)
    assert result.embeddings.dtype == np.float32
    assert np.allclose(np.linalg.norm(result.embeddings, axis=1), 1, atol=1e-5)
    assert result.consistency >= THRESHOLDS.verify
    assert len(result.qualities) == len(result.photos) == 3
    for stored in result.photos:
        assert stored[:2] == b"\xff\xd8"
        assert b"Exif" not in stored  # no camera metadata, no GPS
        assert max(face.decode(stored).shape[:2]) <= face.MAX_SIDE_PX
    assert result.qualities[0].face_px >= GATES.min_face_px


def test_every_failed_photo_is_reported_by_its_position(provider: OpenCVSFaceProvider) -> None:
    photos = [images.photo("a"), images.blurred("a"), images.empty_wall()]
    with pytest.raises(FaceQualityError) as caught:
        provider.enroll(photos, GATES, THRESHOLDS.verify)
    assert caught.value.issues == [(1, Issue.BLURRY), (2, Issue.NO_FACE)]


def test_photos_of_different_people_do_not_enroll(provider: OpenCVSFaceProvider) -> None:
    photos = [images.photo("a"), images.photo("b"), images.photo("c")]
    with pytest.raises(FaceInconsistent) as caught:
        provider.enroll(photos, GATES, THRESHOLDS.verify)
    assert caught.value.score < THRESHOLDS.review


def test_the_consistency_bar_is_the_one_passed_in(provider: OpenCVSFaceProvider) -> None:
    photos = [images.photo("a"), images.same_person("a", 1), images.same_person("a", 2)]
    consistency = provider.enroll(photos, GATES, 0.0).consistency
    assert provider.enroll(photos, GATES, consistency - 0.001)
    with pytest.raises(FaceInconsistent):
        provider.enroll(photos, GATES, consistency + 0.001)


# --- verification and the decision ------------------------------------------------------------


@pytest.mark.parametrize(
    ("score", "decision"),
    [
        (0.99, Decision.VERIFIED),
        (0.40, Decision.VERIFIED),  # the verify threshold itself passes
        (0.3999, Decision.PENDING_REVIEW),
        (0.30, Decision.PENDING_REVIEW),  # the review threshold itself goes to an admin
        (0.2999, Decision.MISMATCH),
        (-0.2, Decision.MISMATCH),
    ],
)
def test_decision_bands(score: float, decision: Decision) -> None:
    assert face.decide(score, THRESHOLDS) is decision


def test_regression_known_genuine_pair_stays_verified_and_impostor_stays_a_mismatch(
    provider: OpenCVSFaceProvider,
) -> None:
    # Fixed numbers on purpose (the defaults at the time of writing): if a model, a gate or the
    # resizing changes, these must still hold or the thresholds need a new calibration.
    thresholds = Thresholds(0.40, 0.30)
    for name in images.PEOPLE:
        genuine = provider.verify(
            images.same_person(name), enrolled(provider, name), GATES, thresholds
        )
        assert genuine.decision is Decision.VERIFIED
        assert genuine.score is not None and genuine.score >= 0.70
    for name, other in [("a", "b"), ("b", "c"), ("c", "d"), ("d", "a")]:
        impostor = provider.verify(images.photo(other), enrolled(provider, name), GATES, thresholds)
        assert impostor.decision is Decision.MISMATCH
        assert impostor.score is not None and impostor.score < 0.30


def test_the_same_score_gives_other_decisions_when_the_thresholds_change(
    provider: OpenCVSFaceProvider,
) -> None:
    template = enrolled(provider, "a")
    probe = images.same_person("a", 1)
    score = provider.verify(probe, template, GATES, THRESHOLDS).score
    assert score is not None
    verified = provider.verify(probe, template, GATES, Thresholds(score - 0.01, score - 0.02))
    review = provider.verify(probe, template, GATES, Thresholds(score + 0.01, score - 0.01))
    mismatch = provider.verify(probe, template, GATES, Thresholds(score + 0.02, score + 0.01))
    assert [verified.decision, review.decision, mismatch.decision] == [
        Decision.VERIFIED,
        Decision.PENDING_REVIEW,
        Decision.MISMATCH,
    ]
    assert review.thresholds == Thresholds(score + 0.01, score - 0.01)  # kept for the audit trail
    assert review.model_version == face.MODEL_VERSION


def test_the_best_of_the_enrolled_photos_is_the_score(provider: OpenCVSFaceProvider) -> None:
    template = enrolled(provider, "a")
    probe = images.same_person("a", 1)
    score = provider.verify(probe, template, GATES, THRESHOLDS).score
    only_the_worst = template[[int(np.argmin(template @ template[0]))]]
    worse = provider.verify(probe, only_the_worst, GATES, THRESHOLDS).score
    assert score is not None and worse is not None and score >= worse


def test_parallel_checks_do_not_corrupt_each_other(provider: OpenCVSFaceProvider) -> None:
    template = enrolled(provider, "a")
    probes = [images.photo("a"), images.photo("b"), images.same_person("a", 2), images.photo("c")]

    def score(data: bytes) -> float | None:
        return provider.verify(data, template, GATES, THRESHOLDS).score

    alone = [score(data) for data in probes]
    with ThreadPoolExecutor(max_workers=4) as pool:
        together = list(pool.map(score, probes * 3))
    assert together == alone * 3


def test_100_sequential_verifications_average_under_300_ms(provider: OpenCVSFaceProvider) -> None:
    template = enrolled(provider, "a")
    probe = images.same_person("a", 1)
    provider.verify(probe, template, GATES, THRESHOLDS)  # model load is not part of the budget
    started = time.perf_counter()
    for _ in range(100):
        assert provider.verify(probe, template, GATES, THRESHOLDS).decision is Decision.VERIFIED
    average_ms = (time.perf_counter() - started) / 100 * 1000
    assert average_ms < 300, f"{average_ms:.0f} ms per verification"
