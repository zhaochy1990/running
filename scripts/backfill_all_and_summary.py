"""Backfill vo2max_pb for every known user + recompute today's snapshot.

For each slug in data/.slug_aliases.json (plus any UUID-named dir on disk
that lacks a slug entry):

  1. Run the segment-scan PB backfill (idempotent — re-running only
     bumps rows whose VDOT recomputes higher). Each (race_type,
     source_activity) pair gets its own row, mirroring the post-sync
     hook.
  2. Compute today's ability_snapshot via ``compute_ability_snapshot``,
     which reads the freshly-backfilled PB table and produces v8-correct
     numbers.
  3. Persist the L4 / VO2max snapshot so the dashboard shows the new
     numbers immediately (ability_hook normally does this on sync).
  4. Print a one-line summary per user: primary / secondary / floor /
     PB-decayed / used / source + L4 composite + marathon estimate.

Run via:
    az containerapp exec --name stride-app --resource-group rg-running-prod \
      --command "python /app/scripts/backfill_all_and_summary.py"

Add ``--dry-run`` to enumerate candidates without writing PB rows or
ability snapshots (useful for prod inspection before pulling the
trigger).
"""
from __future__ import annotations
import argparse
import json
import sys
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from stride_core.ability import (  # noqa: E402
    ABILITY_MODEL_VERSION,
    L4_WEIGHTS,
    compute_ability_snapshot,
    compute_pb_vdot_for_segment,
)
from stride_core.ability_hook import (  # noqa: E402
    CANONICAL_RACE_DISTANCES,
    _normalize_ts_units,
    _parse_pauses,
)
from stride_core.db import USER_DATA_DIR, Database  # noqa: E402
from stride_core.models import RUN_SPORT_IDS  # noqa: E402
from stride_core.running_calibration.segments import (  # noqa: E402
    best_distance_candidates,
)
from stride_core.timefmt import utc_iso_to_shanghai_iso  # noqa: E402


_UUID4_NAME_RE = __import__("re").compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    __import__("re").IGNORECASE,
)


def _load_aliases() -> dict[str, str]:
    """Resolve every user that has data on disk.

    Reads ``data/.slug_aliases.json`` for the friendly-slug → UUID mapping,
    then ALSO walks ``data/`` and adds any UUID-shaped directory that has a
    ``coros.db`` file but no slug pointing at it. Prod's slug_aliases.json
    can be stale (it lives on Azure Files and isn't synced by
    ``sync-data.yml``), so without this fallback the backfill skips users
    that exist on disk but don't have a slug.
    """
    af = USER_DATA_DIR / ".slug_aliases.json"
    aliases: dict[str, str] = {}
    if af.exists():
        try:
            aliases = json.loads(af.read_text(encoding="utf-8"))
        except Exception:
            aliases = {}
    known_uuids = set(aliases.values())
    if USER_DATA_DIR.exists():
        for entry in USER_DATA_DIR.iterdir():
            if not entry.is_dir():
                continue
            name = entry.name
            if not _UUID4_NAME_RE.match(name):
                continue
            if name in known_uuids:
                continue
            if (entry / "coros.db").exists():
                # No slug for this UUID — register under the UUID itself.
                aliases[name] = name
                known_uuids.add(name)
    return aliases


def backfill(db: Database, *, dry_run: bool = False) -> dict:
    """Segment-scan every running activity, upsert PB rows.

    Returns ``{race_type: count, "_written": total_rows, "_scanned":
    activities_with_candidates}``. On ``dry_run=True`` no rows are
    written but the by-race-type counter still tracks candidates so the
    summary line is informative.
    """
    db._migrate_vo2max_pb_to_v2()  # idempotent — safe on fresh DBs.

    placeholders = ",".join("?" * len(RUN_SPORT_IDS))
    rows = list(db._conn.execute(
        f"SELECT label_id, sport_type, date, pauses FROM activities "
        f"WHERE sport_type IN ({placeholders}) ORDER BY date ASC",
        tuple(RUN_SPORT_IDS),
    ))

    counts: dict[str, int] = {}
    written = 0
    scanned = 0

    for r in rows:
        label_id = r["label_id"]
        ts_rows = db.fetch_timeseries(label_id)
        if not ts_rows or len(ts_rows) < 2:
            continue
        ts_norm = _normalize_ts_units(ts_rows)
        if len(ts_norm) < 2:
            continue
        t0_tick = ts_rows[0]["timestamp"]
        pauses_s = _parse_pauses(r["pauses"], t0=t0_tick)

        candidates = best_distance_candidates(
            ts_norm, pauses_s, CANONICAL_RACE_DISTANCES,
        )
        if not candidates:
            continue
        scanned += 1

        pb_date = (utc_iso_to_shanghai_iso(r["date"]) or "")[:10]

        for race_type, cand in candidates.items():
            vdot = compute_pb_vdot_for_segment(
                race_type, cand.distance_m, cand.duration_s,
            )
            if vdot is None:
                continue
            if dry_run:
                counts[race_type] = counts.get(race_type, 0) + 1
                continue
            if db.upsert_vo2max_pb(
                race_type=race_type,
                distance_m=cand.distance_m,
                duration_s=cand.duration_s,
                vdot=float(vdot),
                pb_date=pb_date,
                label_id=str(label_id),
                even_paced=True,
            ):
                written += 1
                counts[race_type] = counts.get(race_type, 0) + 1

    counts["_written"] = written
    counts["_scanned"] = scanned
    return counts


def persist_snapshot(db: Database, snapshot: dict, today_iso: str) -> None:
    """Mirror ability_hook's persistence so the dashboard sees fresh
    numbers without waiting for the next sync."""
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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="enumerate candidates per user without "
                             "writing PB rows or ability snapshots")
    args = parser.parse_args()

    today_iso = (datetime.now(timezone.utc) + timedelta(hours=8)).strftime("%Y-%m-%d")
    aliases = _load_aliases()
    mode = "DRY-RUN" if args.dry_run else "WRITE"
    print(
        f"=== Backfill [{mode}] for {len(aliases)} users "
        f"(today_iso={today_iso}, model_version={ABILITY_MODEL_VERSION}) ===\n"
    )

    for slug, uuid in sorted(aliases.items()):
        print(f"--- {slug} ({uuid}) ---")
        try:
            db = Database(user=uuid)
        except Exception as e:
            print(f"  open DB failed: {e}\n")
            continue
        try:
            counts = backfill(db, dry_run=args.dry_run)
            written = counts.pop("_written", 0)
            scanned = counts.pop("_scanned", 0)
            cstr = " ".join(f"{k}:{v}" for k, v in sorted(counts.items())) or "(none)"
            print(
                f"  PB scanned: {scanned}  written: {written}  "
                f"by_type: {cstr}"
            )

            if args.dry_run:
                # Don't compute / persist snapshots in dry-run mode —
                # we'd be reading a stale PB table and the numbers
                # would mislead.
                print()
                continue

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
