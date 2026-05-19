"""One-shot backfill: compute route thumbnail JSON for existing activities.

Designed for the post-deploy migration of pre-thumbnail data:
    1. `_migrate` adds the `route_thumb_json` column with NULL.
    2. The next sync of any individual activity calls `compute_route_thumbnail`
       via `upsert_activity` — but un-resynced rows stay NULL forever.
    3. This script scans every user DB for rows with NULL `route_thumb_json`
       AND non-trivial GPS in `timeseries`, computes the polyline once, and
       writes it back.

Run from a logged-in az session (so AKV / Key Vault calls work) or against
local DBs directly. Idempotent — re-running only touches rows still NULL.

Usage::

    PYTHONIOENCODING=utf-8 python scripts/backfill_route_thumbnails.py [--user UUID] [--force]

Without --user, walks every `data/<uuid>/coros.db`. With --user, restricts
to one user (UUID or slug from data/.slug_aliases.json).

By default the script only fills NULL thumbnails. Pass --force after changing
the thumbnail algorithm to regenerate existing, possibly stale thumbnails.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from stride_core.db import Database, compute_route_thumbnail  # noqa: E402

DATA_DIR = PROJECT_ROOT / "data"


def _resolve_user(user_arg: str) -> str:
    """Accept UUID directly, or slug → UUID via .slug_aliases.json."""
    aliases_path = DATA_DIR / ".slug_aliases.json"
    if aliases_path.exists():
        aliases = json.loads(aliases_path.read_text(encoding="utf-8"))
        if user_arg in aliases:
            return aliases[user_arg]
    return user_arg


def _backfill_one(db_path: Path, *, force: bool = False) -> tuple[int, int, int]:
    """Returns (touched, skipped_no_gps, skipped_already_done)."""
    db = Database(db_path=db_path)
    try:
        if force:
            rows = db._conn.execute("SELECT label_id FROM activities").fetchall()
        else:
            # Activities still missing a thumbnail.
            rows = db._conn.execute(
                "SELECT label_id FROM activities WHERE route_thumb_json IS NULL"
            ).fetchall()
        if not rows:
            return (0, 0, 0)

        touched = 0
        skipped_no_gps = 0
        for r in rows:
            label_id = r["label_id"]
            ts_rows = db._conn.execute(
                """SELECT gps_lat, gps_lon
                   FROM timeseries
                   WHERE label_id = ? AND gps_lat IS NOT NULL
                   ORDER BY rowid""",
                (label_id,),
            ).fetchall()
            if not ts_rows:
                skipped_no_gps += 1
                continue
            ts_dicts = [dict(t) for t in ts_rows]
            thumb = compute_route_thumbnail(ts_dicts)
            if thumb is None:
                skipped_no_gps += 1
                continue
            db._conn.execute(
                "UPDATE activities SET route_thumb_json = ? WHERE label_id = ?",
                (thumb, label_id),
            )
            touched += 1
        db._conn.commit()
        return (touched, skipped_no_gps, 0)
    finally:
        db.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user", help="UUID or slug; default = walk every user")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Regenerate route thumbnails even when route_thumb_json is already populated",
    )
    args = parser.parse_args()

    if args.user:
        uid = _resolve_user(args.user)
        targets = [DATA_DIR / uid]
    else:
        targets = sorted(p for p in DATA_DIR.iterdir() if p.is_dir() and not p.name.startswith("."))

    grand_total = 0
    for user_dir in targets:
        db_path = user_dir / "coros.db"
        if not db_path.exists():
            continue
        try:
            touched, no_gps, _ = _backfill_one(db_path, force=args.force)
        except Exception as exc:  # noqa: BLE001
            print(f"[{user_dir.name}] FAILED: {exc}")
            continue
        if touched or no_gps:
            print(f"[{user_dir.name}] thumbnails written: {touched}; skipped (no GPS): {no_gps}")
            grand_total += touched
    print(f"\nDone. {grand_total} thumbnails written across {len(targets)} user(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
