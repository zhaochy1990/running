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

    # Re-run L1 + L2 judge against an existing generated plan artifact
    python -m scripts.eval_coach --scope s1 --fixture s1-hrv-drop --judge-artifact .omc/eval/reports/<run>/artifacts/s1-hrv-drop.generated-plan.json

Exit codes:

* ``0`` — all fixtures pass
* ``1`` — at least one fixture failed
* ``2`` — at least one marginal (no fails)
* ``64`` — LLM unavailable / config missing (separate from eval failure)

See ``docs/coach-eval.md`` for the full eval framework spec.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from collections import Counter
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

_LLM_TRANSIENT_ERROR_MARKERS = (
    "429",
    "500 internal server error",
    "server_error",
    "server had an error",
    "502 bad gateway",
    "503 service unavailable",
    "504 gateway timeout",
    "no_capacity",
    "too many requests",
    "rate limit",
    "temporarily unavailable",
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Offline coach evaluation runner (S1 / S2 / S3)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--scope",
        choices=("s1", "s2", "s3", "all"),
        default="s1",
        help="Which scope to evaluate. S1 and S2 are implemented; S3 is pending.",
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
        "--conversation",
        action="store_true",
        help=(
            "For --scope s1, run frozen master_chat conversation fixtures instead "
            "of full-plan generation fixtures."
        ),
    )
    parser.add_argument(
        "--emit-spot-check",
        action="store_true",
        help="Also write per-fixture spot-check markdown to tests/fixtures/coach_eval/spot_checks/",
    )
    parser.add_argument(
        "--judge-artifact",
        type=Path,
        default=None,
        help=(
            "Reuse an existing generated plan JSON artifact and run L1+L2 only. "
            "Requires exactly one --fixture and skips the expensive generator call."
        ),
    )
    parser.add_argument(
        "--judge-repeat",
        type=int,
        default=1,
        help=(
            "With --judge-artifact, repeat the L2 judge N times on the same artifact "
            "and report a conservative aggregate plus variance metadata."
        ),
    )
    parser.add_argument(
        "--master-max-tokens",
        type=int,
        default=None,
        help=(
            "S1 generation experiment: override the master-plan LLM max_tokens "
            "for this eval run only. Ignored with --judge-artifact."
        ),
    )
    parser.add_argument(
        "--resume-report",
        type=Path,
        default=None,
        help=(
            "Resume a regular S1 suite from an existing EvalReport/partial report: "
            "completed fixture outcomes are reused and only missing fixtures run."
        ),
    )
    parser.add_argument(
        "--compare-reports",
        type=Path,
        nargs="+",
        default=None,
        help=(
            "Compare existing EvalReport JSON files and print speed/quality rows. "
            "Does not run generation or judge."
        ),
    )
    parser.add_argument(
        "--summarize-speed",
        type=Path,
        nargs="+",
        default=None,
        help=(
            "Aggregate existing EvalReport JSON files by fixture and print "
            "generation-speed stability diagnostics. Does not run LLM."
        ),
    )
    parser.add_argument(
        "--gate-report",
        type=Path,
        default=None,
        help=(
            "Compare one candidate EvalReport against a frozen baseline and "
            "fail on quality or generation-speed regressions. Does not run LLM."
        ),
    )
    parser.add_argument(
        "--llm-health-check",
        action="store_true",
        help=(
            "Make one tiny real generator-LLM call through the configured coach "
            "runtime and return 0 if available, 64 for LLM/config/capacity failure."
        ),
    )
    parser.add_argument(
        "--baseline-report",
        type=Path,
        default=None,
        help=(
            "Baseline EvalReport JSON for --gate-report or --summarize-speed. "
            "Default for --gate-report: .omc/eval/baselines/{scope}_v1.json."
        ),
    )
    parser.add_argument(
        "--allow-partial-gate",
        action="store_true",
        help=(
            "Allow --gate-report to compare only fixtures shared with the baseline. "
            "Useful for targeted diagnostics; full-suite baseline gating remains "
            "the default and should be used before freezing a baseline."
        ),
    )
    parser.add_argument(
        "--max-axis-drop",
        type=float,
        default=0.5,
        help="Max allowed axis-score drop vs baseline before gate fails (default: 0.5).",
    )
    parser.add_argument(
        "--max-suite-gen-slowdown-pct",
        type=float,
        default=25.0,
        help="Max allowed suite generator_total_s slowdown percent (default: 25).",
    )
    parser.add_argument(
        "--min-suite-gen-slowdown-s",
        type=float,
        default=60.0,
        help="Minimum suite slowdown seconds before the percent gate applies (default: 60).",
    )
    parser.add_argument(
        "--max-fixture-gen-slowdown-pct",
        type=float,
        default=50.0,
        help="Max allowed per-fixture generator_total_s slowdown percent (default: 50).",
    )
    parser.add_argument(
        "--min-fixture-gen-slowdown-s",
        type=float,
        default=120.0,
        help="Minimum fixture slowdown seconds before the percent gate applies (default: 120).",
    )
    parser.add_argument(
        "--max-iteration-increase",
        type=int,
        default=0,
        help="Max allowed generation_iterations increase per fixture (default: 0).",
    )
    parser.add_argument(
        "--max-fixture-l1-warning-increase",
        type=int,
        default=None,
        help=(
            "Optional max allowed final L1 warning count increase per fixture. "
            "Default: disabled; new warning rule types still fail."
        ),
    )
    parser.add_argument(
        "--max-fixture-gen-prompt-growth-pct",
        type=float,
        default=30.0,
        help=(
            "Max allowed per-fixture generator prompt char growth percent "
            "when prompt metadata exists (default: 30)."
        ),
    )
    parser.add_argument(
        "--min-fixture-gen-prompt-growth-chars",
        type=float,
        default=12000.0,
        help=(
            "Minimum per-fixture generator prompt char growth before the "
            "percent gate applies (default: 12000)."
        ),
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

    report_modes = [
        args.compare_reports is not None,
        args.summarize_speed is not None,
        args.gate_report is not None,
    ]
    if sum(report_modes) > 1:
        print(
            "Use only one of --compare-reports, --summarize-speed, or --gate-report.",
            file=sys.stderr,
        )
        return EXIT_FAIL
    if args.llm_health_check:
        if any(report_modes):
            print("Use --llm-health-check by itself, not with report analysis/gating.", file=sys.stderr)
            return EXIT_FAIL
        return _run_llm_health_check()
    if args.compare_reports is not None:
        return _run_compare_reports(args.compare_reports)
    if args.summarize_speed is not None:
        return _run_summarize_speed(
            args.summarize_speed,
            baseline_path=args.baseline_report,
        )
    if args.gate_report is not None:
        baseline = args.baseline_report or (
            _REPO_ROOT / ".omc" / "eval" / "baselines" / f"{args.scope}_v1.json"
        )
        return _run_gate_report(
            candidate_path=args.gate_report,
            baseline_path=baseline,
            max_axis_drop=args.max_axis_drop,
            max_suite_gen_slowdown_pct=args.max_suite_gen_slowdown_pct,
            min_suite_gen_slowdown_s=args.min_suite_gen_slowdown_s,
            max_fixture_gen_slowdown_pct=args.max_fixture_gen_slowdown_pct,
            min_fixture_gen_slowdown_s=args.min_fixture_gen_slowdown_s,
            max_iteration_increase=args.max_iteration_increase,
            max_fixture_l1_warning_increase=args.max_fixture_l1_warning_increase,
            max_fixture_gen_prompt_growth_pct=args.max_fixture_gen_prompt_growth_pct,
            min_fixture_gen_prompt_growth_chars=args.min_fixture_gen_prompt_growth_chars,
            allow_partial_gate=args.allow_partial_gate,
        )

    if args.scope == "s3":
        print("--scope s3 not implemented yet; see docs/coach-eval_S3.md", file=sys.stderr)
        return EXIT_FAIL
    if args.scope == "all":
        print("--scope all not implemented yet; specify --scope s1 or --scope s2", file=sys.stderr)
        return EXIT_FAIL
    if args.conversation and args.scope != "s1":
        print("--conversation currently supports only --scope s1", file=sys.stderr)
        return EXIT_FAIL
    if args.conversation and (
        args.judge_artifact is not None
        or args.resume_report is not None
        or args.master_max_tokens is not None
    ):
        print(
            "--conversation cannot be combined with --judge-artifact, "
            "--resume-report, or --master-max-tokens",
            file=sys.stderr,
        )
        return EXIT_FAIL
    if args.master_max_tokens is not None and args.master_max_tokens <= 0:
        print("--master-max-tokens must be a positive integer", file=sys.stderr)
        return EXIT_FAIL
    if args.resume_report is not None and args.judge_artifact is not None:
        print("--resume-report cannot be combined with --judge-artifact", file=sys.stderr)
        return EXIT_FAIL
    if args.resume_report is not None and args.layer == "L1":
        print("--resume-report cannot be combined with --layer L1", file=sys.stderr)
        return EXIT_FAIL
    if args.judge_repeat <= 0:
        print("--judge-repeat must be a positive integer", file=sys.stderr)
        return EXIT_FAIL

    if args.judge_artifact is not None:
        return _run_judge_artifact(args)
    if args.layer == "L1":
        return _run_l1_only(args)
    return _run_full(args)


def _run_judge_artifact(args: argparse.Namespace) -> int:
    """L1 + L2 against a saved generated-plan artifact, skipping generation."""
    if not args.fixture_ids or len(args.fixture_ids) != 1:
        print("--judge-artifact requires exactly one --fixture", file=sys.stderr)
        return EXIT_FAIL

    from coach_eval.runner import (
        RunMode,
        run_s1_judge_artifact_evaluation,
        run_s2_judge_artifact_evaluation,
        write_report,
    )

    mode = RunMode(args.mode)
    try:
        if args.scope == "s1":
            report = run_s1_judge_artifact_evaluation(
                mode=mode,
                fixture_id=args.fixture_ids[0],
                artifact_path=args.judge_artifact,
                judge_repeat=args.judge_repeat,
            )
        elif args.scope == "s2":
            report = run_s2_judge_artifact_evaluation(
                mode=mode,
                fixture_id=args.fixture_ids[0],
                artifact_path=args.judge_artifact,
                judge_repeat=args.judge_repeat,
                run_judge=args.layer != "L1",
            )
        else:
            print(f"--judge-artifact is not implemented for --scope {args.scope}", file=sys.stderr)
            return EXIT_FAIL
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


def _run_llm_health_check(llm: object | None = None) -> int:
    """Tiny real generator-LLM availability probe for eval runs."""
    t0: float | None = None
    try:
        if llm is None:
            from langchain_core.messages import HumanMessage, SystemMessage
            from stride_server.coach_runtime import get_generator_llm

            llm = get_generator_llm()
            messages = [
                SystemMessage(content="Reply with exactly OK."),
                HumanMessage(content="health check"),
            ]
        else:
            # Tests can pass a fake object and avoid importing LangChain.
            messages = ["system: Reply with exactly OK.", "human: health check"]

        t0 = time.monotonic()
        response = llm.invoke(messages)  # type: ignore[attr-defined]
        elapsed_s = time.monotonic() - t0
    except Exception as exc:  # noqa: BLE001 — health-check boundary
        elapsed_s = time.monotonic() - t0 if t0 is not None else None
        error = f"{type(exc).__name__}: {exc}"
        infra = "llm_transient" if _is_llm_transient_error(error) else "llm_unavailable"
        print()
        print("=== Eval LLM health check ===")
        print(f"  Status: {infra}")
        if elapsed_s is not None:
            print(f"  Latency: {elapsed_s:.1f}s")
        print(f"  Error:  {_short_error(error, max_len=220)}")
        return EXIT_LLM_UNAVAILABLE

    text = ""
    try:
        from coach.runtime.messages import extract_text

        text = extract_text(getattr(response, "content", response)).strip()
    except Exception:  # noqa: BLE001 — best-effort display only
        text = str(getattr(response, "content", response)).strip()

    print()
    print("=== Eval LLM health check ===")
    print("  Status: OK")
    print(f"  Latency: {elapsed_s:.1f}s")
    if text:
        print(f"  Response: {_short_error(text, max_len=80)}")
    return EXIT_OK


def _run_compare_reports(paths: list[Path]) -> int:
    """Print speed/quality comparison rows for existing EvalReport JSON files."""
    rows: list[dict] = []
    for path in paths:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"Could not read report {path}: {exc}", file=sys.stderr)
            return EXIT_FAIL
        for outcome in payload.get("per_fixture") or []:
            if isinstance(outcome, dict):
                rows.append(_comparison_row(path, payload, outcome))

    _print_report_comparison(rows)
    return EXIT_OK


