"""Local (no-prod) master-plan migration driver.

Runs the full migration against LOCAL file-backed stores so the result can be
inspected before anything touches prod:

    1. write the (LLM-extracted) goal to the local content store
       (data/<uuid>/training_goal.json)
    2. run_generate_job synchronously -> coach LLM pipeline -> DRAFT plan
       persisted to the local FileMasterPlanStore (data/.master_plans.json)
    3. confirm: archive previous + flip DRAFT -> ACTIVE (mirrors the prod
       confirm endpoint's archive+activate)
    4. verify get_active_plan + print a summary so the plan content can be
       eyeballed (phases, editorial fields)

Storage stays file-backed because config/server.toml leaves
table_account_url / blob account empty; STRIDE_CONFIG_ENV=local only swaps the
coach LLM config (gpt-5.5) — it does NOT point storage at prod.

    PYTHONPATH=src STRIDE_CONFIG_ENV=local python scripts/migrate_master_plan_local.py \
        --goal-file /tmp/zhaochaoyi_goal.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import uuid as _uuid
from datetime import datetime, timezone
from pathlib import Path

os.environ.setdefault("STRIDE_CONFIG_ENV", "local")
# Defence-in-depth: never let an ambient prod-store env var leak local writes
# to prod. Generation here is supposed to be local-only.
for _leak in ("STRIDE_MASTER_PLAN_TABLE_ACCOUNT_URL", "STRIDE_CONTENT_BLOB_ACCOUNT_URL"):
    os.environ.pop(_leak, None)

_REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO / "src"))

DEFAULT_USER = "f10bc353-01ab-4db1-af9f-d9305ea9a532"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", default=DEFAULT_USER)
    ap.add_argument("--goal-file", required=True, help="validated goal JSON from extract_training_goal.py")
    args = ap.parse_args()

    user_id = args.profile
    goal = json.loads(Path(args.goal_file).read_text(encoding="utf-8"))

    # --- 1. write goal to local content store --------------------------------
    from stride_server.content_store import write_json, read_json
    goal_full = dict(goal)
    goal_full["goal_id"] = str(_uuid.uuid4())
    goal_full["created_at"] = _now()
    goal_full["updated_at"] = _now()
    write_json(f"{user_id}/training_goal.json", {"current": goal_full, "history": []})
    print(f"[goal] wrote training_goal.json goal_id={goal_full['goal_id']}")

    # --- 2. generate synchronously -------------------------------------------
    from stride_server import job_runner
    from stride_server.job_runner import JobStatus
    from stride_server.master_plan_generator import run_generate_job

    job_id = job_runner.create_job(user_id)
    print(f"[generate] job_id={job_id} running synchronously (gpt-5.5, ~minutes)...")
    run_generate_job(job_id, user_id, goal_full, None)
    job = job_runner.get_job(job_id)
    if job is None or job.status != JobStatus.DONE:
        err = getattr(job, "error", None) if job else "job missing"
        raw = getattr(job, "raw_output", None) if job else None
        raise SystemExit(f"generation failed: status={getattr(job,'status',None)} error={err}\n{raw or ''}")
    plan_id = job.result_plan_id
    print(f"[generate] DONE draft plan_id={plan_id}")

    # --- 3. confirm: archive previous + activate -----------------------------
    from stride_server.master_plan_store import get_master_plan_store
    from stride_core.master_plan import MasterPlanStatus

    store = get_master_plan_store()
    store.archive_previous(user_id, plan_id)
    plan = store.get_plan(user_id, plan_id)
    if plan is None:
        raise SystemExit("draft plan not found in store after generation")
    activated = plan.model_copy(update={
        "status": MasterPlanStatus.ACTIVE,
        "updated_at": _now(),
    })
    store.save_plan(activated)
    print(f"[confirm] plan {plan_id} -> ACTIVE")

    # --- 4. verify + summary -------------------------------------------------
    active = store.get_active_plan(user_id)
    if active is None or active.plan_id != plan_id:
        raise SystemExit("verify failed: get_active_plan did not return the confirmed plan")

    print("\n=== ACTIVE master plan summary (inspect before pushing to prod) ===")
    print(f"plan_id     : {active.plan_id}")
    print(f"goal        : {active.goal.race_name} {active.goal.distance} {active.goal.race_date} target={active.goal.target_time or '完赛'}")
    print(f"span        : {active.start_date} -> {active.end_date}  ({active.total_weeks} weeks)")
    print(f"phases      : {len(active.phases)}")
    for i, ph in enumerate(active.phases, 1):
        ed = []
        if ph.rhythm: ed.append("rhythm")
        if ph.key_workouts: ed.append("key_workouts")
        if ph.monitoring_triggers: ed.append(f"triggers×{len(ph.monitoring_triggers)}")
        if ph.coach_note: ed.append("coach_note")
        print(f"  P{i} {ph.name} [{ph.phase_type or '?'}] "
              f"{ph.start_date}~{ph.end_date} {ph.weekly_distance_km_low:.0f}-{ph.weekly_distance_km_high:.0f}km "
              f"editorial:[{', '.join(ed) or 'NONE'}]")
    print(f"milestones  : {len(active.milestones)}")
    print(f"\nlocal stores written:")
    print(f"  {_REPO / 'data' / '.master_plans.json'}")
    print(f"  {_REPO / 'data' / user_id / 'training_goal.json'}")


if __name__ == "__main__":
    main()
