"""Backfill weekly STRIDE dose ranges on ACTIVE master plans.

The command is read-only by default. Pass --execute to persist projected
plans. Drafts, archived plans, and version snapshots are deliberately out of
scope.

Examples:

    python scripts/backfill_master_plan_training_load.py --prod -P zhaochaoyi
    python scripts/backfill_master_plan_training_load.py --prod --all --execute
    python scripts/backfill_master_plan_training_load.py --local --all
"""

from __future__ import annotations

import argparse
import json
import sys
import tomllib
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO / "src"))


def _resolve_profile(value: str) -> str:
    aliases_path = _REPO / "data" / ".slug_aliases.json"
    if aliases_path.exists():
        aliases = json.loads(aliases_path.read_text(encoding="utf-8"))
        if isinstance(aliases, dict) and value in aliases:
            return str(aliases[value])
    return value


def _select_plans(store, profiles: list[str], all_plans: bool):
    if all_plans:
        return store.list_active_plans()
    selected = []
    for raw in profiles:
        user_id = _resolve_profile(raw)
        plan = store.get_active_plan(user_id)
        if plan is None:
            print(f"[{raw}] no active master plan")
            continue
        selected.append(plan)
    return selected


def _build_store(target: str):
    """Build an explicitly selected store and return it with a safe label."""
    from stride_storage.azure.master_plan_backend import (
        DEFAULT_TABLE_NAME,
        AzureTableMasterPlanStore,
        FileMasterPlanStore,
    )

    if target == "local":
        return FileMasterPlanStore(), f"local file {_REPO / 'data' / '.master_plans.json'}"
    if target != "prod":
        raise ValueError(f"unsupported migration target: {target}")

    config_path = _REPO / "config" / "server.prod.toml"
    with config_path.open("rb") as fh:
        config = tomllib.load(fh)
    try:
        master_plan = config["storage"]["master_plan"]
        account_url = str(master_plan["table_account_url"]).strip()
    except (KeyError, TypeError) as exc:
        raise RuntimeError(
            f"missing storage.master_plan.table_account_url in {config_path}"
        ) from exc
    if not account_url.startswith("https://"):
        raise RuntimeError(
            f"invalid production master-plan table_account_url in {config_path}"
        )
    table_name = str(master_plan.get("table_name") or DEFAULT_TABLE_NAME)
    return (
        AzureTableMasterPlanStore(account_url, table_name),
        f"production Azure Table {account_url} table={table_name}",
    )


def _project(plan):
    from stride_server.coach_adapters.tool_impls.read_impls import (
        EstimateMasterPlanLoadImpl,
    )
    from stride_server.coach_adapters.master_plan_load import (
        apply_master_plan_training_load_projection,
    )

    if not plan.weeks:
        projected = apply_master_plan_training_load_projection(plan, None)
    else:
        result = EstimateMasterPlanLoadImpl(plan.user_id)(
            plan=plan.model_dump(mode="json"),
            target_race={
                "distance": plan.goal.distance.value,
                "race_date": plan.goal.race_date,
            },
        )
        if not result.ok or not isinstance(result.data, dict):
            errors = "; ".join(str(error) for error in result.errors)
            raise RuntimeError(errors or "load estimator returned no data")
        estimate = result.data.get("plan_estimate")
        projected = apply_master_plan_training_load_projection(plan, estimate)

    # Re-running the same backfill should be a true no-op. Preserve the prior
    # calculation timestamp when the availability state and every derived
    # weekly dose are unchanged. This covers both available projections and
    # legacy plans whose weekly skeleton remains unavailable.
    previous = plan.training_load_projection
    current = projected.training_load_projection
    if (
        previous is not None
        and current is not None
        and previous.status == current.status
        and previous.unavailable_reason == current.unavailable_reason
    ):
        old_ranges = [
            (week.target_training_dose_low, week.target_training_dose_high)
            for week in plan.weeks
        ]
        new_ranges = [
            (week.target_training_dose_low, week.target_training_dose_high)
            for week in projected.weeks
        ]
        if old_ranges == new_ranges:
            projected = projected.model_copy(update={
                "training_load_projection": previous,
            })
    return projected


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument(
        "--prod",
        action="store_true",
        help="Use the production Azure Table configured in config/server.prod.toml",
    )
    target.add_argument(
        "--local",
        action="store_true",
        help="Use the local data/.master_plans.json file store",
    )
    parser.add_argument("-P", "--profile", action="append", default=[], help="User UUID or slug")
    parser.add_argument("--all", action="store_true", help="Process every active master plan")
    parser.add_argument("--execute", action="store_true", help="Persist changes; default is dry-run")
    args = parser.parse_args(argv)
    if not args.all and not args.profile:
        parser.error("provide -P/--profile or --all")
    if args.all and args.profile:
        parser.error("--all cannot be combined with -P/--profile")

    store, target_label = _build_store("prod" if args.prod else "local")
    print(f"target: {target_label}")
    plans = _select_plans(store, args.profile, args.all)
    failed = 0
    for plan in plans:
        try:
            updated = _project(plan)
        except Exception as exc:  # noqa: BLE001 - report per user and continue
            failed += 1
            print(f"[{plan.user_id}] plan={plan.plan_id} ERROR {exc}")
            continue

        projection = updated.training_load_projection
        projected_count = sum(
            1 for week in updated.weeks if week.target_training_dose_high is not None
        )
        changed = plan.model_dump(mode="json") != updated.model_dump(mode="json")
        print(
            f"[{plan.user_id}] plan={plan.plan_id} "
            f"status={projection.status if projection else 'missing'} "
            f"weeks={projected_count}/{len(updated.weeks)} "
            f"changed={str(changed).lower()}"
        )
        if not changed:
            print("  unchanged: no write")
        elif args.execute:
            store.save_plan(updated)
            print("  saved")
        else:
            print("  dry-run: no write")

    print(f"summary: selected={len(plans)} failed={failed} execute={args.execute}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