def _comparison_row(path: Path, payload: dict, outcome: dict) -> dict:
    timings = outcome.get("timings") or {}
    judge_score = outcome.get("judge_score") or {}
    judge_summary = outcome.get("judge_summary") or {}
    judge_version = (
        judge_score.get("judge_prompt_version")
        or payload.get("judge_prompt_version")
        or "(unknown)"
    )
    axes = {
        axis.get("axis"): axis.get("score")
        for axis in (judge_score.get("axes") or [])
        if isinstance(axis, dict)
    }
    warning_rules = _l1_warning_rules(outcome)
    gen_s = timings.get("generator_total_s")
    raw_chars = timings.get("generator_raw_response_chars")
    gen_cps = (
        float(raw_chars) / float(gen_s)
        if isinstance(raw_chars, (int, float))
        and isinstance(gen_s, (int, float))
        and gen_s > 0
        else None
    )
    return {
        "report": path.stem,
        "fixture": outcome.get("fixture_id", "<unknown>"),
        "verdict": judge_score.get("overall_verdict") or "(no judge)",
        "infra": "llm_transient" if _is_llm_transient_error(outcome.get("error")) else "",
        "error": _short_error(outcome.get("error")),
        "judge_ver": judge_version,
        "judge_n": judge_summary.get("repeat") or len(outcome.get("judge_samples") or []) or 1,
        "unstable": ",".join(judge_summary.get("unstable_axes") or []),
        "iter": outcome.get("generation_iterations") or "",
        "retry_rules": _retry_rule_summary(
            timings,
            outcome.get("generation_iterations")
            if isinstance(outcome.get("generation_iterations"), int)
            else None,
        ),
        "judge_retries": timings.get("judge_retries"),
        "gen_s": gen_s,
        "gen_cps": gen_cps,
        "judge_s": timings.get("judge_s"),
        "total_s": timings.get("total_s") or timings.get("generation_total_s"),
        "generator_system_chars": timings.get("generator_system_prompt_chars"),
        "generator_user_chars": timings.get("generator_user_prompt_chars"),
        "max_tokens": timings.get("generator_max_tokens"),
        "raw_chars": raw_chars,
        "judge_system_chars": timings.get("judge_system_prompt_chars"),
        "judge_user_chars": timings.get("judge_user_prompt_chars"),
        "judge_compact_plan_chars": timings.get("judge_compact_plan_chars"),
        "judge_original_plan_chars": timings.get("judge_original_plan_chars"),
        "warnings": len(warning_rules),
        "warn_rules": ",".join(sorted(set(warning_rules))),
        "warn_counts": _format_rule_counts(warning_rules),
        "scores": axes,
        "artifact_source_report": timings.get("artifact_source_report"),
    }


