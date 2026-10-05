"""Choose the face thresholds from real photos (SRS 9.7.4).

    uv run python scripts/calibrate_faces.py D:\\FaceTest

The folder holds one sub-folder per person, each with several photos of that person (different
days, light, angles; at least 2 people, ideally 10+ photos each). The folder stays OUTSIDE the
repository. The script only reads: it writes nothing, and prints scores and quality numbers,
never file names, images or embeddings.

Pairs of photos of the same person are "genuine"; pairs from different people are "impostor".
A real check compares a selfie with the best of three enrolled photos, so one-against-one pairs
are a little harsher than reality, which errs on the safe side.
"""

import argparse
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

# `python scripts/x.py` puts scripts/ on the path, not the backend root that holds `app`.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.modules.face.provider import (
    Issue,
    OpenCVSFaceProvider,
    PhotoRejected,
    Quality,
    gate_issue,
)
from app.modules.face.service import gates_from, thresholds_from
from app.modules.org_settings.schemas import OrgSettings

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
SCAN = [round(0.20 + 0.025 * step, 3) for step in range(21)]  # 0.200 ... 0.700
MIN_PAIRS_TO_TRUST = 100


@dataclass
class Photo:
    quality: Quality | None = None
    unusable: Issue | None = None  # no single clear face at all
    fails: Issue | None = None  # usable, but would not pass today's gates
    embedding: np.ndarray | None = field(default=None, repr=False)


@dataclass
class Report:
    people: dict[str, list[Photo]]
    genuine: list[float]
    impostor: list[float]


def photo_files(folder: Path) -> list[Path]:
    return sorted(p for p in folder.iterdir() if p.suffix.lower() in IMAGE_SUFFIXES)


def calibrate(root: Path, settings: OrgSettings | None = None) -> Report:
    settings = settings or OrgSettings()
    gates = gates_from(settings)
    provider = OpenCVSFaceProvider()
    people: dict[str, list[Photo]] = {}
    for folder in sorted(p for p in root.iterdir() if p.is_dir()):
        photos: list[Photo] = []
        for path in photo_files(folder):
            try:
                embedding, quality = provider.measure(path.read_bytes())
            except PhotoRejected as rejected:
                photos.append(Photo(unusable=rejected.issue))
                continue
            photos.append(Photo(quality, None, gate_issue(quality, gates), embedding))
        people[folder.name] = photos

    usable = {
        name: [p.embedding for p in photos if p.embedding is not None]
        for name, photos in people.items()
    }
    genuine: list[float] = []
    impostor: list[float] = []
    names = list(usable)
    for i, name in enumerate(names):
        vectors = usable[name]
        genuine += [float(a @ b) for k, a in enumerate(vectors) for b in vectors[k + 1 :]]
        for other in names[i + 1 :]:
            impostor += [float(a @ b) for a in vectors for b in usable[other]]
    return Report(people, genuine, impostor)


def _stats(values: list[float]) -> str:
    if not values:
        return "no pairs"
    a = np.array(values)
    p5, median, p95 = np.percentile(a, [5, 50, 95])
    return (
        f"n={len(a):<4} min {a.min():6.3f}  p5 {p5:6.3f}  median {median:6.3f}  "
        f"p95 {p95:6.3f}  max {a.max():6.3f}"
    )


def _histogram(genuine: list[float], impostor: list[float]) -> list[str]:
    edges = np.arange(-0.2, 1.01, 0.1)
    g, _ = np.histogram(genuine, bins=edges)
    i, _ = np.histogram(impostor, bins=edges)
    top = max(int(g.max(initial=0)), int(i.max(initial=0)), 1)
    lines = ["  score        impostor                genuine"]
    for k in range(len(edges) - 1):
        bar = lambda n: ("#" * round(20 * n / top)).ljust(20)  # noqa: E731
        lines.append(
            f"  {edges[k]:5.2f}-{edges[k + 1]:4.2f}  {bar(i[k])} {i[k]:<4} {bar(g[k])} {g[k]}"
        )
    return lines


