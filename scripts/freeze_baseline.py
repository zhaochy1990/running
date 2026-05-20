#!/usr/bin/env python3
"""Freeze the latest S1 eval report as a baseline for future regression.

Usage::

    # First run an eval to produce a report:
    PYTHONIOENCODING=utf-8 python -m scripts.eval_coach --scope s1

    # Then freeze it as the canonical baseline:
    PYTHONIOENCODING=utf-8 python -m scripts.freeze_baseline --scope s1 --label v1

The latest .omc/eval/reports/*.json is copied to
.omc/eval/baselines/{scope}_{label}.json. A short header with timestamp /
git_sha / mode / pass-marginal-fail counts gets written alongside as a
.md file for human review.

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

_REPO_ROOT = Path(__file__).resolve().parents[1]
_REPORTS_DIR = _REPO_ROOT / ".omc" / "eval" / "reports"
_BASELINES_DIR = _REPO_ROOT / ".omc" / "eval" / "baselines"


def _latest_report_for_scope(scope: str) -> Path | None:
    """Find the most recently modified report JSON matching the scope."""
    if not _REPORTS_DIR.exists():
        return None
    candidates = [
        p for p in _REPORTS_DIR.glob("*.json")
        if json.loads(p.read_text(encoding="utf-8")).get("scope") == scope
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_mtime)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scope", choices=("s1", "s2", "s3"), required=True)
    parser.add_argument(
        "--label", default="v1",
        help="Suffix for the baseline file (default: v1)",
    )
    parser.add_argument(
        "--force", action="store_true",
        help="Overwrite the existing baseline without prompting.",
    )
    args = parser.parse_args(argv)

    src = _latest_report_for_scope(args.scope)
    if src is None:
        print(
            f"No {args.scope} report found in {_REPORTS_DIR}. "
            f"Run `python -m scripts.eval_coach --scope {args.scope}` first.",
            file=sys.stderr,
        )
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
    report = json.loads(dst_json.read_text(encoding="utf-8"))
    lines = [
        f"# {args.scope.upper()} eval baseline — {args.label}",
        "",
        f"- **source report**: {src.name}",
        f"- **frozen at**: {report.get('run_id', '?')}",
        f"- **git_sha**: `{report.get('git_sha', '?')}`",
        f"- **mode**: {report.get('mode', '?')}",
        f"- **judge_prompt_version**: {report.get('judge_prompt_version', '?')}",
        f"- **fixtures**: {report.get('fixtures_total', 0)} total — "
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
        "counts against this file. A drop of ≥ 0.5 on any axis or any pass→fail",
        "regression is a hard signal — investigate the prompt / rule change",
        "before merging.",
    ])
    dst_md.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(f"Baseline frozen: {dst_json}")
    print(f"Summary:        {dst_md}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
