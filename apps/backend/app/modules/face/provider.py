"""Face detection, photo quality gates and recognition (SRS 9.7): OpenCV YuNet + SFace.

Only this file touches OpenCV. Everything else talks to `FaceProvider`, so a different engine
(for example a cloud service) can replace `OpenCVSFaceProvider` without changing the apps.
Thresholds and gates are always passed in from Settings; nothing here decides a limit.
"""

import threading
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from enum import StrEnum
from pathlib import Path
from typing import Protocol

import cv2
import numpy as np
from numpy.typing import NDArray

from app.core.errors import AppError

MODELS_DIR = Path(__file__).resolve().parents[3] / "models"
DETECTOR_FILE = "face_detection_yunet_2023mar.onnx"
RECOGNIZER_FILE = "face_recognition_sface_2021dec.onnx"
MODEL_VERSION = "yunet-2023mar+sface-2021dec"

REQUIRED_PHOTOS = 3
MAX_SIDE_PX = 640
JPEG_QUALITY = 85
# Faces scoring below this are not reported at all ("no face"); between this and the configured
# confidence they are reported as "unclear". Settings cannot set the confidence lower (ge=0.5).
CANDIDATE_FLOOR = 0.5
# Sharpness is measured on the face crop scaled to this size, so it does not depend on how big
# the face is in the photo.
SHARPNESS_SIDE_PX = 160

Embedding = NDArray[np.float32]


class Issue(StrEnum):
    UNREADABLE_IMAGE = "UNREADABLE_IMAGE"
    NO_FACE = "NO_FACE"
    MULTIPLE_FACES = "MULTIPLE_FACES"
    LOW_CONFIDENCE = "LOW_CONFIDENCE"
    FACE_TOO_SMALL = "FACE_TOO_SMALL"
    BLURRY = "BLURRY"
    TOO_DARK = "TOO_DARK"
    TOO_BRIGHT = "TOO_BRIGHT"


class Decision(StrEnum):
    VERIFIED = "VERIFIED"
    PENDING_REVIEW = "PENDING_REVIEW"
    MISMATCH = "MISMATCH"
    RETAKE = "RETAKE"


@dataclass(frozen=True)
class Gates:
    min_confidence: float
    min_face_px: int
    min_sharpness: float
    min_brightness: int
    max_brightness: int


@dataclass(frozen=True)
class Thresholds:
    verify: float
    review: float


@dataclass(frozen=True)
class Quality:
    confidence: float
    face_px: int
    sharpness: float
    brightness: float

    def as_dict(self) -> dict[str, float | int]:
        return asdict(self)


@dataclass(frozen=True)
class Enrollment:
    embeddings: Embedding  # (3, 128), each row unit length
    qualities: list[Quality]
    photos: list[bytes]  # the resized, EXIF-free JPEGs that get stored
    consistency: float  # the lowest score between any two of the photos


@dataclass(frozen=True)
class FaceCheck:
    decision: Decision
    score: float | None  # None for RETAKE
    issue: Issue | None  # why a RETAKE was needed
    model_version: str
    thresholds: Thresholds


class PhotoRejected(Exception):
    def __init__(self, issue: Issue) -> None:
        super().__init__(issue)
        self.issue = issue


class FaceQualityError(Exception):
    """One or more enrollment photos failed a gate: `(photo index, issue)` for each."""

    def __init__(self, issues: list[tuple[int, Issue]]) -> None:
        super().__init__(issues)
        self.issues = issues


class FaceInconsistent(Exception):
    """The photos are fine one by one but do not look like the same person."""

    def __init__(self, score: float) -> None:
        super().__init__(score)
        self.score = score


class FaceProvider(Protocol):
    model_version: str

    def enroll(
        self, images: Sequence[bytes], gates: Gates, match_threshold: float
    ) -> Enrollment: ...

    def verify(
        self, image: bytes, enrolled: Embedding, gates: Gates, thresholds: Thresholds
    ) -> FaceCheck: ...


def decide(score: float, thresholds: Thresholds) -> Decision:
    if score >= thresholds.verify:
        return Decision.VERIFIED
    if score >= thresholds.review:
        return Decision.PENDING_REVIEW
    return Decision.MISMATCH


def decode(data: bytes) -> NDArray[np.uint8]:
    """Decode (applying the EXIF rotation) and shrink so the longest side is at most 640 px."""
    try:
        image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR) if data else None
    except cv2.error:
        image = None
    if image is None or image.size == 0:
        raise PhotoRejected(Issue.UNREADABLE_IMAGE)
    height, width = image.shape[:2]
    scale = MAX_SIDE_PX / max(height, width)
    if scale < 1:
        size = (round(width * scale), round(height * scale))
        image = cv2.resize(image, size, interpolation=cv2.INTER_AREA)
    return np.asarray(image, dtype=np.uint8)  # no copy; cv2's stubs only say "some array"