def render(report: Report, settings: OrgSettings | None = None) -> str:
    settings = settings or OrgSettings()
    gates, thresholds = gates_from(settings), thresholds_from(settings)
    out: list[str] = ["PHOTOS"]
    spread: dict[str, list[float]] = {
        "face width (px)": [],
        "sharpness": [],
        "brightness": [],
        "confidence": [],
    }
    for name, photos in report.people.items():
        usable = [p for p in photos if p.quality is not None]
        out.append(f"  {name}: {len(photos)} photos, {len(usable)} usable")
        for number, photo in enumerate(photos, start=1):
            if photo.unusable:
                out.append(f"    #{number}: unusable ({photo.unusable.value})")
            elif photo.fails:
                out.append(f"    #{number}: would be a retake today ({photo.fails.value})")
        for q in (p.quality for p in usable if p.quality is not None):
            spread["face width (px)"].append(q.face_px)
            spread["sharpness"].append(q.sharpness)
            spread["brightness"].append(q.brightness)
            spread["confidence"].append(q.confidence)

    out += ["", "QUALITY OF THE USABLE PHOTOS (compare with the gates in Settings)"]
    limits = {
        "face width (px)": f"gate {gates.min_face_px}",
        "sharpness": f"gate {gates.min_sharpness:g}",
        "brightness": f"gate {gates.min_brightness}-{gates.max_brightness}",
        "confidence": f"gate {gates.min_confidence}",
    }
    for label, values in spread.items():
        if values:
            a = np.array(values)
            out.append(
                f"  {label:<16} min {a.min():8.2f}  median {np.median(a):8.2f}  "
                f"max {a.max():8.2f}   ({limits[label]})"
            )

    out += ["", "SCORES (cosine similarity)"]
    out.append(f"  genuine  (same person)       {_stats(report.genuine)}")
    out.append(f"  impostor (different people)  {_stats(report.impostor)}")
    out += ["", *_histogram(report.genuine, report.impostor)]

    out += ["", "ERROR RATE AT EACH THRESHOLD"]
    out.append("  threshold   impostors accepted (FAR)   genuine rejected (FRR)")
    gen, imp = np.array(report.genuine), np.array(report.impostor)
    zero_far: float | None = None
    for t in SCAN:
        far = float((imp >= t).mean() * 100) if imp.size else float("nan")
        frr = float((gen < t).mean() * 100) if gen.size else float("nan")
        marks = [
            label
            for label, value in (("review", thresholds.review), ("verify", thresholds.verify))
            if abs(value - t) < 1e-9
        ]
        if zero_far is None and imp.size and far == 0:
            zero_far = t
        note = f"  <- current {'/'.join(marks)} threshold" if marks else ""
        out.append(f"  {t:8.3f}   {far:20.1f} %   {frr:20.1f} %{note}")

    out += ["", "READING THE RESULT"]
    if zero_far is None:
        out.append(
            "  Some impostor pairs score above 0.70: the models do not separate these people."
        )
    else:
        out.append(f"  Lowest scanned threshold with no impostor accepted: {zero_far:.3f}.")
        out.append(
            f"  Today: verify {thresholds.verify}, review {thresholds.review}. Choose verify where "
            "impostors essentially never pass;"
            " genuine pairs between review and verify go to an admin."
        )
    if len(report.impostor) < MIN_PAIRS_TO_TRUST:
        out.append(
            f"  Only {len(report.impostor)} impostor pairs (<{MIN_PAIRS_TO_TRUST}): 'no impostor "
            "accepted' says little. Add more people and photos before trusting the numbers."
        )
    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("folder", type=Path, help="one sub-folder of photos per person")
    root = parser.parse_args(argv).folder
    if not root.is_dir():
        print(f"{root} is not a folder.", file=sys.stderr)
        return 2
    report = calibrate(root)
    if len([n for n, photos in report.people.items() if photos]) < 2:
        print(
            "Need at least 2 sub-folders (people) with photos: one folder per person.",
            file=sys.stderr,
        )
        return 2
    print(render(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
