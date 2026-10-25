"""Analyse a generated logo PNG: background bleed, bounding box, accent palette.

Usage:  python design/inspect-logo.py <image.png>

Only reads pixels; never writes. Used to decide whether the generated art is
full-bleed (dark plate reaching all four edges) or a plate floating on a white
canvas that has to be cropped before it can become a favicon.
"""

from __future__ import annotations

import sys
from collections import Counter

from PIL import Image


def luminance(rgb: tuple[int, int, int]) -> float:
    r, g, b = rgb
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def main() -> int:
    path = sys.argv[1]
    im = Image.open(path).convert("RGB")
    w, h = im.size
    px = im.load()

    print(f"size            {w}x{h}")
    print(
        "corners         "
        + " ".join(
            "#%02x%02x%02x" % px[x, y]
            for x, y in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1))
        )
    )
    print("edge mids       " + " ".join(
        "#%02x%02x%02x" % px[x, y]
        for x, y in ((w // 2, 0), (w // 2, h - 1), (0, h // 2), (w - 1, h // 2))
    ))

    # Bounding box of "not near-white" pixels: tells us how much white margin exists.
    white_threshold = 245
    left, top, right, bottom = w, h, -1, -1
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            r, g, b = px[x, y]
            if not (r >= white_threshold and g >= white_threshold and b >= white_threshold):
                if x < left:
                    left = x
                if x > right:
                    right = x
                if y < top:
                    top = y
                if y > bottom:
                    bottom = y
    if right < 0:
        print("bbox            EMPTY (image is entirely white?)")
        return 1
    print(f"non-white bbox  x {left}..{right}  y {top}..{bottom}  ({right - left + 1}x{bottom - top + 1})")

    # Dominant colours, quantised so near-identical shades collapse.
    q = im.quantize(colors=16, method=Image.Quantize.MEDIANCUT).convert("RGB")
    counts = Counter(q.getdata())
    total = w * h
    print("dominant palette (quantised to 16):")
    for rgb, n in counts.most_common(8):
        r, g, b = rgb
        print(f"  {n / total * 100:5.2f}%  #{r:02x}{g:02x}{b:02x}  lum={luminance(rgb):6.1f}")

    # How much of the canvas is genuinely dark (candidate plate) vs green accent.
    dark = green = 0
    for r, g, b in q.getdata():
        if luminance((r, g, b)) < 60:
            dark += 1
        elif g > 120 and g > r + 40 and g > b + 20:
            green += 1
    print(f"dark pixels     {dark / total * 100:5.2f}%")
    print(f"green-ish       {green / total * 100:5.2f}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
