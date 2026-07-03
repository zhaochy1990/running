#!/usr/bin/env python3
"""Refresh L1 rule-filter history in an existing coach eval report.

This is the cheap companion to ``repair_eval_report_judges.py``: it replays the
current L1 ``run_master_rule_filter`` against each embedded generated artifact,
using the matching fixture context, and rewrites only timing metadata related to
rule-filter history. It does not call the generator or judge.
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[1]
_SRC = _REPO_ROOT / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from coach.graphs.generation.master_rule_filter import run_master_rule_filter  # noqa: E402
from coach_eval.runner import _s1_rule_filter_kwargs, load_fixtures, write_report  # noqa: E402
from coach_eval.schemas import EvalReport, FixtureRunOutcome, aggregate_axis_avg  # noqa: E402


class RefreshError(ValueError):
    """User-correctable report refresh validation error."""


def _read_report(path: Path) -> EvalReport:
    try:
        return EvalReport.model_validate_json(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001 - CLI boundary
        raise RefreshError(f"Could not read EvalReport {path}: {exc}") from exc


def _violation_to_dict(violation: object) -> dict:
    if hasattr(violation, "model_dump"):
        return violation.model_dump()  # type: ignore[no-any-return, attr-defined]
    out = {
        "rule": getattr(violation, "rule", None),
        "severity": getattr(violation, "severity", None),
        "message": getattr(violation, "message", None),
    }
    details = getattr(violation, "details", None)
    if details is not None:
        out["details"] = details
    return {key: value for key, value in out.items() if value is not None}


def refresh_l1_report(report_path: Path) -> EvalReport:
    report = _read_report(report_path)
    if report.scope != "s1":
        raise RefreshError(f"Only S1 reports are supported, got {report.scope!r}")

    fixtures = {fixture["fixture_id"]: fixture for fixture in load_fixtures("s1")}
    refreshed: list[FixtureRunOutcome] = []
    for outcome in report.per_fixture:
        if outcome.generated_artifact is None:
            raise RefreshError(f"Outcome lacks generated_artifact: {outcome.fixture_id}")
        fixture = fixtures.get(outcome.fixture_id)
        if fixture is None:
            raise RefreshError(f"No matching fixture found: {outcome.fixture_id}")

        start = time.monotonic()
        l1_report = run_master_rule_filter(
            outcome.generated_artifact,
            **_s1_rule_filter_kwargs(fixture),
        )
        rule_filter_s = time.monotonic() - start
        l1_violations = [_violation_to_dict(v) for v in l1_report.violations]
        timings = dict(outcome.timings)
        timings["rule_filter_s"] = [rule_filter_s]
        timings["rule_filter_history"] = [{
            "iteration": outcome.generation_iterations or 1,
            "violations": l1_violations,
        }]

        refreshed.append(
            outcome.model_copy(
                update={
                    "l1_passed": not l1_report.errors(),
                    "l1_violations": l1_violations,
                    "timings": timings,
                    "error": None if not l1_report.errors() else outcome.error,
                }
            )
        )

    n_pass = n_marginal = n_fail = 0
    for outcome in refreshed:
        if not outcome.l1_passed or outcome.judge_score is None:
            n_fail += 1
            continue
        verdict = outcome.judge_score.overall_verdict
        if verdict == "pass":
            n_pass += 1
        elif verdict == "marginal":
            n_marginal += 1
        else:
            n_fail += 1

    return report.model_copy(
        update={
            "run_id": datetime.now(timezone.utc).isoformat(),
            "fixtures_passed": n_pass,
            "fixtures_marginal": n_marginal,
            "fixtures_failed": n_fail,
            "per_axis_avg": aggregate_axis_avg(refreshed),
            "per_fixture": refreshed,
        }
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args(argv)

    try:
        refreshed = refresh_l1_report(args.report)
    except RefreshError as exc:
        print(f"Cannot refresh report: {exc}", file=sys.stderr)
        return 1

    json_path, md_path = write_report(refreshed)
    warnings = 0
    errors = 0
    for outcome in refreshed.per_fixture:
        history = outcome.timings.get("rule_filter_history") or []
        for item in history:
            for violation in item.get("violations") or []:
                if violation.get("severity") == "warning":
                    warnings += 1
                elif violation.get("severity") == "error":
                    errors += 1

    print(f"Refreshed report JSON: {json_path}")
    print(f"Refreshed report MD:   {md_path}")
    print(f"L1 warnings: {warnings}; errors: {errors}")
    return 0 if errors == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