def _run_summarize_speed(
    paths: list[Path], *, baseline_path: Path | None = None
) -> int:
    """Aggregate generation-speed diagnostics by fixture across reports."""
    rows: list[dict] = []
    baseline_rows: dict[str, dict] = {}
    if baseline_path is not None:
        baseline_payload = _read_eval_report(baseline_path)
        if baseline_payload is None:
            return EXIT_FAIL
        for outcome in baseline_payload.get("per_fixture") or []:
            if not isinstance(outcome, dict):
                continue
            row = _comparison_row(baseline_path, baseline_payload, outcome)
            baseline_rows[str(row.get("fixture") or "<unknown>")] = row

    for path in paths:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"Could not read report {path}: {exc}", file=sys.stderr)
            return EXIT_FAIL
        if not isinstance(payload, dict):
            print(f"Report must be a JSON object: {path}", file=sys.stderr)
            return EXIT_FAIL
        for outcome in payload.get("per_fixture") or []:
            if isinstance(outcome, dict):
                rows.append(_comparison_row(path, payload, outcome))

    _print_speed_summary(rows, baseline_rows=baseline_rows)
    return EXIT_OK


def _read_eval_report(path: Path) -> dict | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"Could not read report {path}: {exc}", file=sys.stderr)
        return None
    if not isinstance(payload, dict):
        print(f"Report must be a JSON object: {path}", file=sys.stderr)
        return None
    return payload


def _fixture_outcomes(report: dict) -> dict[str, dict]:
    outcomes: dict[str, dict] = {}
    for outcome in report.get("per_fixture") or []:
        if not isinstance(outcome, dict):
            continue
        fixture_id = outcome.get("fixture_id")
        if fixture_id:
            outcomes[str(fixture_id)] = outcome
    return outcomes


def _axis_scores(outcome: dict) -> dict[str, int | None]:
    judge_score = outcome.get("judge_score") or {}
    return {
        str(axis.get("axis")): axis.get("score")
        for axis in (judge_score.get("axes") or [])
        if isinstance(axis, dict) and axis.get("axis")
    }


def _numeric(value: object) -> float | None:
    return float(value) if isinstance(value, (int, float)) else None


def _timing(outcome: dict, key: str) -> float | None:
    return _numeric((outcome.get("timings") or {}).get(key))


def _l1_warning_rules(outcome: dict) -> list[str]:
    rules: list[str] = []
    for violation in outcome.get("l1_violations") or []:
        if not isinstance(violation, dict):
            continue
        if violation.get("severity") == "error":
            continue
        rules.append(str(violation.get("rule") or "?"))
    return rules


def _format_rule_counts(rules: list[str]) -> str:
    counts = Counter(rules)
    if not counts:
        return ""
    return ",".join(f"{rule}={count}" for rule, count in sorted(counts.items()))


def _retry_rule_summary(timings: dict, generation_iterations: int | None = None) -> str:
    """Summarize rule-filter violations that forced generator retries."""
    history = timings.get("rule_filter_history")
    if not isinstance(history, list):
        return ""
    final_iteration = generation_iterations
    chunks: list[str] = []
    for entry in history:
        if not isinstance(entry, dict):
            continue
        violations = entry.get("violations") or []
        if not isinstance(violations, list) or not violations:
            continue
        iteration = entry.get("iteration")
        prefix = f"i{iteration}" if isinstance(iteration, int) else "i?"
        retrying = final_iteration is not None and isinstance(iteration, int) and iteration < final_iteration
        rules: list[str] = []
        for violation in violations:
            if not isinstance(violation, dict):
                continue
            severity = violation.get("severity")
            if not retrying and severity != "error":
                continue
            rule = str(violation.get("rule") or "?")
            if severity:
                rule = f"{rule}({severity})"
            rules.append(rule)
        if rules:
            chunks.append(f"{prefix}:{','.join(rules)}")
    return ";".join(chunks)


