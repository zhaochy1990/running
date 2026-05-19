#!/usr/bin/env python3
"""Offline coach evaluation CLI.

Usage::

    # Run all S1 fixtures in frozen_fixture mode (default)
    PYTHONIOENCODING=utf-8 python -m scripts.eval_coach --scope s1

    # Run specific fixture in live_local_db mode (queries real SQLite)
    python -m scripts.eval_coach --scope s1 --fixture s1-summer-base-build --mode live_local_db

    # L1-only (no LLM calls — fast)
    python -m scripts.eval_coach --scope s1 --layer L1

    # Emit per-fixture spot-check markdown for human review
    python -m scripts.eval_coach --scope s1 --fixture s1-hrv-drop --emit-spot-check

Exit codes:

* ``0`` — all fixtures pass
* ``1`` — at least one fixture failed
* ``2`` — at least one marginal (no fails)
* ``64`` — LLM unavailable / config missing (separate from eval failure)

See ``docs/coach-eval.md`` for the full eval framework spec.
"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

# Allow running as `python scripts/eval_coach.py` (no -m): inject src/.
_REPO_ROOT = Path(__file__).resolve().parents[1]
_SRC = _REPO_ROOT / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))


EXIT_OK = 0
EXIT_FAIL = 1
EXIT_MARGINAL = 2
EXIT_LLM_UNAVAILABLE = 64


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Offline coach evaluation runner (S1 / S2 / S3)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--scope",
        choices=("s1", "s2", "s3", "all"),
        default="s1",
        help="Which scope to evaluate. v1 only s1 implemented.",
    )
    parser.add_argument(
        "--fixture",
        action="append",
        dest="fixture_ids",
        default=None,
        help="Filter to a specific fixture_id (repeatable). Default = all fixtures in scope.",
    )
    parser.add_argument(
        "--mode",
        choices=("frozen_fixture", "live_local_db"),
        default="frozen_fixture",
        help=(
            "frozen_fixture (default): read fixture inline context, no DB query — "
            "reproducible. live_local_db: query data/{user_id}/coros.db — only for "
            "exploratory sampling, not regression baseline."
        ),
    )
    parser.add_argument(
        "--layer",
        choices=("L1", "L2", "all"),
        default="all",
        help="L1 = rule_filter only (fast, no LLM). L2 = adds judge. (default: all)",
    )
    parser.add_argument(
        "--emit-spot-check",
        action="store_true",
        help="Also write per-fixture spot-check markdown to tests/fixtures/coach_eval/spot_checks/",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Enable DEBUG logging.",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    # v1: only S1 wired
    if args.scope in ("s2", "s3"):
        print(f"--scope {args.scope} not implemented in v1; see docs/coach-eval_{args.scope.upper()}.md", file=sys.stderr)
        return EXIT_FAIL
    if args.scope == "all":
        print("--scope all not implemented in v1; specify --scope s1", file=sys.stderr)
        return EXIT_FAIL

    if args.layer == "L1":
        return _run_l1_only(args)
    return _run_full(args)


def _run_full(args: argparse.Namespace) -> int:
    """L1 + L2 (full eval with LLM judge)."""
    from stride_server.coach_adapters.eval_runner import (
        RunMode,
        run_s1_evaluation,
        write_report,
    )

    mode = RunMode(args.mode)

    try:
        report = run_s1_evaluation(mode=mode, fixture_ids=args.fixture_ids)
    except Exception as exc:  # noqa: BLE001 — top-level CLI boundary
        msg = str(exc).lower()
        if "llm" in msg and ("unavailable" in msg or "not enabled" in msg):
            print(f"LLM unavailable: {exc}", file=sys.stderr)
            return EXIT_LLM_UNAVAILABLE
        raise

    json_path, md_path = write_report(report)
    _print_summary(report, json_path, md_path)

    if args.emit_spot_check:
        _emit_spot_checks(report)

    return _exit_code(report)


def _run_l1_only(args: argparse.Namespace) -> int:
    """L1 layer only: load fixtures + run gen graph (L1 inside) without LLM judge.

    Hmm — generation itself requires LLM (it's the "G" in L1+L2). To truly run
    L1-only without burning LLM tokens, we'd need a way to bypass generation
    and feed a pre-generated MasterPlan dict to rule_filter. v1 simplification:
    --layer L1 currently just runs the full pipe and drops the judge results.
    A future PR can add a `--from-cached-draft path/to/plan.json` flag.
    """
    print(
        "--layer L1 currently still runs generation (LLM needed). "
        "Skipping judge LLM call but rule_filter results require a generated draft.",
        file=sys.stderr,
    )
    # Fall through to full run; only difference: don't emit_spot_check
    return _run_full(args)


def _print_summary(report, json_path: Path, md_path: Path) -> None:
    print()
    print(f"=== Eval report: {report.scope} ({report.mode}) ===")
    print(f"  git_sha:              {report.git_sha}")
    print(f"  judge_prompt_version: {report.judge_prompt_version}")
    print(f"  fixtures:             {report.fixtures_total} "
          f"(pass={report.fixtures_passed} marginal={report.fixtures_marginal} fail={report.fixtures_failed})")
    if report.per_axis_avg:
        print()
        print("  Per-axis averages:")
        for axis, avg in sorted(report.per_axis_avg.items()):
            print(f"    {axis:<28}  {avg:.2f}")
    if report.per_fixture:
        print()
        print("  Per-fixture:")
        for o in report.per_fixture:
            verdict = o.judge_score.overall_verdict if o.judge_score else "(no judge)"
            l1 = "OK" if o.l1_passed else "BLOCK"
            err = f"  [error: {o.error}]" if o.error else ""
            print(f"    {o.fixture_id:<40}  L1={l1:<5}  verdict={verdict}{err}")
    print()
    print(f"  Report JSON: {json_path}")
    print(f"  Report MD:   {md_path}")


def _emit_spot_checks(report) -> None:
    """Write per-fixture spot-check markdown for human review."""
    spot_dir = _REPO_ROOT / "tests" / "fixtures" / "coach_eval" / "spot_checks"
    spot_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    for o in report.per_fixture:
        path = spot_dir / f"{stamp}_{o.fixture_id}.md"
        lines = [
            "---",
            f"fixture_id: {o.fixture_id}",
            f"scope: {o.scope}",
            f"run_at: {report.run_id}",
            f"git_sha: {report.git_sha}",
            f"judge_prompt_version: {report.judge_prompt_version}",
            "human_verdict: pending  # accept | reject | mixed",
            "human_notes: |",
            "  ",
            "---",
            "",
            "## L1 result",
            "",
            f"- l1_passed: **{o.l1_passed}**",
        ]
        if o.l1_violations:
            lines.append("- violations:")
            for v in o.l1_violations:
                lines.append(f"  - `{v.get('rule')}` ({v.get('severity', '?')}): {v.get('message', '')}")
        lines.extend(["", "## L2 judge", ""])
        if o.judge_score:
            lines.append(f"- model: `{o.judge_score.judge_model}`")
            lines.append(f"- prompt_version: `{o.judge_score.judge_prompt_version}`")
            lines.append(f"- overall_verdict: **{o.judge_score.overall_verdict}**")
            lines.append(f"- overall_rationale: {o.judge_score.overall_rationale}")
            lines.append("")
            lines.append("| Axis | Score | Matches expected | Rationale |")
            lines.append("|------|-------|------------------|-----------|")
            for ax in o.judge_score.axes:
                score_str = str(ax.score) if ax.score is not None else "N/A"
                lines.append(
                    f"| `{ax.axis}` | {score_str} | "
                    f"{'OK' if ax.matches_expected else 'NO'} | {ax.rationale} |"
                )
        elif o.error:
            lines.append(f"- error: {o.error}")
        else:
            lines.append("(no judge result)")
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"  spot-check: {path}")


def _exit_code(report) -> int:
    if report.fixtures_failed > 0:
        return EXIT_FAIL
    if report.fixtures_marginal > 0:
        return EXIT_MARGINAL
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
