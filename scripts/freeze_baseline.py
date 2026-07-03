#!/usr/bin/env python3
"""Freeze a coach eval report as a baseline for future regression.

Usage::

    # First run an eval to produce a report:
    PYTHONIOENCODING=utf-8 python -m scripts.eval_coach --scope s1

    # Then freeze it as the canonical baseline:
    PYTHONIOENCODING=utf-8 python -m scripts.freeze_baseline --scope s1 --label v1 \
      --report .omc/eval/reports/<run>.json

The selected .omc/eval/reports/*.json is copied to
.omc/eval/baselines/{scope}_{label}.json after safety checks. A short header
with timestamp / git_sha / mode / pass-marginal-fail counts gets written
alongside as a .md file for human review.

The baseline is what future ``eval_coach`` runs will be compared against
(diff per_axis_avg, score deltas). Should be regenerated after any change
that's expected to shift the eval distribution (prompt tune, new rule,
schema migration).
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parents[1]
_REPORTS_DIR = _REPO_ROOT / ".omc" / "eval" / "reports"
_BASELINES_DIR = _REPO_ROOT / ".omc" / "eval" / "baselines"


class FreezeError(ValueError):
    """User-correctable baseline-freeze validation error."""


def _read_report(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise FreezeError(f"Could not read report {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise FreezeError(f"Report is not valid JSON: {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise FreezeError(f"Report must be a JSON object: {path}")
    return payload


def _latest_report_for_scope(scope: str) -> Path | None:
    """Find the most recently modified report JSON matching the scope."""
    if not _REPORTS_DIR.exists():
        return None
    candidates = []
    for path in _REPORTS_DIR.glob("*.json"):
        try:
            if _read_report(path).get("scope") == scope:
                candidates.append(path)
        except FreezeError:
            continue
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_mtime)


def _looks_like_full_generation_outcome(outcome: dict[str, Any]) -> bool:
    timings = outcome.get("timings") or {}
    return (
        outcome.get("generation_iterations") is not None
        and isinstance(timings.get("generator_total_s"), (int, float))
        and not timings.get("artifact_source_report")
    )


def _validate_report(
    report: dict[str, Any],
    *,
    source: Path,
    scope: str,
    allow_nonpass: bool,
    allow_single_fixture: bool,
    allow_judge_artifact: bool,
) -> None:
    """Guard against freezing exploratory, partial, or wrong-scope reports."""
    report_scope = report.get("scope")
    if report_scope != scope:
        raise FreezeError(
            f"Report scope mismatch: expected {scope!r}, got {report_scope!r} in {source}"
        )

    mode = report.get("mode")
    if mode != "frozen_fixture":
        raise FreezeError(
            "Only frozen_fixture reports can be baselines. "
            f"Got mode={mode!r} in {source}."
        )

    per_fixture = report.get("per_fixture")
    if not isinstance(per_fixture, list) or not per_fixture:
        raise FreezeError(f"Report has no per_fixture outcomes: {source}")

    fixtures_total = report.get("fixtures_total")
    if fixtures_total != len(per_fixture):
        raise FreezeError(
            "Report fixture count mismatch: "
            f"fixtures_total={fixtures_total!r}, per_fixture={len(per_fixture)} in {source}"
        )

    if fixtures_total <= 1 and not allow_single_fixture:
        raise FreezeError(
            "Refusing to freeze a single-fixture report as a suite baseline. "
            "Use --allow-single-fixture only for deliberate diagnostic baselines."
        )

    failed = int(report.get("fixtures_failed") or 0)
    marginal = int(report.get("fixtures_marginal") or 0)
    if (failed or marginal) and not allow_nonpass:
        raise FreezeError(
            "Refusing to freeze a non-pass report: "
            f"marginal={marginal}, fail={failed}. Use --allow-nonpass to override."
        )

    if not allow_judge_artifact:
        artifact_like = [
            str(outcome.get("fixture_id") or f"<idx={idx}>")
            for idx, outcome in enumerate(per_fixture, start=1)
            if isinstance(outcome, dict)
            and not _looks_like_full_generation_outcome(outcome)
        ]
        if artifact_like:
            raise FreezeError(
                "Refusing to freeze a judge-artifact/partial report without a fresh full generation run. "
                f"Missing fresh full generation metadata for: {', '.join(artifact_like)}. "
                "Use --allow-judge-artifact only for deliberate judge-only baselines."
            )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scope", choices=("s1", "s2", "s3"), required=True)
    parser.add_argument(
        "--label", default="v1",
        help="Suffix for the baseline file (default: v1)",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=None,
        help=(
            "EvalReport JSON to freeze. Recommended. If omitted, the latest "
            "matching report in .omc/eval/reports is selected after validation."
        ),
    )
    parser.add_argument(
        "--force", action="store_true",
        help="Overwrite the existing baseline without prompting.",
    )
    parser.add_argument(
        "--allow-nonpass",
        action="store_true",
        help="Allow freezing reports with marginal or failed fixtures.",
    )
    parser.add_argument(
        "--allow-single-fixture",
        action="store_true",
        help="Allow freezing a one-fixture diagnostic baseline.",
    )
    parser.add_argument(
        "--allow-judge-artifact",
        action="store_true",
        help="Allow freezing judge-artifact reports that skipped generation.",
    )
    args = parser.parse_args(argv)

    src = args.report or _latest_report_for_scope(args.scope)
    if src is None:
        print(
            f"No {args.scope} report found in {_REPORTS_DIR}. "
            f"Run `python -m scripts.eval_coach --scope {args.scope}` first, "
            "then pass --report .omc/eval/reports/<run>.json.",
            file=sys.stderr,
        )
        return 1
    src = src.resolve()

    try:
        report = _read_report(src)
        _validate_report(
            report,
            source=src,
            scope=args.scope,
            allow_nonpass=args.allow_nonpass,
            allow_single_fixture=args.allow_single_fixture,
            allow_judge_artifact=args.allow_judge_artifact,
        )
    except FreezeError as exc:
        print(f"Cannot freeze baseline: {exc}", file=sys.stderr)
        return 1

    _BASELINES_DIR.mkdir(parents=True, exist_ok=True)
    dst_json = _BASELINES_DIR / f"{args.scope}_{args.label}.json"
    dst_md = _BASELINES_DIR / f"{args.scope}_{args.label}.md"

    if dst_json.exists() and not args.force:
        print(
            f"Baseline {dst_json} already exists. Re-run with --force to overwrite.",
            file=sys.stderr,
        )
        return 1

    shutil.copy(src, dst_json)
    lines = [
        f"# {args.scope.upper()} eval baseline - {args.label}",
        "",
        f"- **source report**: {src}",
        f"- **frozen at**: {report.get('run_id', '?')}",
        f"- **git_sha**: `{report.get('git_sha', '?')}`",
        f"- **mode**: {report.get('mode', '?')}",
        f"- **judge_prompt_version**: {report.get('judge_prompt_version', '?')}",
        f"- **fixtures**: {report.get('fixtures_total', 0)} total - "
        f"pass={report.get('fixtures_passed', 0)} "
        f"marginal={report.get('fixtures_marginal', 0)} "
        f"fail={report.get('fixtures_failed', 0)}",
        "",
        "## Per-axis averages",
        "",
        "| Axis | Score |",
        "|------|-------|",
    ]
    for axis, avg in sorted((report.get("per_axis_avg") or {}).items()):
        lines.append(f"| `{axis}` | {avg:.2f} |")
    lines.extend([
        "",
        "## How to compare against this baseline",
        "",
        "Re-run `eval_coach.py` and diff the resulting per_axis_avg / pass-fail",
        "counts against this file. A drop of >= 0.5 on any axis or any pass-to-fail",
        "regression is a hard signal - investigate the prompt / rule change",
        "before merging.",
    ])
    dst_md.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(f"Source report:   {src}")
    print(f"Run id:          {report.get('run_id', '?')}")
    print(f"Git sha:         {report.get('git_sha', '?')}")
    print(f"Mode:            {report.get('mode', '?')}")
    print(f"Judge version:   {report.get('judge_prompt_version', '?')}")
    print(
        "Fixtures:        "
        f"{report.get('fixtures_total', 0)} "
        f"(pass={report.get('fixtures_passed', 0)} "
        f"marginal={report.get('fixtures_marginal', 0)} "
        f"fail={report.get('fixtures_failed', 0)})"
    )
    print(f"Baseline frozen: {dst_json}")
    print(f"Summary:         {dst_md}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