@dataclass(frozen=True)
class _Analysis:
    embedding: Embedding
    quality: Quality
    jpeg: bytes


class OpenCVSFaceProvider:
    model_version = MODEL_VERSION

    def __init__(self, models_dir: Path = MODELS_DIR) -> None:
        self._dir = models_dir
        # The OpenCV models keep internal state, so one photo is processed at a time.
        # ponytail: one global lock; ~35 users punch a few times a day, ~100 ms each. Use a pool
        # of detector/recognizer pairs if the queue ever shows.
        self._lock = threading.Lock()
        self._detector: cv2.FaceDetectorYN | None = None
        self._recognizer: cv2.FaceRecognizerSF | None = None

    def _load(self) -> tuple[cv2.FaceDetectorYN, cv2.FaceRecognizerSF]:
        if self._detector is None or self._recognizer is None:
            detector = self._dir / DETECTOR_FILE
            recognizer = self._dir / RECOGNIZER_FILE
            if not (detector.is_file() and recognizer.is_file()):
                raise AppError(
                    "FACE_UNAVAILABLE",
                    "Face matching is not set up on this server (models are missing).",
                    503,
                )
            self._detector = cv2.FaceDetectorYN.create(
                str(detector), "", (MAX_SIDE_PX, MAX_SIDE_PX), CANDIDATE_FLOOR
            )
            self._recognizer = cv2.FaceRecognizerSF.create(str(recognizer), "")
        return self._detector, self._recognizer

    def _analyze(self, data: bytes, gates: Gates) -> _Analysis:
        image = decode(data)
        height, width = image.shape[:2]
        with self._lock:
            detector, recognizer = self._load()
            detector.setInputSize((width, height))
            _, faces = detector.detect(image)
            strong = [] if faces is None else [f for f in faces if f[14] >= gates.min_confidence]
            if not strong:
                raise PhotoRejected(Issue.NO_FACE if faces is None else Issue.LOW_CONFIDENCE)
            if len(strong) > 1:
                raise PhotoRejected(Issue.MULTIPLE_FACES)
            face = strong[0]
            quality = self._quality(image, face, gates)
            aligned = recognizer.alignCrop(image, face)
            vector = recognizer.feature(aligned)[0].astype(np.float32)
        vector /= np.linalg.norm(vector)
        jpeg = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])[1].tobytes()
        return _Analysis(vector, quality, jpeg)

    @staticmethod
    def _quality(image: NDArray[np.uint8], face: NDArray[np.float32], gates: Gates) -> Quality:
        x, y, w, h = (round(float(v)) for v in face[:4])
        height, width = image.shape[:2]
        crop = image[max(y, 0) : min(y + h, height), max(x, 0) : min(x + w, width)]
        if crop.size == 0:  # a box entirely outside the picture
            raise PhotoRejected(Issue.NO_FACE)
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        side = (SHARPNESS_SIDE_PX, SHARPNESS_SIDE_PX)
        sharpness = float(cv2.Laplacian(cv2.resize(gray, side), cv2.CV_64F).var())
        quality = Quality(float(face[14]), w, sharpness, float(gray.mean()))
        if w < gates.min_face_px:
            raise PhotoRejected(Issue.FACE_TOO_SMALL)
        # Light before sharpness: a dark photo is also low in contrast, and "too dark" is the
        # reason the person can act on.
        if quality.brightness < gates.min_brightness:
            raise PhotoRejected(Issue.TOO_DARK)
        if quality.brightness > gates.max_brightness:
            raise PhotoRejected(Issue.TOO_BRIGHT)
        if sharpness < gates.min_sharpness:
            raise PhotoRejected(Issue.BLURRY)
        return quality

    def enroll(self, images: Sequence[bytes], gates: Gates, match_threshold: float) -> Enrollment:
        analyses: list[_Analysis] = []
        issues: list[tuple[int, Issue]] = []
        for index, data in enumerate(images):
            try:
                analyses.append(self._analyze(data, gates))
            except PhotoRejected as rejected:
                issues.append((index, rejected.issue))
        if issues:
            raise FaceQualityError(issues)
        embeddings = np.stack([a.embedding for a in analyses])
        scores = embeddings @ embeddings.T
        consistency = float(scores[np.triu_indices(len(analyses), k=1)].min())
        if consistency < match_threshold:
            raise FaceInconsistent(consistency)
        return Enrollment(
            embeddings, [a.quality for a in analyses], [a.jpeg for a in analyses], consistency
        )

    def verify(
        self, image: bytes, enrolled: Embedding, gates: Gates, thresholds: Thresholds
    ) -> FaceCheck:
        try:
            analysis = self._analyze(image, gates)
        except PhotoRejected as rejected:
            return FaceCheck(Decision.RETAKE, None, rejected.issue, MODEL_VERSION, thresholds)
        score = float((enrolled @ analysis.embedding).max())
        return FaceCheck(decide(score, thresholds), score, None, MODEL_VERSION, thresholds)
