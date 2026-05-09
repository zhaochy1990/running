"""Backfill vo2max_pb from existing activities (v7 Step 3).

The PB-memory channel was added in v7 to give compute_l3_vo2max a stable
floor on the rolling-window estimate. Because the table is only written
by ability_hook on *new* sync, existing DBs need a one-time backfill to
populate PBs from historical race-quality activities.

Usage:
    PYTHONIOENCODING=utf-8 python scripts/backfill_vo2max_pbs.py -P zhaochaoyi
    PYTHONIOENCODING=utf-8 python scripts/backfill_vo2max_pbs.py -P dehua --dry-run

The script walks every running activity, classifies it via
``stride_core.ability.compute_pb_vdot_for_activity`` (which applies the
Step 2 well-paced gate for marathons), and upserts each candidate. The
upsert keeps only the highest VDOT per race_type, so re-running is
idempotent. The Step 2 well-paced gate also handles per-activity
filtering, so passing a year of mixed quality activities through is
safe — DNF marathons won't enroll.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# Allow running as `python scripts/backfill_vo2max_pbs.py` from repo root,
# AND as `python /app/scripts/backfill_vo2max_pbs.py` inside the container
# (where /app/src is on PYTHONPATH already but adding it again is harmless).
ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from stride_core.ability import (  # noqa: E402
    classify_race_type,
    compute_pb_vdot_for_activity,
)
from stride_core.db import USER_DATA_DIR, Database  # noqa: E402
from stride_core.models import RUN_SPORT_IDS  # noqa: E402


_UUID4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _resolve_profile(profile: str) -> str:
    """Resolve a slug like ``zhaochaoyi`` to its UUID via
    ``data/.slug_aliases.json``. Mirrors ``coros_sync.cli._resolve_profile``
    so the backfill script can take a friendly slug like the CLI does.

    The original Database(user=...) constructor uses the string as-is,
    so without resolution a slug points at a directory that doesn't
    exist and we silently create / open an empty DB. This is what bit
    the first prod backfill attempt — Database(user='zhaochaoyi') went
    to /app/data/zhaochaoyi/ instead of /app/data/{uuid}/.
    """
    if _UUID4_RE.match(profile):
        return profile
    aliases_file = USER_DATA_DIR / ".slug_aliases.json"
    if aliases_file.exists():
        try:
            aliases = json.loads(aliases_file.read_text(encoding="utf-8"))
            if profile in aliases:
                return aliases[profile]
        except Exception:
            pass
    return profile


def _load_full_activity(conn, label_id: str) -> dict | None:
    """Load activity + laps for the well-paced check."""
    row = conn.execute(
        "SELECT label_id, sport_type, train_type, distance_m, duration_s, "
        "avg_pace_s_km, date FROM activities WHERE label_id = ?",
        (label_id,),
    ).fetchone()
    if row is None:
        return None
    d = dict(row)
    d["laps"] = [
        dict(x) for x in conn.execute(
            "SELECT lap_index, distance_m, duration_s, avg_pace, exercise_type "
            "FROM laps WHERE label_id = ? ORDER BY lap_index",
            (label_id,),
        ).fetchall()
    ]
    return d


def backfill(db: Database, dry_run: bool = False) -> dict[str, int]:
    """Walk all running activities; upsert PBs.

    Returns a per-race_type count dict including ``"considered"`` (total
    candidates passing classification) and ``"written"`` (rows actually
    upserted — fewer when an activity loses to an existing higher VDOT).
    """
    conn = db._conn
    sports = ",".join(str(s) for s in RUN_SPORT_IDS)
    rows = conn.execute(
        f"SELECT label_id FROM activities WHERE sport_type IN ({sports}) "
        "ORDER BY date"
    ).fetchall()

    stats = {
        "considered": 0,
        "written": 0,
        "by_race_type": {},
    }
    for r in rows:
        label_id = r["label_id"]
        activity = _load_full_activity(conn, label_id)
        if activity is None:
            continue
        # Cheap pre-filter so we don't hammer the helper for every activity.
        if classify_race_type(activity.get("distance_m") or 0) is None:
            # Provider distance might be in km units (legacy COROS); the
            # helper normalizes via _distance_to_meters internally so try
            # there too — but only for distances close to a race target,
            # to keep the loop fast.
            d_raw = float(activity.get("distance_m") or 0)
            if not (4.0 <= d_raw <= 50.0):  # km-units window for any race
                continue
        pb = compute_pb_vdot_for_activity(activity)
        if pb is None:
            continue
        race_type, vdot = pb
        stats["considered"] += 1
        if dry_run:
            stats["by_race_type"].setdefault(race_type, 0)
            stats["by_race_type"][race_type] += 1
            print(
                f"  [dry-run] {race_type}: {label_id} "
                f"vdot={vdot:.2f} dist={activity.get('distance_m')} "
                f"dur={activity.get('duration_s')}"
            )
            continue
        wrote = db.upsert_vo2max_pb(
            race_type=race_type,
            distance_m=float(activity.get("distance_m") or 0),
            duration_s=float(activity.get("duration_s") or 0),
            vdot=float(vdot),
            pb_date=str(activity.get("date") or "")[:10],
            label_id=str(label_id),
            even_paced=True,
        )
        if wrote:
            stats["written"] += 1
            stats["by_race_type"].setdefault(race_type, 0)
            stats["by_race_type"][race_type] += 1
    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-P", "--profile", required=True,
                        help="user slug or UUID under data/")
    parser.add_argument("--dry-run", action="store_true",
                        help="enumerate candidates without writing")
    args = parser.parse_args()

    user_id = _resolve_profile(args.profile)
    if user_id != args.profile:
        print(f"[resolved] {args.profile} -> {user_id}")
    db = Database(user=user_id)
    try:
        stats = backfill(db, dry_run=args.dry_run)
    finally:
        db.close()

    mode = "DRY-RUN" if args.dry_run else "wrote"
    print(f"\n[{mode}] considered={stats['considered']} written={stats['written']}")
    for rt, n in stats["by_race_type"].items():
        print(f"  {rt}: {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
