"""Download the two pretrained face models (YuNet detector, SFace recognizer) into models/.

    uv run python scripts/download_models.py

The files are pinned to one opencv_zoo commit and checked against SHA-256 values written in this
file, so a changed or damaged download is refused. Files that already match are left alone. The
models are git-ignored; their licence texts are saved next to them (YuNet: MIT, SFace: Apache 2.0).
"""

import hashlib
import sys
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

MODELS_DIR = Path(__file__).resolve().parents[1] / "models"

# opencv_zoo main as of 2026-10-05. GitHub and Hugging Face served byte-identical files.
COMMIT = "47534e27c9851bb1128ccc0102f1145e27f23f98"
SOURCES = (
    "https://github.com/opencv/opencv_zoo/raw/{commit}/models/{path}",
    "https://huggingface.co/opencv/opencv_zoo/resolve/{commit}/models/{path}",
)


@dataclass(frozen=True)
class Asset:
    name: str  # file name inside models/
    path: str  # path inside opencv_zoo/models/
    sha256: str


ASSETS = (
    Asset(
        "face_detection_yunet_2023mar.onnx",
        "face_detection_yunet/face_detection_yunet_2023mar.onnx",
        "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
    ),
    Asset(
        "face_recognition_sface_2021dec.onnx",
        "face_recognition_sface/face_recognition_sface_2021dec.onnx",
        "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
    ),
    Asset(
        "LICENSE-yunet.txt",
        "face_detection_yunet/LICENSE",
        "c83b8120c50ccbd4c4f96edf53141bdd566ebb8f8e9227e415326aa1b1aba958",
    ),
    Asset(
        "LICENSE-sface.txt",
        "face_recognition_sface/LICENSE",
        "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
    ),
)


def fetch(url: str) -> bytes:
    if not url.startswith("https://"):
        raise ValueError(f"refusing a non-HTTPS URL: {url}")
    with urllib.request.urlopen(url, timeout=120) as response:  # noqa: S310  (HTTPS checked above)
        data: bytes = response.read()
    return data


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def ensure(asset: Asset, directory: Path = MODELS_DIR, get: Callable[[str], bytes] = fetch) -> str:
    """Make `directory/asset.name` match its checksum. Returns "ok" or "downloaded"."""
    target = directory / asset.name
    if target.is_file() and digest(target) == asset.sha256:
        return "ok"
    directory.mkdir(parents=True, exist_ok=True)
    problems: list[str] = []
    for template in SOURCES:
        url = template.format(commit=COMMIT, path=asset.path)
        try:
            data = get(url)
        except OSError as exc:  # network errors; try the next source
            problems.append(f"{url}: {exc}")
            continue
        if hashlib.sha256(data).hexdigest() != asset.sha256:
            problems.append(f"{url}: checksum mismatch")
            continue
        partial = target.with_suffix(target.suffix + ".part")
        partial.write_bytes(data)
        partial.replace(target)  # a half-written file never has the final name
        return "downloaded"
    raise RuntimeError(f"could not get {asset.name}:\n  " + "\n  ".join(problems))


def main() -> int:
    for asset in ASSETS:
        try:
            print(f"{asset.name}: {ensure(asset)}")
        except RuntimeError as exc:
            print(exc, file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
