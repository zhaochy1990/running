#!/usr/bin/env python3
"""Repair failed outcomes in a full coach eval report.

This keeps the original generation artifact/timings from a full-suite report
and replaces only L2 judge results with successful single-fixture judge reports
created via ``scripts/eval_coach.py --judge-artifact``.

For a real generation-quality failure, pass a successful single-fixture full
report via ``--replacement-report``; that replaces the entire fixture outcome.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[1]
_SRC = _REPO_ROOT / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from coach_eval.runner import write_report  # noqa: E402
from coach_eval.schemas import EvalReport, FixtureRunOutcome, aggregate_axis_avg  # noqa: E402


class RepairError(ValueError):
    """User-correctable report repair validation error."""


def _read_report(path: Path) -> EvalReport:
    try:
        return EvalReport.model_validate_json(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001 - CLI boundary
        raise RepairError(f"Could not read EvalReport {path}: {exc}") from exc


def _full_generation_like(outcome: FixtureRunOutcome) -> bool:
    return (
        outcome.generation_iterations is not None
        and isinstance(outcome.timings.get("generator_total_s"), (int, float))
        and not outcome.timings.get("artifact_source_report")
    )


def _replacement_from_report(path: Path) -> FixtureRunOutcome:
    report = _read_report(path)
    if report.fixtures_total != 1 or len(report.per_fixture) != 1:
        raise RepairError(f"Judge report must contain exactly one fixture: {path}")
    outcome = report.per_fixture[0]
    if not outcome.l1_passed or outcome.judge_score is None:
        raise RepairError(f"Judge report is not a successful L1+L2 result: {path}")
    return outcome


def _full_outcome_replacement_from_report(path: Path) -> FixtureRunOutcome:
    outcome = _replacement_from_report(path)
    if outcome.generated_artifact is None or not _full_generation_like(outcome):
        raise RepairError(
            "Replacement report is not a full generation result: " f"{path}"
        )
    return outcome


def repair_report(
    base_report: Path,
    judge_reports: list[Path],
    replacement_reports: list[Path] | None = None,
) -> EvalReport:
    base = _read_report(base_report)
    judge_replacements = {
        outcome.fixture_id: outcome
        for outcome in (_replacement_from_report(path) for path in judge_reports)
    }
    full_replacements = {
        outcome.fixture_id: outcome
        for outcome in (
            _full_outcome_replacement_from_report(path)
            for path in (replacement_reports or [])
        )
    }
    overlaps = sorted(set(judge_replacements) & set(full_replacements))
    if overlaps:
        raise RepairError(
            "A fixture cannot be both --judge-report and --replacement-report: "
            + ", ".join(overlaps)
        )
    if not judge_replacements and not full_replacements:
        raise RepairError(
            "At least one --judge-report or --replacement-report is required"
        )

    repaired: list[FixtureRunOutcome] = []
    seen: set[str] = set()
    for outcome in base.per_fixture:
        full_replacement = full_replacements.get(outcome.fixture_id)
        if full_replacement is not None:
            seen.add(outcome.fixture_id)
            repaired.append(full_replacement)
            continue

        replacement = judge_replacements.get(outcome.fixture_id)
        if replacement is None:
            repaired.append(outcome)
            continue

        seen.add(outcome.fixture_id)
        if not _full_generation_like(outcome):
            raise RepairError(
                "Base report outcome lacks full generation timings: "
                f"{outcome.fixture_id}"
            )
        timings = dict(outcome.timings)
        for key, value in replacement.timings.items():
            if key.startswith("judge"):
                timings[key] = value
        judge_s = timings.get("judge_s")
        generation_s = timings.get("generation_total_s")
        if isinstance(judge_s, (int, float)) and isinstance(generation_s, (int, float)):
            timings["total_s"] = float(generation_s) + float(judge_s)

        repaired.append(
            outcome.model_copy(
                update={
                    "judge_score": replacement.judge_score,
                    "judge_samples": replacement.judge_samples,
                    "judge_summary": replacement.judge_summary,
                    "timings": timings,
                    "error": None,
                }
            )
        )

    requested = set(judge_replacements) | set(full_replacements)
    missing = sorted(requested - seen)
    if missing:
        raise RepairError("Reports did not match any base fixture: " + ", ".join(missing))

    n_pass = n_marginal = n_fail = 0
    for outcome in repaired:
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

    return base.model_copy(
        update={
            "run_id": datetime.now(timezone.utc).isoformat(),
            "fixtures_passed": n_pass,
            "fixtures_marginal": n_marginal,
            "fixtures_failed": n_fail,
            "per_axis_avg": aggregate_axis_avg(repaired),
            "per_fixture": repaired,
        }
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-report", type=Path, required=True)
    parser.add_argument(
        "--judge-report",
        type=Path,
        action="append",
        default=[],
        help="Successful single-fixture judge report; repeatable.",
    )
    parser.add_argument(
        "--replacement-report",
        type=Path,
        action="append",
        default=[],
        help=(
            "Successful single-fixture full report; replaces the entire "
            "fixture outcome. Repeatable."
        ),
    )
    args = parser.parse_args(argv)

    try:
        repaired = repair_report(
            args.base_report,
            args.judge_report,
            replacement_reports=args.replacement_report,
        )
    except RepairError as exc:
        print(f"Cannot repair report: {exc}", file=sys.stderr)
        return 1

    json_path, md_path = write_report(repaired)
    print(f"Repaired report JSON: {json_path}")
    print(f"Repaired report MD:   {md_path}")
    print(
        "Fixtures: "
        f"{repaired.fixtures_total} "
        f"(pass={repaired.fixtures_passed} "
        f"marginal={repaired.fixtures_marginal} "
        f"fail={repaired.fixtures_failed})"
    )
    return 0 if repaired.fixtures_failed == 0 and repaired.fixtures_marginal == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
