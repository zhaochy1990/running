"""Backfill Q2a completed-phase summaries into an existing local master plan.

For each ``is_completed`` phase of a user's active local plan, compute the
deterministic actual-results summary (``aggregate_phase_summary``) over the
phase's Shanghai-day window from that user's ``coros.db`` and inject it onto
the phase. Then:

  * write the updated plan back into the local store
    (``data/.master_plans.json``), and
  * rebuild the prod-push bundle
    (``scripts/migration/<short>_master_plan_bundle.json``), preserving its
    existing ``goal_store`` so the existing push flow keeps working.

This script is LOCAL-ONLY. It NEVER calls ``push_master_plan_to_prod``, never
touches Azure, and never makes ``az`` calls — the prod push is a separate
manual step owned by the caller. Default is a DRY-RUN that prints the summaries
it would inject so they can be eyeballed; pass ``--execute`` to persist.

    python scripts/backfill_phase_summary.py            # dry-run (print only)
    python scripts/backfill_phase_summary.py --execute  # write local store + bundle
"""
from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO / "src"))

# Defaults target the zhaochaoyi continuity plan (see brief).
_DEFAULT_USER = "f10bc353-01ab-4db1-af9f-d9305ea9a532"
_DEFAULT_PLAN = "40810e9e-1ac8-42fb-b3ed-05f097bffe97"

_STORE_PATH = _REPO / "data" / ".master_plans.json"
_BUNDLE_PATH = _REPO / "scripts" / "migration" / "f10bc353_master_plan_bundle.json"


def _read_json(path: Path) -> dict:
    return json.loads(io.open(path, encoding="utf-8").read())


def _write_json(path: Path, data: dict) -> None:
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", default=_DEFAULT_USER)
    ap.add_argument("--plan", default=_DEFAULT_PLAN)
    ap.add_argument("--store", default=str(_STORE_PATH))
    ap.add_argument("--bundle", default=str(_BUNDLE_PATH))
    ap.add_argument("--execute", action="store_true",
                    help="write local store + bundle (default: dry-run print only)")
    args = ap.parse_args()

    from stride_storage.sqlite.database import Database
    from stride_core.master_plan import MasterPlan
    from stride_server.phase_summary import aggregate_phase_summary

    store_path = Path(args.store)
    store = _read_json(store_path)
    raw_plan = store.get(args.user, {}).get(args.plan)
    if raw_plan is None:
        raise SystemExit(f"plan {args.plan} not found for user {args.user} in {store_path}")

    plan = MasterPlan.model_validate(raw_plan)
    completed = [p for p in plan.phases if p.is_completed]
    print(f"[plan] {plan.plan_id} status={plan.status.value} phases={len(plan.phases)} "
          f"completed={len(completed)}")
    if not completed:
        print("No completed phases — nothing to backfill.")
        return

    db = Database(user=args.user)
    new_phases = []
    for phase in plan.phases:
        if not phase.is_completed:
            new_phases.append(phase)
            continue
        summary = aggregate_phase_summary(db, phase.start_date, phase.end_date)
        new_phases.append(phase.model_copy(update={"summary": summary}))
        print(f"\n[summary] phase={phase.name!r}  {phase.start_date}~{phase.end_date}")
        print(json.dumps(summary.model_dump(), ensure_ascii=False, indent=2))
    try:
        db.close()
    except Exception:  # noqa: BLE001
        pass

    updated = plan.model_copy(update={"phases": new_phases})
    updated_raw = json.loads(updated.model_dump_json())

    if not args.execute:
        print("\n=== DRY-RUN — no writes. Re-run with --execute to persist. ===")
        return

    # 1. Write back into the local store.
    store.setdefault(args.user, {})[args.plan] = updated_raw
    _write_json(store_path, store)
    print(f"\n[write] updated local store {store_path}")

    # 2. Rebuild the bundle, preserving its existing goal_store.
    bundle_path = Path(args.bundle)
    if bundle_path.exists():
        bundle = _read_json(bundle_path)
    else:
        bundle = {"user_id": args.user, "goal_store": {}}
    bundle["user_id"] = args.user
    bundle["plan"] = updated_raw
    _write_json(bundle_path, bundle)
    print(f"[write] rebuilt bundle {bundle_path} (goal_store preserved)")
    print("\nDone (local only). Prod push is a separate manual step.")


if __name__ == "__main__":
    main()
