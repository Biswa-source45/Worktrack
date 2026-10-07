"""Derives every brand image the apps use from the owner's original logo files.

Run from the repo root (needs opencv and numpy, which the backend environment has):

    cd apps/backend && uv run python ../../scripts/brand-assets.py "<folder with the original PNGs>"

The originals are never committed. What is written (and committed) is listed in docs/DESIGN.md
section 11, with which original each file comes from. Nothing here draws or recolours the logo:
it only crops, cleans the edges, scales, and removes a flat background.
"""

import struct
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
MOBILE = ROOT / "apps/mobile/assets/brand"
WEB_PUBLIC = ROOT / "apps/web/public/brand"
WEB_APP = ROOT / "apps/web/src/app"

# Original file names (the owner's folder).
GLOSSY_MARK = "Glossy Orange Ribbon W Pin Logo.png"  # transparent glossy W + pin
GLOSSY_ICON = "Glossy Orange Ribbon Pin Logo black for app icon.png"  # glossy W + pin on black
COPPER_LIGHT = "WorkTrack Logo with Orange Emblem.png"  # transparent, black wordmark
COPPER_DARK = "WorkTrack Dark Corporate Logo Banner.png"  # opaque near-black, white wordmark


def load(folder: Path, name: str) -> np.ndarray:
    data = np.fromfile(str(folder / name), dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise SystemExit(f"cannot read {name}")
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    if img.shape[2] == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
    return img


def save(path: Path, img: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    ok, buf = cv2.imencode(".png", img, [cv2.IMWRITE_PNG_COMPRESSION, 9])
    if not ok:
        raise SystemExit(f"cannot encode {path.name}")
    buf.tofile(str(path))
    print(f"{path.relative_to(ROOT)}  {img.shape[1]}x{img.shape[0]}  {path.stat().st_size // 1024} KB")


def bbox(alpha: np.ndarray, threshold: int = 8) -> tuple[int, int, int, int]:
    ys, xs = np.where(alpha > threshold)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def crop(img: np.ndarray, pad: int = 0) -> np.ndarray:
    x0, y0, x1, y1 = bbox(img[:, :, 3])
    x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
    x1, y1 = min(img.shape[1], x1 + pad), min(img.shape[0], y1 + pad)
    return img[y0:y1, x0:x1]


def clean_edges(img: np.ndarray) -> np.ndarray:
    """Drops stray specks and the dark 1-2 px fringe a generator leaves around a cut-out."""
    out = img.copy()
    alpha = out[:, :, 3]
    count, labels, stats, _ = cv2.connectedComponentsWithStats((alpha > 8).astype(np.uint8), 8)
    areas = stats[1:, cv2.CC_STAT_AREA]
    keep = [i + 1 for i, area in enumerate(areas) if area >= 0.01 * areas.max()]
    alpha = np.where(np.isin(labels, keep), alpha, 0).astype(np.uint8)
    alpha = cv2.erode(alpha, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)), iterations=2)
    out[:, :, 3] = cv2.GaussianBlur(alpha, (0, 0), 0.8)
    return out


def fit(img: np.ndarray, width: int) -> np.ndarray:
    scale = width / img.shape[1]
    return cv2.resize(img, (width, round(img.shape[0] * scale)), interpolation=cv2.INTER_AREA)


def on_canvas(mark: np.ndarray, size: int, width: int, background=(0, 0, 0, 0)) -> np.ndarray:
    """The mark scaled to `width`, centred on a square canvas of one colour (or transparent)."""
    small = fit(mark, width)
    canvas = np.zeros((size, size, 4), np.uint8)
    canvas[:] = background
    x, y = (size - small.shape[1]) // 2, (size - small.shape[0]) // 2
    region = canvas[y : y + small.shape[0], x : x + small.shape[1]]
    a = small[:, :, 3:4].astype(np.float32) / 255
    mixed = small[:, :, :3] * a + region[:, :, :3] * (1 - a)
    out_a = np.maximum(region[:, :, 3:4].astype(np.float32), small[:, :, 3:4])
    region[:] = np.concatenate([mixed, out_a], axis=2).astype(np.uint8)
    return canvas


def silhouette(img: np.ndarray) -> np.ndarray:
    """White, same shape: what Android wants for the themed icon and the notification icon."""
    out = np.zeros_like(img)
    out[:, :, :3] = 255
    out[:, :, 3] = np.where(img[:, :, 3] > 100, 255, 0)
    out[:, :, 3] = cv2.GaussianBlur(out[:, :, 3], (0, 0), 0.8)
    return out


def remove_flat_background(img: np.ndarray, soft: tuple[int, int] = (8, 60)) -> np.ndarray:
    """Turns an opaque logo on a flat dark background into a transparent one.

    The background colour is the median of the four corners. Distance from it becomes the alpha
    (a soft ramp, so edges stay smooth); the colours are kept as they are.
    """
    bgr = img[:, :, :3].astype(np.int16)
    corners = np.array([bgr[0, 0], bgr[0, -1], bgr[-1, 0], bgr[-1, -1]])
    background = np.median(corners, axis=0)
    distance = np.abs(bgr - background).max(axis=2).astype(np.float32)
    low, high = soft
    alpha = np.clip((distance - low) / (high - low), 0, 1)
    out = img.copy()
    out[:, :, 3] = (alpha * 255).astype(np.uint8)
    return out