def _generator_prompt_chars(outcome: dict) -> float | None:
    timings = outcome.get("timings") or {}
    system_chars = _numeric(timings.get("generator_system_prompt_chars"))
    user_chars = _numeric(timings.get("generator_user_prompt_chars"))
    if system_chars is None or user_chars is None:
        return None
    return system_chars + user_chars


def _generator_chars_per_s(outcome: dict) -> float | None:
    raw_chars = _timing(outcome, "generator_raw_response_chars")
    generator_s = _timing(outcome, "generator_total_s")
    if raw_chars is None or generator_s is None or generator_s <= 0:
        return None
    return raw_chars / generator_s


def _speed_cause(base: dict, cand: dict) -> str:
    """Best-effort diagnosis for generation speed regressions.

    This intentionally does not change gate pass/fail behavior. It only labels
    the most likely next place to look when a speed gate trips.
    """
    base_gen = _timing(base, "generator_total_s")
    cand_gen = _timing(cand, "generator_total_s")
    if base_gen is None or cand_gen is None or cand_gen <= base_gen:
        return ""

    base_iter = base.get("generation_iterations")
    cand_iter = cand.get("generation_iterations")
    if isinstance(base_iter, int) and isinstance(cand_iter, int) and cand_iter > base_iter:
        return "retry_increase"
    if _retry_rule_summary(cand.get("timings") or {}, cand_iter if isinstance(cand_iter, int) else None):
        return "rule_retry"

    base_prompt = _generator_prompt_chars(base)
    cand_prompt = _generator_prompt_chars(cand)
    prompt_delta = None if base_prompt is None or cand_prompt is None else cand_prompt - base_prompt
    prompt_pct = None if base_prompt is None or cand_prompt is None else _slowdown_pct(base_prompt, cand_prompt)

    base_raw = _timing(base, "generator_raw_response_chars")
    cand_raw = _timing(cand, "generator_raw_response_chars")
    raw_delta = None if base_raw is None or cand_raw is None else cand_raw - base_raw
    raw_pct = None if base_raw is None or cand_raw is None else _slowdown_pct(base_raw, cand_raw)

    base_cps = _generator_chars_per_s(base)
    cand_cps = _generator_chars_per_s(cand)
    cps_pct = None if base_cps is None or cand_cps is None else _slowdown_pct(base_cps, cand_cps)

    if prompt_delta is not None and prompt_pct is not None:
        if prompt_delta >= 2000 and prompt_pct >= 10.0:
            return "prompt_growth"
    if raw_delta is not None and raw_pct is not None:
        if raw_delta >= 1500 and raw_pct >= 15.0:
            return "output_growth"
    if cps_pct is not None and cps_pct <= -20.0:
        prompt_ok = prompt_pct is None or prompt_pct <= 10.0
        raw_ok = raw_pct is None or raw_pct <= 15.0
        if prompt_ok and raw_ok:
            return "throughput_drop"
        return "throughput_or_mixed"
    return "mixed_or_unknown"


def _row_as_speed_outcome(row: dict) -> dict:
    timings = {
        "generator_total_s": row.get("gen_s"),
        "generator_system_prompt_chars": row.get("generator_system_chars"),
        "generator_user_prompt_chars": row.get("generator_user_chars"),
        "generator_raw_response_chars": row.get("raw_chars"),
    }
    return {
        "generation_iterations": row.get("iter"),
        "timings": timings,
    }


def _delta_fragment(label: str, base: float | None, cand: float | None, unit: str) -> str | None:
    """Compact ``base->candidate`` fragment for gate speed diagnostics."""
    if base is None or cand is None:
        return None
    delta = cand - base
    pct = _slowdown_pct(base, cand)
    return f"{label}={base:.0f}->{cand:.0f}{unit} ({delta:+.0f}{unit}/{pct:+.1f}%)"


def _speed_context_summary(base: dict, cand: dict) -> str:
    """Explain a speed-gate failure without requiring a separate compare run."""
    parts: list[str] = []
    base_iter = base.get("generation_iterations")
    cand_iter = cand.get("generation_iterations")
    if isinstance(base_iter, int) and isinstance(cand_iter, int):
        parts.append(f"iter={base_iter}->{cand_iter}")

    retry_rules = _retry_rule_summary(
        cand.get("timings") or {},
        cand_iter if isinstance(cand_iter, int) else None,
    )
    if retry_rules:
        parts.append(f"retry_rules={retry_rules}")

    cand_judge_retries = _numeric((cand.get("timings") or {}).get("judge_retries"))
    if cand_judge_retries:
        parts.append(f"judge_retries={int(cand_judge_retries)}")

    prompt_delta = _delta_fragment(
        "prompt",
        _generator_prompt_chars(base),
        _generator_prompt_chars(cand),
        "ch",
    )
    if prompt_delta:
        parts.append(prompt_delta)

    raw_delta = _delta_fragment(
        "raw",
        _timing(base, "generator_raw_response_chars"),
        _timing(cand, "generator_raw_response_chars"),
        "ch",
    )
    if raw_delta:
        parts.append(raw_delta)

    base_cps = _generator_chars_per_s(base)
    cand_cps = _generator_chars_per_s(cand)
    if base_cps is not None and cand_cps is not None:
        parts.append(f"gen_cps={base_cps:.1f}->{cand_cps:.1f}ch/s")

    cause = _speed_cause(base, cand)
    if cause:
        parts.append(f"speed_cause={cause}")

    return "; ".join(parts) if parts else "no extra timing metadata"


def _slowdown_pct(base_s: float, candidate_s: float) -> float:
    if base_s <= 0:
        return 0.0
    return ((candidate_s - base_s) / base_s) * 100.0


