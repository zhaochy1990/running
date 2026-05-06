"""
Strength illustration pipeline (one-shot batch generator).

Reads `strength_illustrations/exercises.json` and generates one
muscle-activation diagram per exercise via gpt-image-2 on Azure
(AzureAI4Identity), with simplified-Chinese labels and zero English.

Output layout:
  strength_illustrations/output/<code>/v<N>.png
  strength_illustrations/output/<code>/v<N>.meta.json   (prompt + elapsed + ts)
  strength_illustrations/progress.json                   (state across runs)

Idempotency:
  - If output/<code>/v<latest>.png already exists, the exercise is SKIPPED.
  - To force a regeneration, pass --force <code> (writes a new vN+1).
  - Or pass --regen-prompt <code> --prompt-override "..." to use a custom
    prompt for that one regeneration.

Usage:
  python scripts/strength_illustrations.py                  # generate all missing
  python scripts/strength_illustrations.py --force T1061    # force regen one
  python scripts/strength_illustrations.py --only T1061,T1078,T1167   # subset
  python scripts/strength_illustrations.py --workers 4

Environment overrides:
  DEPLOYMENT_NAME=gpt-image-2  (default)
  AZURE_IMAGE_KEY=<key>        (otherwise uses DefaultAzureCredential)
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import httpx

DEPLOYMENT = os.getenv("DEPLOYMENT_NAME", "gpt-image-2")
ENDPOINT = (
    f"https://azureai4identity.cognitiveservices.azure.com"
    f"/openai/deployments/{DEPLOYMENT}/images/generations"
    f"?api-version=2024-02-01"
)

DATA_DIR = Path("strength_illustrations")
EXERCISES_PATH = DATA_DIR / "exercises.json"
OUTPUT_DIR = DATA_DIR / "output"
PROGRESS_PATH = DATA_DIR / "progress.json"


# --------------------------------------------------------------------------
# Auth
# --------------------------------------------------------------------------
def get_auth_headers() -> dict[str, str]:
    api_key = os.getenv("AZURE_IMAGE_KEY") or os.getenv("AZURE_OPENAI_API_KEY")
    if api_key:
        return {"api-key": api_key, "Content-Type": "application/json"}
    from azure.identity import DefaultAzureCredential
    cred = DefaultAzureCredential()
    tok = cred.get_token("https://cognitiveservices.azure.com/.default").token
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


# --------------------------------------------------------------------------
# Prompt building
# --------------------------------------------------------------------------
def build_muscle_prompt(ex: dict) -> str:
    """Build a v2-tested muscle activation prompt with strict Chinese-only labels."""
    primary = ex["primary_muscles_en"]
    secondary = ex["secondary_muscles_en"]
    labels = ex["labels_zh"]
    label_lines = []
    for zh, target_en in labels:
        label_lines.append(f'"{zh}" pointing to {target_en}')
    label_block = "; ".join(label_lines)

    return (
        f"Anatomical muscle-activation diagram of the \"{ex['name_zh']}\" "
        f"({ex['name_en']}) exercise, {ex['view_angle']}. "
        f"Person posture: {ex['posture']}. "
        f"Body rendered with semi-transparent skin so underlying muscles are "
        f"visible. Highlight in saturated red the primary working muscles: "
        f"{primary}. Highlight in orange the secondary stabilizers: "
        f"{secondary}. Other muscles in pale neutral gray. "
        f"Add small clean labels with thin black arrow leader lines "
        f"pointing from each label to its target muscle group. "
        f"The labels MUST be in simplified Chinese characters using a clean "
        f"sans-serif font. Use exactly the following labels: {label_block}. "
        f"\n\nCRITICAL CONSTRAINTS — these are non-negotiable:\n"
        f"1. ALL TEXT IN THE IMAGE MUST BE SIMPLIFIED CHINESE CHARACTERS ONLY.\n"
        f"2. ABSOLUTELY NO ENGLISH WORDS, NO LATIN LETTERS, NO PINYIN ANYWHERE "
        f"IN THE IMAGE.\n"
        f"3. NO romanization or transliteration of muscle names.\n"
        f"4. NO captions, NO subtitles, NO step-by-step text overlays.\n"
        f"5. ONLY the muscle labels listed above should appear as text.\n"
        f"\nStyle: clean medical textbook illustration, off-white background, "
        f"no facial features (head shape may be shown but no eyes/nose/mouth), "
        f"anatomically accurate proportions, no shadows on background, "
        f"no watermarks, no signature."
    )


# --------------------------------------------------------------------------
# Generation
# --------------------------------------------------------------------------
def latest_version(code: str) -> int:
    """Return the highest existing v<N> number for this exercise (0 if none)."""
    out = OUTPUT_DIR / code
    if not out.exists():
        return 0
    versions = []
    for p in out.glob("v*.png"):
        try:
            versions.append(int(p.stem[1:]))
        except ValueError:
            continue
    return max(versions) if versions else 0


def generate_one(headers: dict[str, str], ex: dict,
                 force: bool = False,
                 prompt_override: str | None = None) -> dict:
    """Generate a single exercise's image. Returns a result record."""
    code = ex["code"]
    out_dir = OUTPUT_DIR / code
    out_dir.mkdir(parents=True, exist_ok=True)

    existing = latest_version(code)
    if existing > 0 and not force:
        return {"code": code, "status": "skip", "version": existing,
                "elapsed_s": 0.0}

    prompt = prompt_override or build_muscle_prompt(ex)
    new_version = existing + 1
    out_path = out_dir / f"v{new_version}.png"
    meta_path = out_dir / f"v{new_version}.meta.json"

    body = {"prompt": prompt, "size": "1024x1024", "n": 1}

    t0 = time.time()
    try:
        with httpx.Client(timeout=600.0) as client:
            resp = client.post(ENDPOINT, headers=headers, json=body)
            elapsed = time.time() - t0
            if resp.status_code != 200:
                return {"code": code, "status": "fail",
                        "http": resp.status_code,
                        "error": resp.text[:400],
                        "elapsed_s": elapsed,
                        "version": new_version}
            data = resp.json()
            item = (data.get("data") or [{}])[0]
            if "b64_json" in item:
                out_path.write_bytes(base64.b64decode(item["b64_json"]))
            elif "url" in item:
                r = client.get(item["url"], timeout=180.0)
                r.raise_for_status()
                out_path.write_bytes(r.content)
            else:
                return {"code": code, "status": "fail",
                        "error": f"unknown payload: {list(item)}",
                        "elapsed_s": elapsed,
                        "version": new_version}
    except Exception as e:
        return {"code": code, "status": "error",
                "error": str(e),
                "elapsed_s": time.time() - t0,
                "version": new_version}

    meta = {
        "code": code,
        "name_zh": ex["name_zh"],
        "version": new_version,
        "prompt": prompt,
        "elapsed_s": elapsed,
        "generated_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "deployment": DEPLOYMENT,
    }
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False),
                         encoding="utf-8")

    return {"code": code, "status": "ok", "version": new_version,
            "elapsed_s": elapsed, "path": str(out_path)}


