"""Push a git-committed, locally-verified master-plan bundle into prod.

Companion to the local migration: the bundle in
``scripts/migration/<uid>_master_plan_bundle.json`` is produced + eyeballed
locally (LLM-extracted goal -> local generate -> confirm -> browser-verified
SeasonOverview), committed to git, and then this script writes that EXACT plan
into prod so the user sees the plan they reviewed — not a fresh prod
regeneration.

What it writes (prod backends, resolved from config/server.prod.toml):
  * the MasterPlan  -> Azure Table  ``stridemasterplan``
    (PartitionKey=user_id, RowKey=plan_id), via AzureTableMasterPlanStore —
    the same code path the prod app uses, so the row shape is identical.
  * the TrainingGoal store -> content blob ``stride-data/users/<uid>/training_goal.json``
    (so /master-plan/adjust + the goal endpoint stay consistent with the plan).

Auth is DefaultAzureCredential. Run it where that resolves to an identity with
write access to ``authstorage2026`` — i.e. inside the prod environment (ACA
managed identity), or locally if your ``az login`` has rights to that account.

Default is DRY-RUN (reads prod current state, writes nothing). Pass --execute
to perform the writes. It is idempotent: re-running archives any other active
plan for the user and re-saves this one.

    python scripts/push_master_plan_to_prod.py            # dry-run
    python scripts/push_master_plan_to_prod.py --execute  # write to prod
"""
from __future__ import annotations

import argparse
import json
import sys
import tomllib
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO / "src"))


def _prod_storage_config() -> tuple[str, str, str, str]:
    """Return (table_account_url, blob_account_url, container, prefix) from prod toml."""
    with open(_REPO / "config" / "server.prod.toml", "rb") as fh:
        prod = tomllib.load(fh)
    storage = prod["storage"]
    table_url = storage["master_plan"]["table_account_url"]
    content = storage["content"]
    return (
        table_url,
        content["account_url"],
        content["container"],
        content.get("prefix", "users"),
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", default=str(_REPO / "scripts" / "migration"
                    / "f10bc353_master_plan_bundle.json"))
    ap.add_argument("--execute", action="store_true",
                    help="actually write to prod (default: dry-run)")
    args = ap.parse_args()

    bundle = json.loads(Path(args.bundle).read_text(encoding="utf-8"))
    user_id = bundle["user_id"]

    from stride_core.master_plan import MasterPlan
    plan = MasterPlan.model_validate(bundle["plan"])
    if plan.user_id != user_id:
        raise SystemExit(f"bundle user_id mismatch: {plan.user_id} != {user_id}")

    table_url, blob_url, container, prefix = _prod_storage_config()
    print(f"[target] table={table_url}")
    print(f"[target] blob={blob_url} container={container} prefix={prefix}")
    print(f"[bundle] user={user_id} plan={plan.plan_id} status={plan.status.value} "
          f"phases={len(plan.phases)} weeks={plan.total_weeks} goal={plan.goal.race_name}")

    from stride_server.master_plan_store import AzureTableMasterPlanStore
    store = AzureTableMasterPlanStore(table_url, "stridemasterplan")

    # Read prod current state first (works in dry-run too).
    current = store.get_active_plan(user_id)
    print(f"[prod] current active plan: {current.plan_id if current else None}")

    if not args.execute:
        print("\n=== DRY-RUN — no writes. Re-run with --execute to push. ===")
        return

    # Archive any other active plan, then save this one (status already ACTIVE
    # in the bundle), mirroring the confirm endpoint's archive+activate.
    store.archive_previous(user_id, plan.plan_id)
    store.save_plan(plan)
    print(f"[write] saved plan {plan.plan_id} to Azure Table")

    # Write the goal store to the prod content blob.
    from stride_server.content_store import write_json
    from stride_server.config.models import ContentStorageConfig
    cc = ContentStorageConfig(account_url=blob_url, container=container, prefix=prefix)
    src = write_json(f"{user_id}/training_goal.json", bundle["goal_store"], config=cc)
    print(f"[write] saved training_goal.json (source={src})")

    # Verify readback.
    back = store.get_active_plan(user_id)
    if back is None or back.plan_id != plan.plan_id:
        raise SystemExit("VERIFY FAILED: get_active_plan did not return the pushed plan")
    print(f"[verify] prod get_active_plan -> {back.plan_id} status={back.status.value}  OK")
    print("\nDone. The user's /plan will now render the migrated SeasonOverview.")


if __name__ == "__main__":
    main()