def _run_gate_report(
    *,
    candidate_path: Path,
    baseline_path: Path,
    max_axis_drop: float = 0.5,
    max_suite_gen_slowdown_pct: float = 25.0,
    min_suite_gen_slowdown_s: float = 60.0,
    max_fixture_gen_slowdown_pct: float = 50.0,
    min_fixture_gen_slowdown_s: float = 120.0,
    max_iteration_increase: int = 0,
    max_fixture_l1_warning_increase: int | None = None,
    max_fixture_gen_prompt_growth_pct: float = 30.0,
    min_fixture_gen_prompt_growth_chars: float = 12000.0,
    allow_partial_gate: bool = False,
) -> int:
    """Fail a candidate report if quality or generation speed regresses."""
    baseline = _read_eval_report(baseline_path)
    candidate = _read_eval_report(candidate_path)
    if baseline is None or candidate is None:
        return EXIT_FAIL

    failures: list[str] = []
    warnings: list[str] = []
    infra_failures = _llm_transient_failure_ids(candidate)

    if infra_failures and _report_payload_only_has_llm_transient_failures(candidate):
        print()
        print("=== Eval baseline gate ===")
        print(f"  Baseline:  {baseline_path}")
        print(f"  Candidate: {candidate_path}")
        print(
            "  Candidate fixtures: "
            f"{candidate.get('fixtures_total', 0)} "
            f"(pass={candidate.get('fixtures_passed', 0)} "
            f"marginal={candidate.get('fixtures_marginal', 0)} "
            f"fail={candidate.get('fixtures_failed', 0)})"
        )
        print()
        print(
            "  INFRA FAILURE: transient LLM capacity/service error(s): "
            + ", ".join(infra_failures)
        )
        print("  Gate: INFRA_UNAVAILABLE")
        return EXIT_LLM_UNAVAILABLE

    if baseline.get("scope") != candidate.get("scope"):
        failures.append(
            f"scope mismatch: baseline={baseline.get('scope')!r}, "
            f"candidate={candidate.get('scope')!r}"
        )
    if baseline.get("mode") != candidate.get("mode"):
        failures.append(
            f"mode mismatch: baseline={baseline.get('mode')!r}, "
            f"candidate={candidate.get('mode')!r}"
        )
    if baseline.get("judge_prompt_version") != candidate.get("judge_prompt_version"):
        failures.append(
            "judge_prompt_version mismatch: "
            f"baseline={baseline.get('judge_prompt_version')!r}, "
            f"candidate={candidate.get('judge_prompt_version')!r}"
        )

    if int(candidate.get("fixtures_failed") or 0) > 0:
        failures.append(f"candidate has {candidate.get('fixtures_failed')} failed fixture(s)")
    if int(candidate.get("fixtures_marginal") or 0) > 0:
        failures.append(f"candidate has {candidate.get('fixtures_marginal')} marginal fixture(s)")

    base_outcomes = _fixture_outcomes(baseline)
    cand_outcomes = _fixture_outcomes(candidate)
    missing = sorted(set(base_outcomes) - set(cand_outcomes))
    extra = sorted(set(cand_outcomes) - set(base_outcomes))
    if missing:
        message = "candidate missing baseline fixture(s): " + ", ".join(missing)
        if allow_partial_gate:
            warnings.append(message)
        else:
            failures.append(message)
    if extra:
        warnings.append("candidate has extra fixture(s): " + ", ".join(extra))

    if allow_partial_gate and missing:
        warnings.append("partial gate: suite-level per_axis_avg gate skipped")
    else:
        base_axis_avg = baseline.get("per_axis_avg") or {}
        cand_axis_avg = candidate.get("per_axis_avg") or {}
        for axis, base_score in sorted(base_axis_avg.items()):
            cand_score = cand_axis_avg.get(axis)
            if not isinstance(base_score, (int, float)):
                continue
            if not isinstance(cand_score, (int, float)):
                failures.append(f"candidate missing per_axis_avg[{axis!r}]")
                continue
            drop = float(base_score) - float(cand_score)
            if drop >= max_axis_drop:
                failures.append(
                    f"axis average drop {axis}: baseline={base_score:.2f}, "
                    f"candidate={cand_score:.2f}, drop={drop:.2f}"
                )

    shared_fixtures = sorted(set(base_outcomes) & set(cand_outcomes))
    for fixture_id in shared_fixtures:
        base = base_outcomes[fixture_id]
        cand = cand_outcomes[fixture_id]
        cand_judge = cand.get("judge_score") or {}
        if cand.get("l1_passed") is not True:
            failures.append(f"{fixture_id}: L1 did not pass")
        if cand_judge.get("overall_verdict") != "pass":
            failures.append(
                f"{fixture_id}: verdict={cand_judge.get('overall_verdict')!r}, expected 'pass'"
            )

        base_warning_rules = _l1_warning_rules(base)
        cand_warning_rules = _l1_warning_rules(cand)
        new_warning_rules = sorted(set(cand_warning_rules) - set(base_warning_rules))
        if new_warning_rules:
            failures.append(
                f"{fixture_id}: new final L1 warning rule(s): "
                + ",".join(new_warning_rules)
            )
        warning_delta = len(cand_warning_rules) - len(base_warning_rules)
        if (
            max_fixture_l1_warning_increase is not None
            and warning_delta > max_fixture_l1_warning_increase
        ):
            failures.append(
                f"{fixture_id}: final L1 warnings increased from "
                f"{len(base_warning_rules)} to {len(cand_warning_rules)} "
                f"(delta={warning_delta}, rules="
                f"{','.join(sorted(set(cand_warning_rules))) or '-'})"
            )

        base_scores = _axis_scores(base)
        cand_scores = _axis_scores(cand)
        for axis, base_score in sorted(base_scores.items()):
            cand_score = cand_scores.get(axis)
            if base_score is None:
                continue
            if cand_score is None:
                failures.append(f"{fixture_id}: missing axis score {axis}")
                continue
            drop = float(base_score) - float(cand_score)
            if drop >= max_axis_drop:
                failures.append(
                    f"{fixture_id}: axis {axis} dropped from {base_score} "
                    f"to {cand_score} (drop={drop:.1f})"
                )

        base_iter = base.get("generation_iterations")
        cand_iter = cand.get("generation_iterations")
        if isinstance(base_iter, int) and isinstance(cand_iter, int):
            if cand_iter - base_iter > max_iteration_increase:
                retry_rules = _retry_rule_summary(
                    cand.get("timings") or {},
                    cand_iter if isinstance(cand_iter, int) else None,
                )
                retry_suffix = f"; retry_rules={retry_rules}" if retry_rules else ""
                failures.append(
                    f"{fixture_id}: generation_iterations increased from "
                    f"{base_iter} to {cand_iter}{retry_suffix}"
                )

        base_gen = _timing(base, "generator_total_s")
        cand_gen = _timing(cand, "generator_total_s")
        if base_gen is None or cand_gen is None:
            failures.append(f"{fixture_id}: missing generator_total_s timing")
            continue
        delta_s = cand_gen - base_gen
        delta_pct = _slowdown_pct(base_gen, cand_gen)
        if (
            delta_s >= min_fixture_gen_slowdown_s
            and delta_pct >= max_fixture_gen_slowdown_pct
        ):
            failures.append(
                f"{fixture_id}: generator_total_s slowed {delta_s:.1f}s "
                f"({delta_pct:.1f}%) vs baseline; "
                f"speed_context={_speed_context_summary(base, cand)}"
            )

        base_prompt_chars = _generator_prompt_chars(base)
        cand_prompt_chars = _generator_prompt_chars(cand)
        if base_prompt_chars is not None and cand_prompt_chars is not None:
            prompt_delta = cand_prompt_chars - base_prompt_chars
            prompt_delta_pct = _slowdown_pct(base_prompt_chars, cand_prompt_chars)
            if (
                prompt_delta >= min_fixture_gen_prompt_growth_chars
                and prompt_delta_pct >= max_fixture_gen_prompt_growth_pct
            ):
                failures.append(
                    f"{fixture_id}: generator prompt chars grew "
                    f"{prompt_delta:.0f}ch ({prompt_delta_pct:.1f}%) vs baseline "
                    f"(baseline={base_prompt_chars:.0f}ch, "
                    f"candidate={cand_prompt_chars:.0f}ch)"
                )
        elif base_prompt_chars is not None or cand_prompt_chars is not None:
            warnings.append(
                f"{fixture_id}: missing generator prompt char metadata for "
                "prompt-growth gate"
            )

    base_gen_values = [
        _timing(base_outcomes[fid], "generator_total_s") for fid in shared_fixtures
    ]
    cand_gen_values = [
        _timing(cand_outcomes[fid], "generator_total_s") for fid in shared_fixtures
    ]
    if allow_partial_gate and missing:
        warnings.append("partial gate: suite-level generator_total_s gate skipped")
    elif all(v is not None for v in base_gen_values + cand_gen_values):
        base_total = sum(float(v) for v in base_gen_values if v is not None)
        cand_total = sum(float(v) for v in cand_gen_values if v is not None)
        suite_delta_s = cand_total - base_total
        suite_delta_pct = _slowdown_pct(base_total, cand_total)
        if (
            suite_delta_s >= min_suite_gen_slowdown_s
            and suite_delta_pct >= max_suite_gen_slowdown_pct
        ):
            contributors: list[str] = []
            for fid in shared_fixtures:
                base_s = _timing(base_outcomes[fid], "generator_total_s")
                cand_s = _timing(cand_outcomes[fid], "generator_total_s")
                if base_s is None or cand_s is None or cand_s <= base_s:
                    continue
                contributors.append(f"{fid}+{cand_s - base_s:.1f}s")
            top_contributors = ",".join(contributors[:5]) or "none"
            failures.append(
                f"suite generator_total_s slowed {suite_delta_s:.1f}s "
                f"({suite_delta_pct:.1f}%) vs baseline; "
                f"top_contributors={top_contributors}"
            )

    print()
    print("=== Eval baseline gate ===")
    print(f"  Baseline:  {baseline_path}")
    print(f"  Candidate: {candidate_path}")
    print(
        "  Candidate fixtures: "
        f"{candidate.get('fixtures_total', 0)} "
        f"(pass={candidate.get('fixtures_passed', 0)} "
        f"marginal={candidate.get('fixtures_marginal', 0)} "
        f"fail={candidate.get('fixtures_failed', 0)})"
    )
    print(f"  Shared fixtures: {len(shared_fixtures)}")
    if failures:
        print()
        print("  FAILURES:")
        for failure in failures:
            print(f"    - {failure}")
    if warnings:
        print()
        print("  WARNINGS:")
        for warning in warnings:
            print(f"    - {warning}")
    print()
    print("  Gate: " + ("FAIL" if failures else "PASS"))
    return EXIT_FAIL if failures else EXIT_OK


