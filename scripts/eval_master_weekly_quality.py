#!/usr/bin/env python3
"""Evaluate a MasterPlan's week-level mileage skeleton and write a JSON report."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[1]
_SRC = _REPO_ROOT / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from coach_eval.master_weekly_quality import evaluate_master_weekly_quality, report_to_dict
from stride_core.master_plan import MasterPlan


def _load_plan(path: Path) -> MasterPlan:
    raw = json.loads(path.read_text(encoding="utf-8"))
    payload = raw.get("plan") or raw.get("master_plan") or raw
    return MasterPlan.model_validate(payload)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("plan", type=Path, help="MasterPlan JSON path")
    parser.add_argument("--out", type=Path, required=True, help="Report JSON path")
    args = parser.parse_args()

    plan = _load_plan(args.plan)
    report = evaluate_master_weekly_quality(plan)
    data = {
        "plan_id": plan.plan_id,
        "user_id": plan.user_id,
        "start_date": plan.start_date,
        "end_date": plan.end_date,
        "phase_count": len(plan.phases),
        "week_count": len(plan.weeks or plan.weekly_key_sessions or []),
        "quality": report_to_dict(report),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    errors = [i for i in report.issues if i.severity == "error"]
    warnings = [i for i in report.issues if i.severity == "warning"]
    print(
        f"master weekly quality: {'OK' if report.ok else 'ERROR'} "
        f"({len(errors)} error, {len(warnings)} warning) -> {args.out}"
    )
    for issue in report.issues:
        print(f"- {issue.severity}: {issue.rule}: {issue.message}")
    return 0 if report.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
