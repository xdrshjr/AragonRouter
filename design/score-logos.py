"""Score AI logo candidates on the properties that make a mark usable as an icon.

A generated image cannot be judged by eye from here, so this ranks candidates on
measurable proxies for "works as a logo":

  coverage    accent area as a fraction of the canvas (too low = weak at 16px,
              too high = mud; the sweet spot for a glyph is roughly 8-30%)
  solidity    accent pixels that form one connected blob vs scattered speckle -
              a real mark is one or few shapes, AI noise is thousands of specks
  symmetry    best horizontal/vertical mirror agreement of the binary mask;
              constructed logos score high even when they are not identical
  centring    distance of the mask centroid from the canvas centre
  margins     clearance between the mark and the canvas edge (no cropping)
  palette     how close the art already sits to the two-colour brand pair

Usage:  python design/score-logos.py design/ai/*.png
"""

from __future__ import annotations

import pathlib
import sys
from collections import deque

from PIL import Image

BG = (0x12, 0x12, 0x12)
BRAND = (0x3E, 0xCF, 0x8E)


def accent_mask(im: Image.Image, size: int = 256) -> tuple[list[list[bool]], int, int]:
    """Downscale and threshold on greenness, returning a boolean grid."""
    small = im.convert("RGB").resize((size, size), Image.LANCZOS)
    px = small.load()
    grid: list[list[bool]] = []
    for y in range(size):
        row: list[bool] = []
        for x in range(size):
            r, g, b = px[x, y]
            # Same separation the normaliser uses: mint is far greener than it is red.
            row.append((g - r) > 40 and g > 90)
        grid.append(row)
    return grid, size, size


def components(grid: list[list[bool]], h: int, w: int) -> list[int]:
    """Sizes of 8-connected accent blobs, largest first."""
    seen = [[False] * w for _ in range(h)]
    sizes: list[int] = []
    for sy in range(h):
        for sx in range(w):
            if not grid[sy][sx] or seen[sy][sx]:
                continue
            queue = deque([(sx, sy)])
            seen[sy][sx] = True
            count = 0
            while queue:
                x, y = queue.popleft()
                count += 1
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < w and 0 <= ny < h and grid[ny][nx] and not seen[ny][nx]:
                            seen[ny][nx] = True
                            queue.append((nx, ny))
            sizes.append(count)
    sizes.sort(reverse=True)
    return sizes


def mirror_score(grid: list[list[bool]], h: int, w: int) -> tuple[float, float]:
    """Agreement of the mask with its horizontal and vertical mirror image."""
    total = 0
    agree_h = 0
    agree_v = 0
    for y in range(h):
        for x in range(w):
            if grid[y][x]:
                total += 1
                if grid[y][w - 1 - x]:
                    agree_h += 1
                if grid[h - 1 - y][x]:
                    agree_v += 1
    if total == 0:
        return 0.0, 0.0
    return agree_h / total, agree_v / total


def palette_fit(im: Image.Image) -> float:
    """Fraction of pixels already within 40 units of the C10 duotone ramp."""
    px = im.convert("RGB").resize((128, 128), Image.LANCZOS).load()
    on = 0
    for y in range(128):
        for x in range(128):
            r, g, b = px[x, y]
            dr, dg, db = BRAND[0] - BG[0], BRAND[1] - BG[1], BRAND[2] - BG[2]
            pr, pg, pb = r - BG[0], g - BG[1], b - BG[2]
            length = dr * dr + dg * dg + db * db
            t = max(0.0, min(1.0, (pr * dr + pg * dg + pb * db) / length))
            er, eg, eb = pr - dr * t, pg - dg * t, pb - db * t
            if (er * er + eg * eg + eb * eb) ** 0.5 <= 40:
                on += 1
    return on / (128 * 128)


def score(path: pathlib.Path) -> dict[str, float]:
    im = Image.open(path)
    grid, h, w = accent_mask(im)
    blobs = components(grid, h, w)
    ink = sum(blobs)
    total = h * w
    largest = blobs[0] if blobs else 0

    xs = [x for y in range(h) for x in range(w) if grid[y][x]]
    ys = [y for y in range(h) for x in range(w) if grid[y][x]]
    if xs:
        cx = sum(xs) / len(xs)
        cy = sum(ys) / len(ys)
        margin = min(min(xs), w - 1 - max(xs), min(ys), h - 1 - max(ys)) / w
        centre_off = (((cx - w / 2) ** 2 + (cy - h / 2) ** 2) ** 0.5) / w
    else:
        margin = 0.0
        centre_off = 1.0

    agree_h, agree_v = mirror_score(grid, h, w)

    return {
        "coverage": ink / total,
        "blobs": float(len(blobs)),
        "solidity": (largest / ink) if ink else 0.0,
        "sym_h": agree_h,
        "sym_v": agree_v,
        "margin": margin,
        "centre_off": centre_off,
        "palette": palette_fit(im),
        "ink": float(ink),
    }


def verdict(s: dict[str, float]) -> tuple[float, list[str]]:
    """Weighted score plus human-readable reasons it lost points."""
    notes: list[str] = []
    points = 0.0

    cov = s["coverage"]
    if 0.06 <= cov <= 0.32:
        points += 3.0
    elif 0.03 <= cov <= 0.45:
        points += 1.5
        notes.append(f"coverage {cov:.0%} is borderline")
    else:
        notes.append(f"coverage {cov:.0%} outside 6-32%")

    sol = s["solidity"]
    if sol >= 0.92:
        points += 3.0
    elif sol >= 0.75:
        points += 1.5
        notes.append(f"solidity {sol:.0%} (some speckle)")
    else:
        notes.append(f"solidity {sol:.0%} (fragmented)")

    sym = max(s["sym_h"], s["sym_v"])
    if sym >= 0.9:
        points += 2.0
    elif sym >= 0.72:
        points += 1.0
        notes.append(f"symmetry {sym:.0%}")
    else:
        notes.append(f"symmetry only {sym:.0%} on both axes")

    if s["centre_off"] <= 0.03:
        points += 1.5
    elif s["centre_off"] <= 0.07:
        points += 0.75
        notes.append("slightly off-centre")
    else:
        notes.append(f"centre offset {s['centre_off']:.0%}")

    if s["margin"] >= 0.06:
        points += 1.0
    else:
        notes.append(f"margin {s['margin']:.0%} (mark touches edge)")

    if s["palette"] >= 0.97:
        points += 1.5
    elif s["palette"] >= 0.85:
        points += 0.75
        notes.append(f"palette fit {s['palette']:.0%}")
    else:
        notes.append(f"palette fit only {s['palette']:.0%} (needs heavy normalising)")

    return points, notes


def main() -> int:
    paths = [pathlib.Path(p) for p in sys.argv[1:]]
    if not paths:
        print("usage: python design/score-logos.py <png> [png ...]")
        return 2

    rows = []
    for path in paths:
        s = score(path)
        points, notes = verdict(s)
        rows.append((points, path, s, notes))
    rows.sort(key=lambda r: r[0], reverse=True)

    for points, path, s, notes in rows:
        print(f"{points:4.1f}  {path.name}")
        print(
            f"      coverage {s['coverage']:.1%}  solidity {s['solidity']:.0%}  "
            f"sym h/v {s['sym_h']:.0%}/{s['sym_v']:.0%}  centre {s['centre_off']:.1%}  "
            f"margin {s['margin']:.1%}  palette {s['palette']:.0%}  blobs {int(s['blobs'])}"
        )
        for note in notes:
            print(f"      - {note}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
