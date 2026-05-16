"""Migrate per-user data/{uuid}/profile.json from legacy Chinese keys to English schema.

Idempotent: re-running on already-migrated profiles is a no-op (no .bak rewrite).
Preserves unrecognized keys verbatim (extras like 手表, 职业, 训练提示, 最近赛事).
Creates .bak alongside profile.json before overwriting.

Usage:
    python scripts/migrate_profile_to_english_keys.py [--dry-run] [--data-dir PATH]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# Direct one-to-one key renames.
KEY_MAP: dict[str, str] = {
    "姓名": "display_name",
    "出生": "dob",
    "身高_cm": "height_cm",
    "体重_kg": "weight_kg",
    "当前体重_kg": "weight_kg",
    "目标": "target_race",
    "目标赛事日期": "target_race_date",
    "已知问题": "constraints",
    "伤病史": "constraints",
}

# Personal-best renames — collected into the `pbs` dict.
PB_MAP: dict[str, str] = {
    "PB 马拉松": "FM",
    "PB 半马": "HM",
    "PB 10K": "10K",
    "PB 5K": "5K",
}

TARGET_TIME_RE = re.compile(r"(?<!\d)(\d{1,2}):(\d{2})(?::(\d{2}))?(?!\d)")
DATE_PREFIX_RE = re.compile(r"^(\d{4}-\d{2}(?:-\d{2})?)")


def migrate_profile(data: dict) -> dict:
    out: dict = {}
    pbs: dict[str, str] = {}

    for key, value in data.items():
        if key in KEY_MAP:
            out[KEY_MAP[key]] = value
        elif key in PB_MAP:
            pbs[PB_MAP[key]] = value
        else:
            out[key] = value  # preserve unrecognized

    goal = out.get("target_race")
    if isinstance(goal, str):
        upper = goal.upper()
        if "target_distance" not in out:
            if "马拉松" in goal or "FM" in upper:
                out["target_distance"] = "FM"
            elif "半马" in goal or "HM" in upper:
                out["target_distance"] = "HM"
            elif "10K" in upper or "10公里" in goal:
                out["target_distance"] = "10K"
            elif "5K" in upper or "5公里" in goal:
                out["target_distance"] = "5K"

        if "target_time" not in out:
            m = TARGET_TIME_RE.search(goal)
            if m:
                h, mm, ss = m.groups()
                out["target_time"] = f"{int(h)}:{mm}:{ss or '00'}"

        if "target_race_date" not in out:
            m = DATE_PREFIX_RE.match(goal.strip())
            if m:
                d = m.group(1)
                if len(d) == 7:  # "2026-10" → "2026-10-01"
                    d += "-01"
                out["target_race_date"] = d

    if isinstance(out.get("pbs"), dict):
        merged_pbs = dict(out["pbs"])
        merged_pbs.update(pbs)
        if merged_pbs:
            out["pbs"] = merged_pbs
    elif pbs:
        out["pbs"] = pbs

    return out


def diff_keys(before: dict, after: dict) -> tuple[list[str], list[str]]:
    b, a = set(before.keys()), set(after.keys())
    return sorted(b - a), sorted(a - b)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Show changes without writing")
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "data",
        help="Path to the per-user data root (default: <repo>/data)",
    )
    args = parser.parse_args()

    profiles = sorted(args.data_dir.glob("*/profile.json"))
    if not profiles:
        print(f"No profile.json files under {args.data_dir}")
        return 0

    print(f"Scanning {len(profiles)} profile.json file(s) under {args.data_dir}")
    migrated = 0
    for path in profiles:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            print(f"  SKIP  {path.parent.name}: {exc}")
            continue
        if not isinstance(data, dict):
            print(f"  SKIP  {path.parent.name}: non-object root")
            continue

        new_data = migrate_profile(data)
        removed, added = diff_keys(data, new_data)
        if not removed and not added:
            print(f"  noop  {path.parent.name}: already in English keys")
            continue

        if args.dry_run:
            print(f"  DRY   {path.parent.name}: -{removed} +{added}")
            continue

        backup = path.with_suffix(".json.bak")
        if not backup.exists():
            backup.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
        path.write_text(
            json.dumps(new_data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        migrated += 1
        print(f"  OK    {path.parent.name}: -{removed} +{added} (backup: {backup.name})")

    print(f"\n{'(dry-run) ' if args.dry_run else ''}Migrated {migrated} profile(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
