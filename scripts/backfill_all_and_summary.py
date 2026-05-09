"""Backfill vo2max_pb for every known user + recompute today's snapshot.

For each slug in data/.slug_aliases.json:
  1. Run the backfill (idempotent — skipped if PB table already populated).
  2. Compute today's ability_snapshot via compute_ability_snapshot, which
     reads the freshly-backfilled PB table and produces v7-correct numbers.
  3. Persist the L4 / VO2max delta so the dashboard shows the v7 number
     immediately (ability_hook normally does this on sync).
  4. Print a one-line summary per user: primary / secondary / floor /
     PB-decayed / used / source / score / marathon estimate.

Run via:
    az containerapp exec --name stride-app --resource-group rg-running-prod \
      --command "python /app/scripts/backfill_all_and_summary.py"
"""
from __future__ import annotations
import json, sys, traceback
from datetime import date, timedelta, timezone, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from stride_core.db import USER_DATA_DIR, Database
from stride_core.models import RUN_SPORT_IDS
from stride_core.ability import (
    ABILITY_MODEL_VERSION,
    L4_WEIGHTS,
    classify_race_type,
    compute_ability_snapshot,
    compute_pb_vdot_for_activity,
)


def _load_aliases() -> dict[str, str]:
    af = USER_DATA_DIR / ".slug_aliases.json"
    if not af.exists():
        return {}
    return json.loads(af.read_text(encoding="utf-8"))


def backfill(db: Database) -> dict:
    """Walk every running activity, upsert PBs. Returns {race_type: count}."""
    sports = ",".join(str(s) for s in RUN_SPORT_IDS)
    rows = db._conn.execute(
        f"SELECT label_id, sport_type, train_type, distance_m, duration_s, "
        f"avg_pace_s_km, date FROM activities WHERE sport_type IN ({sports}) "
        f"ORDER BY date"
    ).fetchall()
    counts: dict[str, int] = {}
    written = 0
    for r in rows:
        activity = dict(r)
        d_raw = float(activity.get("distance_m") or 0)
        if classify_race_type(d_raw) is None and not (4.0 <= d_raw <= 50.0):
            continue
        activity["laps"] = [
            dict(x) for x in db._conn.execute(
                "SELECT lap_index, distance_m, duration_s, avg_pace, exercise_type "
                "FROM laps WHERE label_id = ? ORDER BY lap_index",
                (activity["label_id"],),
            ).fetchall()
        ]
        pb = compute_pb_vdot_for_activity(activity)
        if pb is None:
            continue
        race_type, vdot = pb
        if db.upsert_vo2max_pb(
            race_type=race_type,
            distance_m=float(activity.get("distance_m") or 0),
            duration_s=float(activity.get("duration_s") or 0),
            vdot=float(vdot),
            pb_date=str(activity.get("date") or "")[:10],
            label_id=str(activity["label_id"]),
            even_paced=True,
        ):
            written += 1
            counts[race_type] = counts.get(race_type, 0) + 1
    counts["_written"] = written
    return counts


def persist_snapshot(db: Database, snapshot: dict, today_iso: str) -> None:
    """Mirror ability_hook's persistence so the dashboard sees v7 numbers
    without waiting for the next sync."""
    try:
        db.upsert_ability_snapshot(
            date=today_iso, level="meta", dimension="model_version",
            value=float(ABILITY_MODEL_VERSION),
        )
        l2 = snapshot.get("l2_freshness") or {}
        if l2.get("total") is not None:
            db.upsert_ability_snapshot(
                date=today_iso, level="L2", dimension="total",
                value=l2.get("total"),
            )
        for dim in L4_WEIGHTS.keys():
            d = (snapshot.get("l3_dimensions") or {}).get(dim) or {}
            db.upsert_ability_snapshot(
                date=today_iso, level="L3", dimension=dim,
                value=d.get("score"),
                evidence_activity_ids=d.get("evidence"),
            )
        db.upsert_ability_snapshot(
            date=today_iso, level="L4", dimension="composite",
            value=snapshot.get("l4_composite"),
            evidence_activity_ids=snapshot.get("evidence_activity_ids"),
        )
        estimates = snapshot.get("marathon_estimates") or {}
        for dim_name, key in (
            ("marathon_training_s", "training_s"),
            ("marathon_race_s",     "race_s"),
            ("marathon_best_case_s", "best_case_s"),
        ):
            val = estimates.get(key)
            if val is not None:
                db.upsert_ability_snapshot(
                    date=today_iso, level="L4", dimension=dim_name,
                    value=float(val),
                )
    except Exception as e:
        print(f"  (persist failed: {e})")


def fmt_marathon(s: int | None) -> str:
    if not s or s <= 0:
        return "n/a"
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}"


def main() -> int:
    today_iso = (datetime.now(timezone.utc) + timedelta(hours=8)).strftime("%Y-%m-%d")
    aliases = _load_aliases()
    print(f"=== Backfill for {len(aliases)} users (today_iso={today_iso}, model_version={ABILITY_MODEL_VERSION}) ===\n")

    for slug, uuid in sorted(aliases.items()):
        print(f"--- {slug} ({uuid}) ---")
        try:
            db = Database(user=uuid)
        except Exception as e:
            print(f"  open DB failed: {e}\n")
            continue
        try:
            counts = backfill(db)
            written = counts.pop("_written", 0)
            cstr = " ".join(f"{k}:{v}" for k, v in sorted(counts.items())) or "(none)"
            print(f"  PB written: {written}  by_type: {cstr}")

            snapshot = compute_ability_snapshot(db, date=today_iso)
            persist_snapshot(db, snapshot, today_iso)
            v = (snapshot.get("l3_dimensions") or {}).get("vo2max") or {}
            l4 = snapshot.get("l4_composite")
            mar = snapshot.get("l4_marathon_estimate_s")
            print(
                f"  vo2max: score={v.get('score')} primary={v.get('vo2max_primary')} "
                f"secondary={v.get('vo2max_secondary')} floor={v.get('vo2max_floor')} "
                f"pb_decayed={v.get('vo2max_pb_decayed')} used={v.get('vo2max_used')} "
                f"source={v.get('vo2max_source')!r}"
            )
            print(f"  L4: {l4}  marathon: {fmt_marathon(mar)}")
        except Exception as e:
            print(f"  ERROR: {e}")
            traceback.print_exc()
        finally:
            db.close()
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
