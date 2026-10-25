"""Turn an AI-generated logo master into the favicon / app-icon set.

The generated art is essentially duotone (near-black plate + one mint-green mark),
so instead of shipping the raw bitmap we project every pixel onto the exact C10
brand pair (`#121212` background, `#3ecf8e` accent). That buys three things:

  * brand fidelity  - the logo green is the same green as the UI accent, not the
    slightly different mint the model happened to pick;
  * vector-like edges - per-pixel "greenness" becomes the blend factor, so
    anti-aliasing survives while gradients/noise/compression artefacts collapse;
  * safe corners    - some generations draw a rounded dark plate floating on a
    white canvas; near-white pixels are treated as background, so no white
    fringe can leak into the icon.

Usage:
    python design/build-brand-assets.py --source design/<master>.png
    python design/build-brand-assets.py --source design/<master>.png --raw

`--raw` only flattens the plate (no duotone projection), useful for comparing.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image

# C10 design tokens. Keep in sync with src/app/globals.css.
BG = (0x12, 0x12, 0x12)
BRAND = (0x3E, 0xCF, 0x8E)

# A pixel counts as background when it is near-white: that is the tell-tale of a
# rounded plate rendered on a white canvas rather than a full-bleed icon.
WHITE_FLOOR = 244

# Derived outputs: (path, edge length)
TARGETS: tuple[tuple[str, int], ...] = (
    ("public/brand-mark.png", 512),
    ("src/app/icon.png", 256),
    ("src/app/apple-icon.png", 180),
    ("design/preview-32.png", 32),
)


def raw_greenness(px: tuple[int, int, int]) -> float:
    """Un-normalised measure of how far a pixel sits towards the accent pole.

    The plate is neutral grey (r == g == b), the mark is mint (g well above r and
    b), so a channel difference separates them cleanly with no per-generation
    threshold to tune.
    """
    r, g, b = px
    if r >= WHITE_FLOOR and g >= WHITE_FLOOR and b >= WHITE_FLOOR:
        return 0.0
    value = g - r
    # Deep greens read slightly blue-shifted in the mark; let blue contribute a
    # little so the darker inner edges do not vanish.
    value += max(0, g - b) / 6.0
    return max(0, value)


def lerp(a: int, b: int, t: float) -> int:
    return int(round(a + (b - a) * t))


def project(master: Image.Image, duotone: bool) -> Image.Image:
    src = master.convert("RGB")
    w, h = src.size
    src_px = src.load()

    # Normalise against the mark's own peak so the accent lands exactly on
    # BRAND instead of on whatever mint the model happened to emit. Without this
    # the projection is purely relative and the green comes out visibly duller
    # than the UI accent it sits next to.
    peak = 0.0
    if duotone:
        for y in range(h):
            for x in range(w):
                if raw_greenness(src_px[x, y]) > peak:
                    peak = raw_greenness(src_px[x, y])
        peak = max(peak, 1.0)

    out = Image.new("RGB", src.size, BG)
    out_px = out.load()
    for y in range(h):
        for x in range(w):
            px = src_px[x, y]
            if not duotone:
                # Raw path: white -> plate colour, everything else untouched.
                out_px[x, y] = BG if raw_greenness(px) == 0.0 else px
                continue
            t = min(1.0, raw_greenness(px) / peak)
            out_px[x, y] = (
                lerp(BG[0], BRAND[0], t),
                lerp(BG[1], BRAND[1], t),
                lerp(BG[2], BRAND[2], t),
            )
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, help="AI-generated master PNG (1024x1024)")
    ap.add_argument("--raw", action="store_true", help="skip duotone projection")
    args = ap.parse_args()

    root = Path(__file__).resolve().parent.parent
    master_path = Path(args.source).resolve()
    master = Image.open(master_path)
    print(f"source   {master_path.name}  {master.size[0]}x{master.size[1]}")

    flattened = project(master, duotone=not args.raw)
    (root / "design" / "brand-mark-normalised.png").parent.mkdir(parents=True, exist_ok=True)
    flattened.save(root / "design" / "brand-mark-normalised.png", optimize=True)
    print("wrote    design/brand-mark-normalised.png")

    for rel, size in TARGETS:
        dest = root / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        # Resize from the full-size master (never from an already-downscaled copy).
        resized = flattened.resize((size, size), Image.LANCZOS)
        if size <= 48:
            # Tiny sizes lose contrast on downscale; a light unsharp mask keeps the
            # mark from turning into mush in a 16px browser tab.
            from PIL import ImageFilter

            resized = resized.filter(ImageFilter.UnsharpMask(radius=0.6, percent=60, threshold=2))
        resized.save(dest, optimize=True)
        print(f"wrote    {rel}  {size}x{size}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