def _fmt_num(value: object, *, decimals: int = 1, empty: str = "-") -> str:
    if isinstance(value, (int, float)):
        return f"{float(value):.{decimals}f}"
    return empty


def _fmt_int(value: object, *, empty: str = "-") -> str:
    if isinstance(value, (int, float)):
        return str(int(value))
    return empty


def _median(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2


def _range_fragment(values: list[float], *, unit: str = "") -> str:
    if not values:
        return "-"
    low = min(values)
    high = max(values)
    med = _median(values)
    if med is None:
        return "-"
    if low == high:
        return f"{low:.1f}{unit}"
    return f"{low:.1f}-{high:.1f}{unit} med={med:.1f}{unit}"


def _report_fixture_label(row: dict) -> str:
    return f"{row.get('report')}:{row.get('fixture')}"


def _delta_num_fragment(base: float | None, value: float | None, *, unit: str = "") -> str:
    if base is None or value is None:
        return "-"
    delta = value - base
    pct = _slowdown_pct(base, value)
    return f"{value:.1f}{unit} ({delta:+.1f}{unit}/{pct:+.1f}%)"


def _fmt_unit(value: float | None, *, unit: str = "") -> str:
    return f"{value:.1f}{unit}" if value is not None else "-"


def _print_speed_summary(
    rows: list[dict], *, baseline_rows: dict[str, dict] | None = None
) -> None:
    print()
    print("=== Eval speed summary ===")
    if not rows:
        print("(no fixture outcomes)")
        return
    baseline_rows = baseline_rows or {}

    grouped: dict[str, list[dict]] = {}
    for row in rows:
        grouped.setdefault(str(row.get("fixture") or "<unknown>"), []).append(row)

    summary_rows: list[list[str]] = []
    for fixture, fixture_rows in sorted(grouped.items()):
        fresh_rows = [
            row for row in fixture_rows
            if isinstance(row.get("gen_s"), (int, float))
            and not row.get("artifact_source_report")
        ]
        replay_rows = [row for row in fixture_rows if row.get("artifact_source_report")]
        gen_values = [float(row["gen_s"]) for row in fresh_rows]
        cps_values = [
            float(row["gen_cps"])
            for row in fresh_rows
            if isinstance(row.get("gen_cps"), (int, float))
        ]
        raw_values = [
            float(row["raw_chars"])
            for row in fresh_rows
            if isinstance(row.get("raw_chars"), (int, float))
        ]
        prompt_values = [
            float(row["generator_system_chars"] + row["generator_user_chars"])
            for row in fresh_rows
            if isinstance(row.get("generator_system_chars"), (int, float))
            and isinstance(row.get("generator_user_chars"), (int, float))
        ]
        judge_retry_values = [
            int(row["judge_retries"])
            for row in fixture_rows
            if isinstance(row.get("judge_retries"), (int, float))
        ]
        iterations = [
            int(row["iter"])
            for row in fresh_rows
            if isinstance(row.get("iter"), int)
        ]
        verdict_counts = Counter(str(row.get("verdict") or "(unknown)") for row in fixture_rows)
        infra_count = sum(1 for row in fixture_rows if row.get("infra"))
        score_values = [
            score
            for row in fixture_rows
            for score in (row.get("scores") or {}).values()
            if isinstance(score, int)
        ]
        min_score = min(score_values) if score_values else None
        score_range = (
            f"{min(score_values)}-{max(score_values)}"
            if score_values and min(score_values) != max(score_values)
            else (str(min_score) if min_score is not None else "-")
        )
        fastest = min(fresh_rows, key=lambda row: float(row["gen_s"])) if gen_values else None
        slowest = max(fresh_rows, key=lambda row: float(row["gen_s"])) if gen_values else None
        latest = fresh_rows[-1] if fresh_rows else None
        spread = max(gen_values) - min(gen_values) if gen_values else None
        baseline = baseline_rows.get(fixture)
        base_gen = float(baseline["gen_s"]) if baseline and isinstance(baseline.get("gen_s"), (int, float)) else None
        base_cps = float(baseline["gen_cps"]) if baseline and isinstance(baseline.get("gen_cps"), (int, float)) else None
        latest_gen = float(latest["gen_s"]) if latest and isinstance(latest.get("gen_s"), (int, float)) else None
        latest_cps = float(latest["gen_cps"]) if latest and isinstance(latest.get("gen_cps"), (int, float)) else None
        speed_cause = (
            _speed_cause(_row_as_speed_outcome(baseline), _row_as_speed_outcome(latest))
            if baseline and latest
            else ""
        )

        summary_rows.append([
            fixture,
            str(len(fixture_rows)),
            str(len(fresh_rows)),
            str(len(replay_rows)),
            ",".join(f"{k}:{v}" for k, v in sorted(verdict_counts.items())),
            str(infra_count),
            score_range,
            _range_fragment(gen_values, unit="s"),
            _fmt_num(spread),
            _range_fragment(cps_values, unit="ch/s"),
            _range_fragment(raw_values, unit="ch"),
            _range_fragment(prompt_values, unit="ch"),
            _range_fragment([float(v) for v in iterations]),
            _fmt_num(base_gen),
            _delta_num_fragment(base_gen, latest_gen, unit="s"),
            _fmt_unit(base_cps, unit="ch/s"),
            _delta_num_fragment(base_cps, latest_cps, unit="ch/s"),
            speed_cause or "-",
            str(max(judge_retry_values) if judge_retry_values else "-"),
            _report_fixture_label(fastest) if fastest else "-",
            _report_fixture_label(slowest) if slowest else "-",
        ])

    headers = [
        "fixture", "reports", "fresh", "replay", "verdicts", "infra", "score",
        "gen_s", "spread_s", "gen_cps", "raw", "prompt", "iter", "base_gen",
        "latest_vs_base", "base_cps", "latest_cps_vs_base", "speed_cause", "max_jretry", "fastest", "slowest",
    ]
    widths = [len(h) for h in headers]
    for row in summary_rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(cell))

    def _line(cells: list[str]) -> str:
        return "  " + "  ".join(cell.ljust(widths[i]) for i, cell in enumerate(cells))

    print(_line(headers))
    print(_line(["-" * width for width in widths]))
    for row in summary_rows:
        print(_line(row))


