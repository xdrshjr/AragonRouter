"""Generate AragonRouter logo candidates on Alibaba MaaS (token plan).

Working route (verified, see design/probe-maas.py):
    POST {ROOT}/api/v1/services/aigc/multimodal-generation/generation
    model qwen-image-3.0-pro

The compatible-mode `/images/generations` path answers 400 "url error" on this
token-plan host, so the native DashScope service route is used instead.

Each prompt targets one *motif* rather than a "style", because the marks the user
holds up as references (Anthropic's burst, Figma's five shapes, Supabase's bolt,
Vercel's triangle) are each a single constructed silhouette. Everything that makes
AI art look like AI art - gradients, glow, bevels, drop shadows, texture, 3D,
lettering - is negated explicitly, because the raster gets projected onto a strict
two-colour duotone later and any of those would turn into mud.

Usage:
    python design/ai-logo.py --list
    python design/ai-logo.py --all
    python design/ai-logo.py --id portal
"""

from __future__ import annotations

import argparse
import json
import pathlib
import time
import urllib.error
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
OUT_DIR = HERE / "ai"
ROOT = "https://token-plan.cn-beijing.maas.aliyuncs.com"
ENDPOINT = f"{ROOT}/api/v1/services/aigc/multimodal-generation/generation"
MODEL = "qwen-image-3.0-pro"

# Shared vocabulary. Kept identical across motifs so the only variable in a
# comparison run is the silhouette itself.
COMMON = (
    "A single flat vector logo mark, nothing else. Constructed geometry, solid "
    "flat fills only, razor-sharp edges, generous even optical padding, the mark "
    "fills about 55 percent of a square canvas. Two colours only: near-black "
    "background #121212 and one mint-green accent #3ecf8e. Minimal, premium, "
    "timeless brand identity in the visual language of Anthropic, Figma, Vercel, "
    "Linear and Supabase logo marks. Must stay readable and distinctive when "
    "scaled down to 16 by 16 pixels. Absolutely no gradient, no glow, no drop "
    "shadow, no bevel, no emboss, no 3D render, no texture, no noise, no "
    "photographic elements, no lettering, no words, no watermark, no frame, no "
    "border, no rounded plate floating on a white canvas - the near-black must "
    "reach all four edges."
)

# id -> (motif description, extra constraints)
MOTIFS: dict[str, str] = {
    "portal": (
        "an angular gateway: a bold squared portal arch with one request path "
        "entering from the left and forking into two outgoing paths on the right, "
        "all drawn as thick flat ribbons of equal weight"
    ),
    "ribbon": (
        "one continuous folded ribbon that reads as a capital letter A, a single "
        "band that folds three times with no thickness variation, like a paper "
        "fold, plus one small square node on the crossbar"
    ),
    "fork": (
        "a routing fork: one vertical node at the bottom splitting through two "
        "clean diagonal segments into three small square nodes at the top, like a "
        "circuit trace, geometric and rigid"
    ),
    "bolt": (
        "a downward chevron bolt with a notch cut out of its left flank, a single "
        "solid angular glyph with deliberate asymmetry, in the spirit of the "
        "Supabase mark but distinct"
    ),
    "knot": (
        "a hexagonal woven knot of six interlocking flat strokes forming a closed "
        "loop with a hollow centre, mathematically regular, one stroke weight"
    ),
    "crest": (
        "a sharp angular crest of two mirrored blade shapes meeting at a narrow "
        "aperture in the centre, heraldic but strictly geometric, no curves"
    ),
}


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    for line in (HERE / ".env").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip()
    return env


def post_json(url: str, key: str, payload: dict) -> tuple[int, dict | str]:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")


def download(url: str, dest: pathlib.Path) -> int:
    with urllib.request.urlopen(url, timeout=600) as resp:
        data = resp.read()
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return len(data)


def image_urls(body: dict) -> list[str]:
    """Pull every image URL out of a multimodal-generation response."""
    urls: list[str] = []
    output = body.get("output") or {}
    for choice in output.get("choices") or []:
        for part in (choice.get("message") or {}).get("content") or []:
            if isinstance(part, dict) and part.get("image"):
                urls.append(part["image"])
    for result in output.get("results") or []:
        if isinstance(result, dict) and result.get("url"):
            urls.append(result["url"])
    return urls


def generate(motif_id: str, key: str, stamp: str) -> pathlib.Path | None:
    prompt = MOTIFS[motif_id] + ". " + COMMON
    payload = {
        "model": MODEL,
        "input": {"messages": [{"role": "user", "content": [{"text": prompt}]}]},
        "parameters": {"size": "1328*1328", "n": 1, "watermark": False},
    }
    print(f"[{motif_id}] requesting ...", flush=True)
    status, body = post_json(ENDPOINT, key, payload)
    if status != 200 or not isinstance(body, dict):
        print(f"[{motif_id}] HTTP {status}: {str(body)[:400]}")
        return None

    urls = image_urls(body)
    if not urls:
        print(f"[{motif_id}] no image in response: {json.dumps(body)[:400]}")
        return None

    dest = OUT_DIR / f"{stamp}-{motif_id}.png"
    size = download(urls[0], dest)
    print(f"[{motif_id}] saved {dest.name} ({size / 1024:.0f} KB)")
    return dest


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--id", action="append", default=[])
    args = ap.parse_args()

    if args.list:
        for key, value in MOTIFS.items():
            print(f"{key:8s} {value}")
        return 0

    env = load_env()
    key = env["MAAS_API_KEY"]
    targets = list(MOTIFS) if args.all else args.id
    if not targets:
        print("nothing selected; use --all or --id <motif>")
        return 2

    stamp = time.strftime("%Y-%m-%d-%H-%M-%S")
    made: list[pathlib.Path] = []
    for motif_id in targets:
        if motif_id not in MOTIFS:
            print(f"unknown motif {motif_id!r}")
            continue
        path = generate(motif_id, key, stamp)
        if path:
            made.append(path)

    print(f"\n{len(made)}/{len(targets)} generated")
    for path in made:
        print("  " + str(path.relative_to(HERE.parent)))
    return 0 if made else 1


if __name__ == "__main__":
    raise SystemExit(main())
