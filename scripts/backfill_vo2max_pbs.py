"""Backfill vo2max_pb history from existing activities via segment scan.

Walks every running activity chronologically, runs the same segment-scan
logic as the post-sync hook on each, and upserts every qualifying
(race_type, source_activity) row into ``vo2max_pb``. Each activity can
contribute up to four rows (5K / 10K / half / full) — the fastest
continuous non-paused segment for each canonical race distance present
in the activity. The L3 reader later picks the current best per
race_type, so re-running is idempotent (existing rows only update when
the recomputed VDOT is strictly higher).

Usage:
    PYTHONIOENCODING=utf-8 python scripts/backfill_vo2max_pbs.py -P zhaochaoyi
    PYTHONIOENCODING=utf-8 python scripts/backfill_vo2max_pbs.py -P dehua --dry-run
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# Allow running as `python scripts/backfill_vo2max_pbs.py` from the repo root
# AND as `python /app/scripts/backfill_vo2max_pbs.py` inside the container
# (where /app/src is already on PYTHONPATH but re-adding is harmless).
ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from stride_core.ability import compute_pb_vdot_for_segment  # noqa: E402
from stride_core.ability_hook import (  # noqa: E402
    CANONICAL_RACE_DISTANCES,
    _normalize_ts_units,
    _parse_pauses,
)
from stride_core.db import USER_DATA_DIR
from stride_storage.sqlite.database import Database  # noqa: E402
from stride_core.models import RUN_SPORT_IDS  # noqa: E402
from stride_core.running_calibration.segments import (  # noqa: E402
    best_distance_candidates,
)
from stride_core.timefmt import utc_iso_to_shanghai_iso  # noqa: E402


_UUID4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _resolve_profile(profile: str) -> str:
    """Resolve a slug like ``zhaochaoyi`` to its UUID via
    ``data/.slug_aliases.json``. Mirrors ``coros_sync.cli._resolve_profile``
    so the backfill script can take a friendly slug like the CLI does.

    The Database(user=...) constructor uses the string as-is, so without
    resolution a slug points at a directory that doesn't exist and we
    silently create / open an empty DB.
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


def backfill(db: Database, *, dry_run: bool = False) -> dict[str, int]:
    """Walk every running activity, segment-scan, upsert PB rows.

    Returns ``{"scanned": N_with_candidates, "written": N_rows_written,
    "by_race_type": {rt: count}}``.  ``scanned`` counts activities that
    produced at least one canonical-distance candidate; ``written`` is
    the rowcount actually upserted (will be lower than the number of
    candidates when an existing PB row for the same (race_type,
    label_id) already holds a higher VDOT).
    """
    db._migrate_vo2max_pb_to_v2()  # idempotent — safe on fresh DBs.

    placeholders = ",".join("?" * len(RUN_SPORT_IDS))
    rows = list(db._conn.execute(
        f"SELECT label_id, sport_type, date, pauses FROM activities "
        f"WHERE sport_type IN ({placeholders}) ORDER BY date ASC",
        tuple(RUN_SPORT_IDS),
    ))

    stats: dict[str, int] = {"scanned": 0, "written": 0}
    by_rt: dict[str, int] = {}

    for row in rows:
        label_id = row["label_id"]
        ts_rows = db.fetch_timeseries(label_id)
        if not ts_rows or len(ts_rows) < 2:
            continue
        ts_norm = _normalize_ts_units(ts_rows)
        if len(ts_norm) < 2:
            continue
        t0_tick = ts_rows[0]["timestamp"]
        pauses_s = _parse_pauses(row["pauses"], t0=t0_tick)

        candidates = best_distance_candidates(
            ts_norm, pauses_s, CANONICAL_RACE_DISTANCES,
        )
        if not candidates:
            continue
        stats["scanned"] += 1

        pb_date = (utc_iso_to_shanghai_iso(row["date"]) or "")[:10]

        for race_type, cand in candidates.items():
            vdot = compute_pb_vdot_for_segment(
                race_type, cand.distance_m, cand.duration_s,
            )
            if vdot is None:
                continue
            if dry_run:
                mins = int(cand.duration_s // 60)
                secs = cand.duration_s - mins * 60
                print(
                    f"  [dry-run] {pb_date} {label_id} {race_type:<5} "
                    f"{mins}:{secs:05.2f}  vdot={vdot:.2f}"
                )
                by_rt[race_type] = by_rt.get(race_type, 0) + 1
                continue
            wrote = db.upsert_vo2max_pb(
                race_type=race_type,
                distance_m=cand.distance_m,
                duration_s=cand.duration_s,
                vdot=float(vdot),
                pb_date=pb_date,
                label_id=str(label_id),
                even_paced=True,
            )
            if wrote:
                stats["written"] += 1
                by_rt[race_type] = by_rt.get(race_type, 0) + 1

    stats["by_race_type"] = by_rt  # type: ignore[assignment]
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
    print(
        f"\n[{mode}] scanned={stats['scanned']} written={stats['written']}"
    )
    for rt, n in (stats.get("by_race_type") or {}).items():  # type: ignore[union-attr]
        print(f"  {rt}: {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
