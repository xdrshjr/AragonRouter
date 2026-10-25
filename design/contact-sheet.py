"""Build a labelled contact sheet so the candidates can be judged by eye.

Prints, for every candidate, three things side by side:
  1. the raw generated art
  2. the art after the duotone projection (what actually ships)
  3. a 16px render blown up x16 with nearest-neighbour, i.e. what a browser tab
     actually shows - the harshest legibility test there is

Writes design/logo-candidates.png.
"""

from __future__ import annotations

import importlib.util
import pathlib
import sys

from PIL import Image, ImageDraw

HERE = pathlib.Path(__file__).resolve().parent


def load_normaliser():
    """Import the hyphenated build script so the projection stays single-sourced."""
    spec = importlib.util.spec_from_file_location(
        "build_brand_assets", HERE / "build-brand-assets.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


TILE = 300
PAD = 18
LABEL_H = 54
COLS = 2
QUAD = 138  # each of the three panels inside one tile


def main() -> int:
    sources = sorted((HERE / "ai").glob("*.png"))
    if not sources:
        print("no candidates in design/ai/")
        return 1

    normalise = load_normaliser()

    rows = (len(sources) + COLS - 1) // COLS
    sheet_w = COLS * (TILE + PAD) + PAD
    sheet_h = rows * (TILE + LABEL_H + PAD) + PAD
    sheet = Image.new("RGB", (sheet_w, sheet_h), (0x0B, 0x0B, 0x0B))
    draw = ImageDraw.Draw(sheet)

    for index, path in enumerate(sources):
        motif = path.stem.split("-", 5)[-1]
        col = index % COLS
        row = index // COLS
        x0 = PAD + col * (TILE + PAD)
        y0 = PAD + row * (TILE + LABEL_H + PAD)

        raw = Image.open(path).convert("RGB")
        flat = normalise.project(raw, duotone=True)

        # Row 1: raw AI art (left) beside the duotone projection (right).
        sheet.paste(raw.resize((QUAD, QUAD), Image.LANCZOS), (x0, y0))
        sheet.paste(flat.resize((QUAD, QUAD), Image.LANCZOS), (x0 + QUAD + 8, y0))

        # Row 2: the 16px truth, magnified without smoothing - the harshest test.
        tiny = flat.resize((16, 16), Image.LANCZOS)
        sheet.paste(tiny.resize((QUAD, QUAD), Image.NEAREST), (x0, y0 + QUAD + 8))

        # Row 2, right column: the same mark at 32px, which is the browser's usual
        # tab size on a high-DPI screen.
        mid = flat.resize((32, 32), Image.LANCZOS)
        sheet.paste(mid.resize((QUAD, QUAD), Image.NEAREST), (x0 + QUAD + 8, y0 + QUAD + 8))

        draw.rectangle([x0, y0, x0 + TILE - 1, y0 + TILE - 1], outline=(0x2A, 0x2A, 0x2A))
        label_y = y0 + TILE + 8
        draw.text((x0, label_y), f"{index + 1}. {motif}", fill=(0xED, 0xED, 0xED))
        draw.text(
            (x0, label_y + 22),
            "raw AI / duotone / 16px / 32px",
            fill=(0x8F, 0x8F, 0x8F),
        )

    out = HERE / "logo-candidates.png"
    sheet.save(out, optimize=True)
    print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KB)")
    for index, path in enumerate(sources):
        print(f"  {index + 1}. {path.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