def _print_report_comparison(rows: list[dict]) -> None:
    print()
    print("=== Eval report comparison ===")
    if not rows:
        print("(no fixture outcomes)")
        return
    judge_versions = sorted({str(row.get("judge_ver") or "(unknown)") for row in rows})
    if len(judge_versions) > 1:
        print(
            "Warning: mixed judge_prompt_version values "
            f"({', '.join(judge_versions)}); L2 axis scores are not directly comparable."
        )
    axes = sorted({axis for row in rows for axis in (row.get("scores") or {})})
    base_cols = [
        "report", "fixture", "verdict", "infra", "error", "judge_ver", "judge_n", "unstable",
        "iter", "retry_rules", "judge_retry", "gen_s", "gen_cps", "judge_s", "total_s", "gsys", "guser", "max", "raw",
        "jsys", "juser", "jplan", "jorig", "warn", "warn_rules", "warn_counts",
    ]
    table_rows: list[list[str]] = []
    for row in rows:
        scores = row.get("scores") or {}
        table_rows.append([
            str(row["report"]),
            str(row["fixture"]),
            str(row["verdict"]),
            str(row.get("infra") or "-"),
            str(row.get("error") or "-"),
            str(row.get("judge_ver") or "(unknown)"),
            str(row.get("judge_n") or 1),
            str(row.get("unstable") or "-"),
            str(row["iter"]),
            str(row.get("retry_rules") or "-"),
            _fmt_int(row.get("judge_retries")),
            _fmt_num(row.get("gen_s")),
            _fmt_num(row.get("gen_cps")),
            _fmt_num(row.get("judge_s")),
            _fmt_num(row.get("total_s")),
            _fmt_int(row.get("generator_system_chars")),
            _fmt_int(row.get("generator_user_chars")),
            _fmt_int(row.get("max_tokens")),
            _fmt_int(row.get("raw_chars")),
            _fmt_int(row.get("judge_system_chars")),
            _fmt_int(row.get("judge_user_chars")),
            _fmt_int(row.get("judge_compact_plan_chars")),
            _fmt_int(row.get("judge_original_plan_chars")),
            str(row.get("warnings", 0)),
            str(row.get("warn_rules") or "-"),
            str(row.get("warn_counts") or "-"),
            *[str(scores.get(axis, "-")) for axis in axes],
        ])
    headers = base_cols + axes
    widths = [len(h) for h in headers]
    for row in table_rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(cell))

    def _line(cells: list[str]) -> str:
        return "  " + "  ".join(cell.ljust(widths[i]) for i, cell in enumerate(cells))

    print(_line(headers))
    print(_line(["-" * w for w in widths]))
    for row in table_rows:
        print(_line(row))


