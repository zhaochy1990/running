"""
Generate a markdown review report for the strength illustration set.

Reads `strength_illustrations/output/<code>/v<latest>.png` and the
matching meta.json for each exercise in exercises.json, and writes
`strength_illustrations/review_report.md`.

Optionally takes a JSON file with hand-curated review notes
({code: {"verdict": "go|regen|hold", "notes": "..."}}) and merges them in.

Usage:
  python scripts/strength_illustrations_review.py
  python scripts/strength_illustrations_review.py --notes review_notes.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

DATA_DIR = Path("strength_illustrations")
EXERCISES_PATH = DATA_DIR / "exercises.json"
OUTPUT_DIR = DATA_DIR / "output"
REPORT_PATH = DATA_DIR / "review_report.md"


def latest_version_path(code: str) -> tuple[Path | None, dict | None]:
    out = OUTPUT_DIR / code
    if not out.exists():
        return None, None
    versions = []
    for p in out.glob("v*.png"):
        try:
            versions.append((int(p.stem[1:]), p))
        except ValueError:
            continue
    if not versions:
        return None, None
    versions.sort()
    n, png = versions[-1]
    meta_path = out / f"v{n}.meta.json"
    meta = (
        json.loads(meta_path.read_text(encoding="utf-8"))
        if meta_path.exists() else {}
    )
    return png, meta


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--notes", type=str, default=None,
                   help="JSON file with {code: {verdict, notes}}")
    args = p.parse_args()

    notes = {}
    if args.notes and Path(args.notes).exists():
        notes = json.loads(Path(args.notes).read_text(encoding="utf-8"))

    exercises = json.loads(EXERCISES_PATH.read_text(encoding="utf-8"))[
        "exercises"]

    lines: list[str] = []
    lines.append("# 力量训练图解 Review 报告")
    lines.append("")
    lines.append(f"动作总数: **{len(exercises)}**")
    lines.append("")
    by_status: dict[str, list[str]] = {
        "go": [], "borderline_go": [], "regen": [], "hold": [], "unknown": [],
    }
    by_cat: dict[str, list[dict]] = {}

    for ex in exercises:
        code = ex["code"]
        cat = ex["category"]
        by_cat.setdefault(cat, []).append(ex)

        png, meta = latest_version_path(code)
        verdict = notes.get(code, {}).get("verdict", "unknown")
        if verdict not in by_status:
            verdict = "unknown"
        by_status[verdict].append(code)

    lines.append("## 总览")
    lines.append("")
    lines.append(f"- ✅ go (产品级): {len(by_status['go'])}")
    lines.append(f"- 🟡 borderline_go (可用，姿态接近): {len(by_status['borderline_go'])}")
    lines.append(f"- 🔄 regen (需重抽): {len(by_status['regen'])}")
    lines.append(f"- ⏸ hold (模型能力限制): {len(by_status['hold'])}")
    lines.append(f"- ❓ unknown (未审): {len(by_status['unknown'])}")
    lines.append("")
    lines.append("---")
    lines.append("")

    for cat in sorted(by_cat):
        lines.append(f"## {cat} ({len(by_cat[cat])})")
        lines.append("")
        for ex in by_cat[cat]:
            code = ex["code"]
            png, meta = latest_version_path(code)
            note = notes.get(code, {})
            verdict = note.get("verdict", "")
            verdict_emoji = {
                "go": "✅", "borderline_go": "🟡", "regen": "🔄", "hold": "⏸",
            }.get(verdict, "❓")

            lines.append(f"### {verdict_emoji} {code} — {ex['name_zh']} "
                         f"({ex['name_en']})")
            lines.append("")
            if png and png.exists():
                # Use relative path from report location
                rel = png.relative_to(DATA_DIR).as_posix()
                lines.append(f"![{code}]({rel})")
                lines.append("")
                if meta:
                    v = meta.get("version", "?")
                    e = meta.get("elapsed_s", 0)
                    t = meta.get("generated_at_utc", "")
                    lines.append(
                        f"**版本**: v{v} · **耗时**: {e:.0f}s · **生成时间**: {t}"
                    )
                    lines.append("")
            else:
                lines.append("⚠️ 未生成")
                lines.append("")

            lines.append(f"**分类**: {ex['category']} · **视角**: "
                         f"{ex['view_angle']}")
            lines.append("")
            zh_labels = " / ".join(z for z, _ in ex["labels_zh"])
            lines.append(f"**应有标签 (中文)**: {zh_labels}")
            lines.append("")

            if note:
                if verdict:
                    lines.append(f"**判定**: {verdict_emoji} {verdict}")
                if note.get("notes"):
                    lines.append(f"**备注**: {note['notes']}")
                lines.append("")

            if meta and meta.get("prompt"):
                lines.append("<details><summary>展开 prompt</summary>")
                lines.append("")
                lines.append("```")
                lines.append(meta["prompt"])
                lines.append("```")
                lines.append("")
                lines.append("</details>")
                lines.append("")

            lines.append("---")
            lines.append("")

    REPORT_PATH.write_text("\n".join(lines), encoding="utf-8")
    print(f"[saved] {REPORT_PATH}")


if __name__ == "__main__":
    main()
