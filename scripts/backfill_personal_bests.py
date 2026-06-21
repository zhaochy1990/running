"""Backfill the ``personal_bests`` table from existing activities.

The ``personal_bests`` table is populated post-sync going forward, but existing
users won't have a row until their next sync. This script runs the segment-scan
PB detector once per user and persists the result, so the /pbs route, coach
get_pbs tool, and master-plan generator can read the table immediately (instead
of self-healing with a ~7s live scan on first access).

Idempotent: re-running only refreshes rows (ON CONFLICT upsert); a PB never
regresses because detect_personal_bests keeps the best-so-far.

Usage:
    # one user (slug or UUID)
    PYTHONIOENCODING=utf-8 python scripts/backfill_personal_bests.py -P zhaochaoyi

    # every user with data on disk
    PYTHONIOENCODING=utf-8 python scripts/backfill_personal_bests.py --all

    # prod (Azure Container App)
    az containerapp exec --name stride-app --resource-group rg-running-prod \
      --command "python /app/scripts/backfill_personal_bests.py --all"
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from stride_core.db import USER_DATA_DIR, Database  # noqa: E402
from stride_core.pb_records import persist_personal_bests  # noqa: E402

_UUID4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _resolve_profile(profile: str) -> str:
    """Resolve a friendly slug to its UUID via ``data/.slug_aliases.json``."""
    if _UUID4_RE.match(profile):
        return profile
    aliases_file = USER_DATA_DIR / ".slug_aliases.json"
    if aliases_file.exists():
        try:
            aliases = json.loads(aliases_file.read_text(encoding="utf-8"))
            if profile in aliases:
                return aliases[profile]
        except Exception:  # noqa: BLE001
            pass
    return profile


def _all_user_ids() -> list[str]:
    """Every UUID with data on disk (slug_aliases values + UUID dirs holding a
    coros.db, since prod's slug_aliases.json can be stale)."""
    ids: set[str] = set()
    af = USER_DATA_DIR / ".slug_aliases.json"
    if af.exists():
        try:
            ids.update(json.loads(af.read_text(encoding="utf-8")).values())
        except Exception:  # noqa: BLE001
            pass
    if USER_DATA_DIR.exists():
        for entry in USER_DATA_DIR.iterdir():
            if entry.is_dir() and _UUID4_RE.match(entry.name) and (entry / "coros.db").exists():
                ids.add(entry.name)
    return sorted(ids)


def _backfill_one(user_id: str) -> int:
    """Persist PBs for one user. Returns the number of distances written."""
    db = Database(user=user_id)
    try:
        pbs = persist_personal_bests(db)
    finally:
        db.close()
    times = "  ".join(
        f"{d}:{int(pbs[d]['pb_time_sec'])//60}:{int(pbs[d]['pb_time_sec']) % 60:02d}"
        for d in ("1K", "3K", "5K", "10K", "HM", "FM")
        if d in pbs and pbs[d].get("pb_time_sec")
    )
    print(f"  [{user_id}] {len(pbs)} PBs  {times}")
    return len(pbs)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("-P", "--profile", help="user slug or UUID under data/")
    group.add_argument("--all", action="store_true", help="every user with data on disk")
    args = parser.parse_args()

    if args.all:
        user_ids = _all_user_ids()
        print(f"Backfilling personal_bests for {len(user_ids)} user(s)...")
    else:
        resolved = _resolve_profile(args.profile)
        if resolved != args.profile:
            print(f"[resolved] {args.profile} -> {resolved}")
        user_ids = [resolved]

    total_users = 0
    total_pbs = 0
    for user_id in user_ids:
        try:
            total_pbs += _backfill_one(user_id)
            total_users += 1
        except Exception as exc:  # noqa: BLE001 — never let one user abort the sweep
            print(f"  [{user_id}] FAILED: {exc}", file=sys.stderr)

    print(f"\nDone: {total_pbs} PB rows across {total_users} user(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