def _run_full(args: argparse.Namespace) -> int:
    """L1 + L2 (full eval with LLM judge)."""
    from coach_eval.runner import (
        RunMode,
        run_s1_conversation_evaluation,
        run_s1_evaluation,
        run_s2_evaluation,
        write_report,
    )

    mode = RunMode(args.mode)

    try:
        if args.scope == "s1":
            if args.conversation:
                report = run_s1_conversation_evaluation(
                    fixture_ids=args.fixture_ids
                )
            else:
                report = run_s1_evaluation(
                    mode=mode,
                    fixture_ids=args.fixture_ids,
                    master_max_tokens=args.master_max_tokens,
                    resume_report_path=args.resume_report,
                )
        elif args.scope == "s2":
            report = run_s2_evaluation(
                mode=mode,
                fixture_ids=args.fixture_ids,
                resume_report_path=args.resume_report,
            )
        else:
            print(f"--scope {args.scope} not implemented", file=sys.stderr)
            return EXIT_FAIL
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
    if args.conversation:
        # Conversation fixtures already use deterministic contract scoring
        # (no separate L2 judge), though concrete cases still need the Agent LLM.
        return _run_full(args)
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
            infra = ""
            if _is_llm_transient_error(o.error):
                infra = "  infra=llm_transient"
            total_s = o.timings.get("total_s") or o.timings.get("generation_total_s")
            timing = f"  {float(total_s):.1f}s" if isinstance(total_s, (int, float)) else ""
            gen_s = o.timings.get("generator_total_s")
            judge_s = o.timings.get("judge_s")
            generator_system_chars = o.timings.get("generator_system_prompt_chars")
            generator_user_chars = o.timings.get("generator_user_prompt_chars")
            max_tokens = o.timings.get("generator_max_tokens")
            raw_chars = o.timings.get("generator_raw_response_chars")
            judge_user_chars = o.timings.get("judge_user_prompt_chars")
            judge_compact_plan_chars = o.timings.get("judge_compact_plan_chars")
            speed_bits: list[str] = []
            if isinstance(gen_s, (int, float)):
                speed_bits.append(f"gen={float(gen_s):.1f}s")
            if isinstance(judge_s, (int, float)):
                speed_bits.append(f"judge={float(judge_s):.1f}s")
            if isinstance(generator_system_chars, (int, float)):
                speed_bits.append(f"gsys={int(generator_system_chars)}ch")
            if isinstance(generator_user_chars, (int, float)):
                speed_bits.append(f"guser={int(generator_user_chars)}ch")
            if isinstance(raw_chars, (int, float)):
                speed_bits.append(f"raw={int(raw_chars)}ch")
            if isinstance(max_tokens, (int, float)):
                speed_bits.append(f"max={int(max_tokens)}")
            if isinstance(judge_user_chars, (int, float)):
                speed_bits.append(f"juser={int(judge_user_chars)}ch")
            if isinstance(judge_compact_plan_chars, (int, float)):
                speed_bits.append(f"jplan={int(judge_compact_plan_chars)}ch")
            speed = "  " + " ".join(speed_bits) if speed_bits else ""
            repeat = ""
            if o.judge_summary:
                unstable = ",".join(o.judge_summary.get("unstable_axes") or []) or "none"
                repeat = f"  judge_n={o.judge_summary.get('repeat')} unstable={unstable}"
            iters = f"  iter={o.generation_iterations}" if o.generation_iterations else ""
            err = f"  [error: {o.error}]" if o.error else ""
            print(f"    {o.fixture_id:<40}  L1={l1:<5}  verdict={verdict}{iters}{timing}{speed}{repeat}{infra}{err}")
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
            f"- generation_iterations: `{o.generation_iterations}`",
            f"- timings: `{o.timings}`",
        ]
        if o.generated_artifact:
            lines.append("- generated_artifact: embedded in EvalReport JSON and written under `.omc/eval/reports/<run>/artifacts/`")
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
    if _report_only_has_llm_transient_failures(report):
        return EXIT_LLM_UNAVAILABLE
    if report.fixtures_failed > 0:
        return EXIT_FAIL
    if report.fixtures_marginal > 0:
        return EXIT_MARGINAL
    return EXIT_OK


def _is_llm_transient_error(error: object) -> bool:
    if not isinstance(error, str) or not error:
        return False
    msg = error.lower()
    return any(marker in msg for marker in _LLM_TRANSIENT_ERROR_MARKERS)


def _short_error(error: object, *, max_len: int = 90) -> str:
    if not isinstance(error, str) or not error:
        return ""
    compact = " ".join(error.split())
    if len(compact) <= max_len:
        return compact
    return compact[: max_len - 1] + "…"


def _llm_transient_failure_ids(report: dict) -> list[str]:
    ids: list[str] = []
    for outcome in report.get("per_fixture") or []:
        if not isinstance(outcome, dict):
            continue
        if _is_llm_transient_error(outcome.get("error")):
            ids.append(str(outcome.get("fixture_id") or "<unknown>"))
    return ids


def _report_payload_only_has_llm_transient_failures(report: dict) -> bool:
    outcomes = [outcome for outcome in (report.get("per_fixture") or []) if isinstance(outcome, dict)]
    if not outcomes:
        return False
    saw_transient = False
    for outcome in outcomes:
        if _is_llm_transient_error(outcome.get("error")):
            saw_transient = True
            continue
        if outcome.get("error"):
            return False
        judge_score = outcome.get("judge_score") or {}
        if judge_score.get("overall_verdict") != "pass":
            return False
    return saw_transient


def _report_only_has_llm_transient_failures(report) -> bool:
    outcomes = list(getattr(report, "per_fixture", []) or [])
    if not outcomes:
        return False
    saw_transient = False
    for outcome in outcomes:
        if _is_llm_transient_error(getattr(outcome, "error", None)):
            saw_transient = True
            continue
        if getattr(outcome, "error", None):
            return False
        judge_score = getattr(outcome, "judge_score", None)
        if judge_score is None:
            return False
        if getattr(judge_score, "overall_verdict", None) != "pass":
            return False
    if not saw_transient:
        return False
    return True


if __name__ == "__main__":
    sys.exit(main())
