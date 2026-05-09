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
import sys
from pathlib import Path

# Allow running as `python scripts/backfill_vo2max_pbs.py` from repo root.
ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from stride_core.ability import (  # noqa: E402
    classify_race_type,
    compute_pb_vdot_for_activity,
)
from stride_core.db import Database  # noqa: E402
from stride_core.models import RUN_SPORT_IDS  # noqa: E402


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

    db = Database(user=args.profile)
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