def split_mark(lockup: np.ndarray) -> np.ndarray:
    """The W + pin on the left of a horizontal logo: everything before the first gap."""
    columns = (lockup[:, :, 3] > 8).any(axis=0)
    x, gap = 0, 0
    started = False
    for i, filled in enumerate(columns):
        if filled:
            started, gap = True, 0
            x = i + 1
        elif started:
            gap += 1
            if gap >= 15:
                break
    return crop(lockup[:, :x])


def compact(lockup: np.ndarray) -> np.ndarray:
    """Mark + wordmark only: the tagline and the divider line are too small to read in a sidebar.

    The same pixels, cropped and re-spaced (no scaling, no redrawing).
    """
    alpha = lockup[:, :, 3] > 8
    columns = alpha.any(axis=0)
    runs, start = [], None
    for i, filled in enumerate(list(columns) + [False]):
        if filled and start is None:
            start = i
        elif not filled and start is not None:
            runs.append((start, i))
            start = None
    # Merge runs closer than 15 px (letters of one word); what is left is mark, divider, text.
    merged = [runs[0]]
    for a, b in runs[1:]:
        if a - merged[-1][1] < 15:
            merged[-1] = (merged[-1][0], b)
        else:
            merged.append((a, b))
    mark = crop(lockup[:, : merged[0][1]])
    text = lockup[:, merged[-1][0] : merged[-1][1]]
    rows = (text[:, :, 3] > 8).any(axis=1)
    top = int(np.argmax(rows))
    bottom = top
    while bottom < len(rows) and (rows[bottom] or rows[bottom : bottom + 6].any()):
        bottom += 1
    word = crop(text[top:bottom])
    gap = round(mark.shape[1] * 0.14)
    height = max(mark.shape[0], word.shape[0])
    out = np.zeros((height, mark.shape[1] + gap + word.shape[1], 4), np.uint8)
    # The wordmark sits on the mark's body (the lower 75 %), not on the pin's top.
    body_centre = round(mark.shape[0] * 0.62)
    out[: mark.shape[0], : mark.shape[1]] = mark
    y = min(max(0, body_centre - word.shape[0] // 2), height - word.shape[0])
    out[y : y + word.shape[0], mark.shape[1] + gap :] = word
    return crop(out, 4)


def ico(images: list[np.ndarray]) -> bytes:
    """A .ico that holds PNG images (every browser reads this)."""
    blobs = [cv2.imencode(".png", im)[1].tobytes() for im in images]
    header = struct.pack("<HHH", 0, 1, len(blobs))
    offset = 6 + 16 * len(blobs)
    entries = b""
    for im, blob in zip(images, blobs, strict=True):
        w = im.shape[1]
        entries += struct.pack("<BBBBHHII", w % 256, w % 256, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
    return header + entries + b"".join(blobs)


def main(folder: Path) -> None:
    glossy = clean_edges(crop(load(folder, GLOSSY_MARK)))
    mark_silhouette = silhouette(glossy)

    # --- launcher icon and splash: the glossy mark (owner's choice, Q1/Q3) ---------------------
    black = load(folder, GLOSSY_ICON)
    x0, y0, x1, y1 = bbox(black[:, :, :3].max(axis=2), 40)
    icon_mark = black[y0:y1, x0:x1].copy()
    icon_mark[:, :, 3] = 255
    save(MOBILE / "icon.png", on_canvas(icon_mark, 1024, 760, (0, 0, 0, 255)))
    # Android adaptive: the visible area is a circle of 66/108 of the canvas, so the wide mark must
    # fit inside 0.6 of the width diagonally.
    save(MOBILE / "adaptive-icon-foreground.png", on_canvas(glossy, 1024, 520))
    save(MOBILE / "adaptive-icon-monochrome.png", on_canvas(mark_silhouette, 1024, 520))
    save(MOBILE / "splash-icon.png", on_canvas(glossy, 1024, 520))
    # Notification: white on transparent, 96 px.
    save(MOBILE / "notification-icon.png", on_canvas(mark_silhouette, 96, 84))

    # --- the interface: the copper logo ---------------------------------------------------------
    light = crop(load(folder, COPPER_LIGHT), 6)
    dark = crop(remove_flat_background(load(folder, COPPER_DARK)), 6)
    mark_light, mark_dark = split_mark(light), split_mark(dark)
    compact_light, compact_dark = compact(light), compact(dark)
    save(MOBILE / "logo-light.png", fit(light, 720))
    save(MOBILE / "logo-dark.png", fit(dark, 720))
    save(MOBILE / "logo-compact-light.png", fit(compact_light, 480))
    save(MOBILE / "logo-compact-dark.png", fit(compact_dark, 480))
    save(WEB_PUBLIC / "logo-light.png", fit(light, 640))
    save(WEB_PUBLIC / "logo-dark.png", fit(dark, 640))
    save(WEB_PUBLIC / "logo-compact-light.png", fit(compact_light, 480))
    save(WEB_PUBLIC / "logo-compact-dark.png", fit(compact_dark, 480))
    save(WEB_PUBLIC / "mark-light.png", fit(mark_light, 256))
    save(WEB_PUBLIC / "mark-dark.png", fit(mark_dark, 256))

    # Favicons: the copper mark reads on a light and a dark tab strip alike.
    square = on_canvas(mark_light, 512, 460)
    save(WEB_APP / "icon.png", square)
    save(WEB_APP / "apple-icon.png", on_canvas(mark_light, 180, 140, (255, 255, 255, 255)))
    sizes = [fit(on_canvas(mark_light, 512, 480), s) for s in (16, 32, 48)]
    (WEB_APP / "favicon.ico").write_bytes(ico(sizes))
    print("apps/web/src/app/favicon.ico  16/32/48")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(Path(sys.argv[1]))
