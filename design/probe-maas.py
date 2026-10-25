"""Discover the working image-generation route of the Alibaba MaaS token-plan host.

Step 1 proves the host + key + OpenAI-compatible base are healthy by calling a text
model. Step 2 tries the plausible image routes (compatible-mode and the native
DashScope service paths) so the correct one is found by experiment rather than by
guessing. Credentials come from design/.env (gitignored).
"""

from __future__ import annotations

import json
import pathlib
import urllib.error
import urllib.request

ROOT = "https://token-plan.cn-beijing.maas.aliyuncs.com"


def load_env() -> dict[str, str]:
    path = pathlib.Path(__file__).resolve().parent / ".env"
    env: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip()
    return env


def call(url: str, key: str, payload: dict | None, method: str = "POST") -> tuple[int, str]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001 - probe script, surface everything
        return 0, f"{type(exc).__name__}: {exc}"


def main() -> int:
    env = load_env()
    key = env["MAAS_API_KEY"]
    base = env["MAAS_BASE_URL"].rstrip("/")

    print("== step 1: is the OpenAI-compatible base alive? ==")
    status, text = call(
        f"{base}/chat/completions",
        key,
        {
            "model": "qwen3.6-flash",
            "messages": [{"role": "user", "content": "reply with the word ok"}],
            "max_tokens": 8,
        },
    )
    print(f"[{status}] {text[:300].replace(chr(10), ' ')}")

    print("\n== step 2: candidate image routes ==")
    candidates: list[tuple[str, str, dict]] = [
        (
            "compatible /images/generations",
            f"{base}/images/generations",
            {"model": "qwen-image-3.0-pro", "prompt": "a green square", "n": 1},
        ),
        (
            "native multimodal-generation",
            f"{ROOT}/api/v1/services/aigc/multimodal-generation/generation",
            {
                "model": "qwen-image-3.0-pro",
                "input": {"messages": [{"role": "user", "content": [{"text": "a green square"}]}]},
                "parameters": {"size": "1024*1024", "n": 1},
            },
        ),
        (
            "native text2image",
            f"{ROOT}/api/v1/services/aigc/text2image/image-synthesis",
            {
                "model": "wan2.7-image-pro",
                "input": {"prompt": "a green square"},
                "parameters": {"size": "1024*1024", "n": 1},
            },
        ),
        (
            "compatible /images/generations (wan2.7-image)",
            f"{base}/images/generations",
            {"model": "wan2.7-image", "prompt": "a green square", "n": 1},
        ),
    ]

    for label, url, payload in candidates:
        status, text = call(url, key, payload)
        print(f"[{status}] {label}  {url}")
        print(f"      {text[:400].replace(chr(10), ' ')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