# --------------------------------------------------------------------------
# Progress persistence
# --------------------------------------------------------------------------
def load_progress() -> dict:
    if PROGRESS_PATH.exists():
        return json.loads(PROGRESS_PATH.read_text(encoding="utf-8"))
    return {"runs": [], "by_code": {}}


def save_progress(progress: dict) -> None:
    PROGRESS_PATH.parent.mkdir(parents=True, exist_ok=True)
    PROGRESS_PATH.write_text(
        json.dumps(progress, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--workers", type=int, default=4,
                   help="parallel generation workers (gpt-image-2 has 12 RPM)")
    p.add_argument("--only", type=str, default=None,
                   help="comma-separated T-codes to run (subset)")
    p.add_argument("--force", type=str, default=None,
                   help="comma-separated T-codes to force regen (writes new vN)")
    p.add_argument("--exercises-path", type=str, default=str(EXERCISES_PATH))
    args = p.parse_args()

    if not Path(args.exercises_path).exists():
        sys.exit(f"[fatal] exercises file not found: {args.exercises_path}")
    exercises = json.loads(
        Path(args.exercises_path).read_text(encoding="utf-8")
    )["exercises"]

    only = set(args.only.split(",")) if args.only else None
    force = set(args.force.split(",")) if args.force else set()

    if only:
        exercises = [e for e in exercises if e["code"] in only]
        if not exercises:
            sys.exit(f"[fatal] no exercises matched --only filter: {only}")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    progress = load_progress()
    headers = get_auth_headers()

    print(f"[plan] {len(exercises)} exercises, deployment={DEPLOYMENT}, "
          f"workers={args.workers}")
    if force:
        print(f"[plan] force regen: {sorted(force)}")
    started = time.time()

    results: list[dict] = []
    with ThreadPoolExecutor(max_workers=args.workers) as ex_pool:
        futs = {
            ex_pool.submit(generate_one, headers, ex, ex["code"] in force): ex["code"]
            for ex in exercises
        }
        for fut in as_completed(futs):
            code = futs[fut]
            try:
                res = fut.result()
            except Exception as e:
                res = {"code": code, "status": "error", "error": str(e),
                       "elapsed_s": 0.0}
            results.append(res)
            tag = res["status"]
            ver = res.get("version", "")
            tail = f"v{ver}" if ver else ""
            elapsed = res.get("elapsed_s", 0.0)
            print(f"[{tag}] {code} {tail}  {elapsed:.0f}s")
            if tag in ("fail", "error"):
                err = res.get("error", "")[:200]
                print(f"    -> {err}")

    # Update progress
    run_record = {
        "started_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ",
                                         time.gmtime(started)),
        "completed_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "deployment": DEPLOYMENT,
        "wall_clock_s": round(time.time() - started, 1),
        "force": sorted(force),
        "only": sorted(only) if only else None,
        "results": results,
    }
    progress["runs"].append(run_record)
    for r in results:
        progress["by_code"][r["code"]] = {
            "latest_version": r.get("version") or progress["by_code"].get(
                r["code"], {}).get("latest_version"),
            "last_status": r["status"],
            "last_run_utc": run_record["completed_at_utc"],
        }
    save_progress(progress)

    new_ok = sum(1 for r in results if r["status"] == "ok")
    skipped = sum(1 for r in results if r["status"] == "skip")
    failed = sum(1 for r in results
                 if r["status"] in ("fail", "error"))

    print()
    print("=== summary ===")
    print(f"new:    {new_ok}")
    print(f"skip:   {skipped}")
    print(f"failed: {failed}")
    print(f"wall-clock: {time.time() - started:.0f}s")
    print(f"output:    {OUTPUT_DIR.resolve()}")
    print(f"progress:  {PROGRESS_PATH.resolve()}")


if __name__ == "__main__":
    main()
