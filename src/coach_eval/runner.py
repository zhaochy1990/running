"""Offline coach evaluation runner — see ``docs/coach-eval.md``.

Bridges fixtures to the coach eval pipeline:

* Loads fixtures from ``tests/fixtures/coach_eval/{scope}/*.json``.
* For S1: builds the gen graph in one of two modes:
    - ``frozen_fixture`` — load_context returns fixture's inline data, no DB query
    - ``live_local_db`` — uses the real :func:`load_master_context` (queries SQLite)
* Constructs the judge LLM via :mod:`stride_server.coach_runtime`
  (GPT-5.4 generator LLM is reused as judge — different model from the
  Claude Opus reviewer to avoid self-bias).
* Runs the eval suite.
* Writes ``EvalReport`` as JSON + markdown to ``.omc/eval/reports/``.

v1 wires S1 only. ``run_s2_evaluation`` / ``run_s3_evaluation`` are
placeholders that raise ``NotImplementedError`` until those scopes are
implemented (Phase 2 / Phase 3 — see ``docs/coach-eval_S{2,3}.md``).

Layered imports:

* ``coach.*`` for the generation graph + master_rule_filter (production
  pipeline that eval composes on top of).
* ``stride_server.*`` for the master_plan adapter + LLM factories
  (production runtime that knows how to wire DB / auth / config).
* ``.graph`` / ``.judge_s1`` / ``.schemas`` for eval-internal pieces.

The reverse direction is FORBIDDEN by ``.importlinter`` — ``coach.*`` and
``stride_server.*`` MUST NOT import from ``coach_eval.*``.
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
import time
from collections.abc import Callable
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any

from coach.graphs.generation.graph import build_generation_graph
from coach.graphs.generation.master_rule_filter import run_master_rule_filter
from stride_server.coach_adapters.master_plan_adapter import (
    apply_master_patches,
    generate_master_plan,
    load_master_context,
    master_reviewer,
)
from stride_server.master_plan_generator import _format_history_summary

from .graph import call_judge_with_retries, run_evaluation_for_fixture
from .judge_s1 import JUDGE_PROMPT_VERSION as S1_JUDGE_VERSION
from .judge_s1 import build_s1_judge_prompt_metadata, make_s1_judge
from .schemas import AxisScore, EvalReport, FixtureRunOutcome, JudgeScore, aggregate_axis_avg

logger = logging.getLogger(__name__)


REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_DIR = REPO_ROOT / "tests" / "fixtures" / "coach_eval"
REPORT_DIR = REPO_ROOT / ".omc" / "eval" / "reports"

_ARTIFACT_SOURCE_TIMING_KEYS = (
    "load_context_s",
    "generator_attempt_s",
    "generator_total_s",
    "generator_system_prompt_chars",
    "generator_user_prompt_chars",
    "generator_max_tokens",
    "generator_raw_response_chars",
    "reviewer_s",
    "generation_total_s",
    "rule_filter_history",
)


class RunMode(str, Enum):
    LIVE_LOCAL_DB = "live_local_db"
    FROZEN_FIXTURE = "frozen_fixture"


# ---------------------------------------------------------------------------
# Fixture loading
# ---------------------------------------------------------------------------


def load_fixtures(scope: str, fixture_ids: list[str] | None = None) -> list[dict]:
    """Load fixtures from ``tests/fixtures/coach_eval/{scope}/*.json``.

    If ``fixture_ids`` is given, filter to those (by their ``fixture_id``
    field, not file basename). Returns sorted by fixture_id for stable
    report ordering.
    """
    scope_dir = FIXTURE_DIR / scope
    if not scope_dir.exists():
        return []

    out: list[dict] = []
    for fp in sorted(scope_dir.glob("*.json")):
        try:
            with open(fp, encoding="utf-8") as f:
                fixture = json.load(f)
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("skipping malformed fixture %s: %s", fp.name, exc)
            continue
        fid = fixture.get("fixture_id")
        if fixture_ids and fid not in fixture_ids:
            continue
        out.append(fixture)
    return out


# ---------------------------------------------------------------------------
# Frozen-fixture mode: fixture-derived context (bypass DB query)
# ---------------------------------------------------------------------------


def _fixture_to_history_dict(fixture_input: dict) -> dict:
    """Map fixture.training_history_summary + user_profile.prs → the dict
    shape :func:`_query_history` would return."""
    ths = fixture_input.get("training_history_summary") or {}
    prs = (fixture_input.get("user_profile") or {}).get("prs") or {}

    monthly_arr = ths.get("monthly_mileage_km") or []
    monthly_km = [
        {"month": f"M-{i}", "km": round(float(km or 0), 1)}
        for i, km in enumerate(monthly_arr)
    ]
    race_history = ths.get("race_history") or []

    return {
        "monthly_km": monthly_km,
        "weekly_profile": ths.get("weekly_profile") or [],
        "max_weekly_km": float(ths.get("peak_weekly_km_in_window") or 0),
        "total_activities": int(len(race_history) + len(monthly_km) * 4),  # rough proxy
        "best_5k_s": prs.get("5k_s"),
        "best_10k_s": prs.get("10k_s"),
        "best_hm_s": prs.get("hm_s"),
        "best_fm_s": prs.get("fm_s"),
    }


def _fixture_to_fitness_state() -> dict:
    """Synthesize empty fitness state (S1 fixture spec has no live HRV/CTL).

    S1 doesn't take HRV/CTL signals into account anyway (strategic / monthly
    scale — daily signals are S2's responsibility). Returning a stub avoids
    plumbing fake values that the prompt then has to mention.
    """
    return {
        "ctl": None,
        "atl": None,
        "tsb": None,
        "rhr": None,
        "summary": "(frozen_fixture mode: no live HRV/CTL signals — S1 is strategic/monthly scale)",
    }


def _make_frozen_load_context(fixture: dict) -> Callable[[dict], dict]:
    """Closure: returns a ``load_context`` callable bound to this fixture."""
    fixture_input = fixture.get("input") or {}
    history = _fixture_to_history_dict(fixture_input)
    history_summary = _format_history_summary(history)
    fitness_state = fixture_input.get("fitness_state") or _fixture_to_fitness_state()

    def load_ctx(_state: dict) -> dict:
        ctx = {
            "history": history,
            "history_summary": history_summary,
            "fitness_state": fitness_state,
        }
        for key in (
            "continuity",
            "current_phase",
            "body_composition",
            "body_composition_summary",
            "prev_master_plan_md",
        ):
            if fixture_input.get(key) is not None:
                ctx[key] = fixture_input[key]
        return ctx

    return load_ctx


# ---------------------------------------------------------------------------
# S1 initial state builder
# ---------------------------------------------------------------------------


def _build_s1_initial_state(
    fixture: dict, *, master_max_tokens: int | None = None
) -> dict:
    """Synthesize the GenState shape the master adapter expects."""
    fixture_input = fixture.get("input") or {}
    user_profile = fixture_input.get("user_profile") or {}
    target_race = user_profile.get("target_race") or {}
    season_window = fixture_input.get("season_window") or {}

    goal = {
        "id": fixture.get("fixture_id"),
        "race_date": target_race.get("race_date"),
        "race_type": target_race.get("distance"),
        "distance": target_race.get("distance"),
        "goal_time_s": target_race.get("goal_time_s"),
        "season_start": season_window.get("start_date"),
        "season_end": season_window.get("end_date"),
        "as_of_date": fixture_input.get("as_of_date") or season_window.get("start_date"),
    }
    prev_master_plan_md = fixture_input.get("prev_master_plan_md")
    profile = {
        "hr_zones": user_profile.get("hr_zones"),
        "prs": user_profile.get("prs"),
        "weekly_run_days_max": user_profile.get("weekly_run_days_max"),
        "experience_level": user_profile.get("experience_level"),
        "weight_kg": user_profile.get("weight_kg"),
        "injuries": user_profile.get("injuries"),
        "user_intent_md": fixture_input.get("user_intent_md"),
    }
    if prev_master_plan_md:
        profile["prev_master_plan_md"] = prev_master_plan_md
    state = {
        "job_id": "",  # No job — eval is direct
        "user_id": user_profile.get("user_id") or "eval-fixture-user",
        "plan_type": "master",
        "input_payload": {"goal": goal, "profile": profile},
    }
    if master_max_tokens is not None:
        state["runtime_options"] = {"master_max_tokens": master_max_tokens}
    return state


def _s1_rule_filter_kwargs(fixture: dict) -> dict:
    """Extract input-aware S1 rule-filter kwargs from a fixture."""
    finput = fixture.get("input") or {}
    fprofile = finput.get("user_profile") or {}
    rfk: dict = {}
    if fprofile.get("target_race"):
        rfk["target_race"] = fprofile["target_race"]
    if fprofile.get("prs"):
        rfk["prs"] = fprofile["prs"]
    if finput.get("season_window"):
        rfk["season_window"] = finput["season_window"]
    if fprofile.get("weekly_run_days_max") is not None:
        rfk["weekly_run_days_max"] = fprofile["weekly_run_days_max"]
    if fprofile.get("injuries") is not None:
        rfk["injuries"] = fprofile["injuries"]
    if finput.get("training_history_summary") is not None:
        rfk["training_history_summary"] = finput["training_history_summary"]
    return rfk


# ---------------------------------------------------------------------------
# S1 runner
# ---------------------------------------------------------------------------


def run_s1_evaluation(
    *,
    mode: RunMode,
    fixture_ids: list[str] | None = None,
    judge_llm: Any | None = None,
    master_max_tokens: int | None = None,
    checkpoint: bool = True,
    resume_report_path: Path | None = None,
) -> EvalReport:
    """Run S1 evaluation suite end-to-end.

    Args:
        mode: ``LIVE_LOCAL_DB`` (queries DB) or ``FROZEN_FIXTURE`` (fixture inline).
        fixture_ids: subset to run; ``None`` runs all S1 fixtures.
        judge_llm: langchain ``BaseChatModel`` for judge. ``None`` builds
            via :func:`stride_server.coach_runtime.get_generator_llm`
            (GPT-5.4 — different from Claude Opus reviewer to avoid bias).
    """
    fixtures = load_fixtures("s1", fixture_ids)
    if not fixtures:
        logger.warning("No S1 fixtures matched (scope=s1, ids=%s)", fixture_ids)
        return _build_report("s1", mode, [], judge_prompt_version=S1_JUDGE_VERSION)

    if judge_llm is None:
        # Lazy import so unit tests can build the runner without LLM config.
        from stride_server.coach_runtime import get_generator_llm

        judge_llm = get_generator_llm()
    judge = make_s1_judge(judge_llm)

    resumed_outcomes, resumed_run_id = _load_resume_outcomes(
        resume_report_path,
        mode=mode,
        judge_prompt_version=S1_JUDGE_VERSION,
    )
    outcomes: list[FixtureRunOutcome] = []
    run_id = resumed_run_id or _new_run_id()
    for i, fixture in enumerate(fixtures, start=1):
        fid = fixture.get("fixture_id", f"<idx={i}>")
        resumed = resumed_outcomes.get(str(fid))
        if resumed is not None:
            logger.info(
                "S1 eval [%d/%d] mode=%s id=%s — resumed from %s",
                i,
                len(fixtures),
                mode.value,
                fid,
                resume_report_path,
            )
            outcomes.append(resumed)
            if checkpoint:
                partial_report = _build_report(
                    "s1",
                    mode,
                    outcomes,
                    judge_prompt_version=S1_JUDGE_VERSION,
                    run_id=f"{run_id}.partial",
                )
                write_report(partial_report)
            continue
        logger.info("S1 eval [%d/%d] mode=%s id=%s", i, len(fixtures), mode.value, fid)

        if mode == RunMode.FROZEN_FIXTURE:
            load_ctx = _make_frozen_load_context(fixture)
        else:
            load_ctx = load_master_context

        # Extract input-aware rule_filter kwargs from the fixture so the
        # input-aware L1 checks (season_window_fits / goal_realism /
        # target_distance_long_run / key_session_density) have data to
        # evaluate. No-op for fixtures lacking a given field.
        rfk = _s1_rule_filter_kwargs(fixture)

        gen_graph = build_generation_graph(
            load_context=load_ctx,
            generator=generate_master_plan,
            reviewer=master_reviewer,
            apply_patches=apply_master_patches,
            rule_filter=run_master_rule_filter,
            rule_filter_kwargs=rfk,
        )

        outcome = run_evaluation_for_fixture(
            fixture=fixture,
            gen_graph=gen_graph,
            judge=judge,
            initial_state_builder=lambda f, cap=master_max_tokens: _build_s1_initial_state(
                f, master_max_tokens=cap
            ),
            judge_prompt_metadata_builder=build_s1_judge_prompt_metadata,
        )
        outcomes.append(outcome)
        if checkpoint:
            partial_report = _build_report(
                "s1",
                mode,
                outcomes,
                judge_prompt_version=S1_JUDGE_VERSION,
                run_id=f"{run_id}.partial",
            )
            write_report(partial_report)

    report = _build_report(
        "s1", mode, outcomes, judge_prompt_version=S1_JUDGE_VERSION, run_id=run_id
    )
    return report


def run_s1_judge_artifact_evaluation(
    *,
    mode: RunMode,
    fixture_id: str,
    artifact_path: Path,
    judge_llm: Any | None = None,
    judge_repeat: int = 1,
) -> EvalReport:
    """Run S1 L1 + L2 against an existing generated MasterPlan JSON artifact.

    This is the cheap loop for judge/rubric iteration: it reuses the frozen
    fixture expectation and the saved generated plan, so it skips the expensive
    generator call entirely.
    """
    fixtures = load_fixtures("s1", [fixture_id])
    if not fixtures:
        raise ValueError(f"No S1 fixture matched fixture_id={fixture_id!r}")
    fixture = fixtures[0]

    try:
        with open(artifact_path, encoding="utf-8") as f:
            generated_plan = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"Could not read generated artifact {artifact_path}: {exc}") from exc
    if not isinstance(generated_plan, dict):
        raise ValueError(f"Generated artifact must be a JSON object: {artifact_path}")

    rfk = _s1_rule_filter_kwargs(fixture)
    source_timings, source_generation_iterations = _artifact_source_generation_metadata(
        artifact_path,
        fixture_id=fixture_id,
        generated_plan=generated_plan,
    )

    l1_t0 = time.monotonic()
    l1_report = run_master_rule_filter(generated_plan, **rfk)
    timings: dict[str, Any] = dict(source_timings)
    timings.update({
        "rule_filter_s": [time.monotonic() - l1_t0]
    })
    l1_violations = [
        {
            "rule": v.rule,
            "severity": v.severity,
            "message": v.message,
            "details": v.details,
        }
        for v in l1_report.violations
    ]

    if not l1_report.ok:
        outcome = FixtureRunOutcome(
            fixture_id=fixture_id,
            scope="s1",
            l1_passed=False,
            l1_violations=l1_violations,
            generated_artifact=generated_plan,
            generation_iterations=source_generation_iterations,
            timings=timings,
        )
        return _build_report("s1", mode, [outcome], judge_prompt_version=S1_JUDGE_VERSION)

    if judge_repeat <= 0:
        raise ValueError("judge_repeat must be a positive integer")

    if judge_llm is None:
        from stride_server.coach_runtime import get_generator_llm

        judge_llm = get_generator_llm()
    judge = make_s1_judge(judge_llm)

    judge_samples: list[JudgeScore] = []
    judge_attempt_s: list[float] = []
    judge_retries = 0
    timings.update(build_s1_judge_prompt_metadata(generated_plan, fixture))
    try:
        for _ in range(judge_repeat):
            sample, sample_timings = call_judge_with_retries(
                judge,
                generated_plan,
                fixture,
                fixture_id=fixture_id,
            )
            judge_samples.append(sample)
            judge_attempt_s.extend(sample_timings.get("judge_attempt_s") or [])
            judge_retries += int(sample_timings.get("judge_retries") or 0)
    except Exception as exc:  # noqa: BLE001 - eval boundary
        logger.warning("eval fixture=%s judge failed: %s", fixture_id, exc)
        if judge_attempt_s:
            timings["judge_attempt_s"] = judge_attempt_s
            timings["judge_retries"] = judge_retries
            timings["judge_s"] = sum(judge_attempt_s)
            timings["total_s"] = float(timings["judge_s"]) + sum(timings["rule_filter_s"])
        outcome = FixtureRunOutcome(
            fixture_id=fixture_id,
            scope="s1",
            l1_passed=True,
            l1_violations=l1_violations,
            generated_artifact=generated_plan,
            generation_iterations=source_generation_iterations,
            timings=timings,
            judge_samples=judge_samples if judge_repeat > 1 else [],
            judge_summary=_judge_variance_summary(judge_samples)
            if len(judge_samples) > 1
            else {},
            error=f"judge_failed: {type(exc).__name__}: {exc}",
            debug={"exception_type": type(exc).__name__},
        )
        return _build_report("s1", mode, [outcome], judge_prompt_version=S1_JUDGE_VERSION)
    judge_score = _summarize_judge_samples(judge_samples)
    timings["judge_attempt_s"] = judge_attempt_s
    timings["judge_retries"] = judge_retries
    timings["judge_s"] = sum(judge_attempt_s)
    timings["total_s"] = float(timings["judge_s"]) + sum(timings["rule_filter_s"])

    outcome = FixtureRunOutcome(
        fixture_id=fixture_id,
        scope="s1",
        l1_passed=True,
        l1_violations=l1_violations,
        generated_artifact=generated_plan,
        generation_iterations=source_generation_iterations,
        timings=timings,
        judge_score=judge_score,
        judge_samples=judge_samples if judge_repeat > 1 else [],
        judge_summary=_judge_variance_summary(judge_samples) if judge_repeat > 1 else {},
    )
    return _build_report("s1", mode, [outcome], judge_prompt_version=S1_JUDGE_VERSION)


def _artifact_source_generation_metadata(
    artifact_path: Path,
    *,
    fixture_id: str,
    generated_plan: dict,
) -> tuple[dict[str, Any], int | None]:
    """Recover generation timings from the full report that wrote an artifact.

    ``--judge-artifact`` skips generation, but artifacts written by
    ``write_report`` live beside the original EvalReport JSON. When the saved
    artifact exactly matches that embedded report artifact, we can keep the
    generation-side speed diagnostics without re-running the generator.
    """
    report_path = _artifact_source_report_path(artifact_path)
    if report_path is None:
        return {}, None

    try:
        payload = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("could not read source eval report for artifact %s: %s", artifact_path, exc)
        return {}, None
    if not isinstance(payload, dict):
        return {}, None

    source_outcome: dict[str, Any] | None = None
    for outcome in payload.get("per_fixture") or []:
        if isinstance(outcome, dict) and outcome.get("fixture_id") == fixture_id:
            source_outcome = outcome
            break
    if source_outcome is None:
        return {}, None
    if source_outcome.get("generated_artifact") != generated_plan:
        logger.warning(
            "source eval report %s fixture=%s artifact does not match %s; skipping timing backfill",
            report_path,
            fixture_id,
            artifact_path,
        )
        return {}, None

    source_raw_timings = source_outcome.get("timings") or {}
    if not isinstance(source_raw_timings, dict):
        return {}, None

    timings = {
        key: source_raw_timings[key]
        for key in _ARTIFACT_SOURCE_TIMING_KEYS
        if key in source_raw_timings
    }
    if timings:
        timings["artifact_source_report"] = _display_path(report_path)

    iterations = source_outcome.get("generation_iterations")
    generation_iterations = iterations if isinstance(iterations, int) else None
    return timings, generation_iterations


def _artifact_source_report_path(artifact_path: Path) -> Path | None:
    try:
        resolved_artifact = artifact_path.resolve()
        reports_dir = REPORT_DIR.resolve()
    except OSError:
        return None
    if resolved_artifact.parent.name != "artifacts":
        return None
    run_dir = resolved_artifact.parent.parent
    if run_dir.parent != reports_dir:
        return None
    report_path = reports_dir / f"{run_dir.name}.json"
    return report_path if report_path.exists() else None


def _display_path(path: Path) -> str:
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def _summarize_judge_samples(samples: list[JudgeScore]) -> JudgeScore:
    """Return a conservative aggregate for repeated judge calls.

    Axis score = minimum non-null score across samples. Verdict follows the
    worst sample verdict. Rationale concatenates the rationales that produced
    the minimum score so report consumers can see why the conservative score
    was selected.
    """
    if not samples:
        raise ValueError("judge samples must not be empty")
    if len(samples) == 1:
        return samples[0]

    axes: list[AxisScore] = []
    axis_names = sorted({axis.axis for sample in samples for axis in sample.axes})
    for axis_name in axis_names:
        axis_samples = [
            axis for sample in samples for axis in sample.axes if axis.axis == axis_name
        ]
        scored = [axis for axis in axis_samples if axis.score is not None]
        if scored:
            min_score = min(axis.score for axis in scored if axis.score is not None)
            min_axes = [axis for axis in scored if axis.score == min_score]
            rationale = " / ".join(axis.rationale for axis in min_axes[:2])
            matches_expected = all(axis.matches_expected for axis in min_axes)
            anti_patterns = sorted({
                hit for axis in axis_samples for hit in axis.anti_patterns_hit
            })
            axes.append(AxisScore(
                axis=axis_name,
                score=min_score,
                rationale=f"repeat-min: {rationale}",
                matches_expected=matches_expected,
                anti_patterns_hit=anti_patterns,
            ))
        else:
            axes.append(AxisScore(
                axis=axis_name,
                score=None,
                rationale="repeat-all-null",
            ))

    verdict_rank = {"pass": 0, "marginal": 1, "fail": 2}
    worst = max(samples, key=lambda sample: verdict_rank[sample.overall_verdict])
    return JudgeScore(
        fixture_id=samples[0].fixture_id,
        scope=samples[0].scope,
        axes=axes,
        overall_verdict=worst.overall_verdict,
        overall_rationale=(
            f"repeat conservative aggregate over {len(samples)} samples; "
            f"worst_verdict={worst.overall_verdict}. {worst.overall_rationale}"
        ),
        judge_model=samples[0].judge_model,
        judge_prompt_version=samples[0].judge_prompt_version,
    )


def _judge_variance_summary(samples: list[JudgeScore]) -> dict[str, Any]:
    """Compact variance metadata for repeated judge calls."""
    axis_scores: dict[str, list[int | None]] = {}
    for sample in samples:
        for axis in sample.axes:
            axis_scores.setdefault(axis.axis, []).append(axis.score)
    unstable_axes = sorted({
        axis for axis, scores in axis_scores.items()
        if len(set(scores)) > 1
    })
    return {
        "repeat": len(samples),
        "verdicts": [sample.overall_verdict for sample in samples],
        "unstable_axes": unstable_axes,
        "axis_scores": axis_scores,
    }


def run_s2_evaluation(**_kwargs: Any) -> EvalReport:
    """Phase 2 placeholder."""
    raise NotImplementedError("S2 evaluation lands after S1 baseline is stable")


def run_s3_evaluation(**_kwargs: Any) -> EvalReport:
    """Phase 3 placeholder."""
    raise NotImplementedError("S3 evaluation lands after S1 + S2")


# ---------------------------------------------------------------------------
# Report aggregation + I/O
# ---------------------------------------------------------------------------


def _build_report(
    scope: str,
    mode: RunMode,
    outcomes: list[FixtureRunOutcome],
    *,
    judge_prompt_version: str,
    run_id: str | None = None,
) -> EvalReport:
    n_pass = n_marginal = n_fail = 0
    for o in outcomes:
        if not o.l1_passed or o.judge_score is None:
            n_fail += 1
            continue
        verdict = o.judge_score.overall_verdict
        if verdict == "pass":
            n_pass += 1
        elif verdict == "marginal":
            n_marginal += 1
        else:
            n_fail += 1

    try:
        git_sha = (
            subprocess.check_output(
                ["git", "rev-parse", "--short", "HEAD"],
                cwd=str(REPO_ROOT),
                stderr=subprocess.DEVNULL,
            )
            .decode()
            .strip()
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        git_sha = "unknown"

    return EvalReport(
        run_id=run_id or _new_run_id(),
        git_sha=git_sha,
        scope=scope,
        mode=mode.value,
        judge_prompt_version=judge_prompt_version,
        fixtures_total=len(outcomes),
        fixtures_passed=n_pass,
        fixtures_marginal=n_marginal,
        fixtures_failed=n_fail,
        per_axis_avg=aggregate_axis_avg(outcomes),
        per_fixture=outcomes,
    )


def _load_resume_outcomes(
    resume_report_path: Path | None,
    *,
    mode: RunMode,
    judge_prompt_version: str,
) -> tuple[dict[str, FixtureRunOutcome], str | None]:
    if resume_report_path is None:
        return {}, None
    try:
        payload = json.loads(resume_report_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"Could not read --resume-report {resume_report_path}: {exc}") from exc
    report = EvalReport.model_validate(payload)
    if report.scope != "s1":
        raise ValueError(f"--resume-report scope must be 's1', got {report.scope!r}")
    if report.mode != mode.value:
        raise ValueError(
            f"--resume-report mode mismatch: report={report.mode!r}, requested={mode.value!r}"
        )
    if report.judge_prompt_version != judge_prompt_version:
        raise ValueError(
            "--resume-report judge_prompt_version mismatch: "
            f"report={report.judge_prompt_version!r}, current={judge_prompt_version!r}"
        )

    outcomes: dict[str, FixtureRunOutcome] = {}
    for outcome in report.per_fixture:
        outcomes[outcome.fixture_id] = outcome
    run_id = report.run_id.removesuffix(".partial")
    return outcomes, run_id


def _new_run_id() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_run_id(run_id: str) -> str:
    return run_id.replace(":", "-").replace("+", "_")


def _remove_partial_report(run_id: str) -> None:
    safe_partial_id = _safe_run_id(f"{run_id}.partial")
    for path in (
        REPORT_DIR / f"{safe_partial_id}.json",
        REPORT_DIR / f"{safe_partial_id}.md",
    ):
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        except OSError as exc:
            logger.warning("could not remove partial eval report %s: %s", path, exc)
    artifact_root = REPORT_DIR / safe_partial_id
    try:
        resolved_root = artifact_root.resolve()
        resolved_reports = REPORT_DIR.resolve()
    except OSError as exc:
        logger.warning("could not resolve partial eval artifact dir %s: %s", artifact_root, exc)
        return
    if resolved_root.parent != resolved_reports:
        logger.warning("refusing to remove partial eval artifact dir outside report dir: %s", artifact_root)
        return
    try:
        shutil.rmtree(artifact_root)
    except FileNotFoundError:
        pass
    except OSError as exc:
        logger.warning("could not remove partial eval artifact dir %s: %s", artifact_root, exc)


def write_report(report: EvalReport) -> tuple[Path, Path]:
    """Write report JSON + markdown to ``.omc/eval/reports/``."""
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    safe_id = _safe_run_id(report.run_id)
    json_path = REPORT_DIR / f"{safe_id}.json"
    md_path = REPORT_DIR / f"{safe_id}.md"
    artifact_dir = REPORT_DIR / safe_id / "artifacts"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    for outcome in report.per_fixture:
        if outcome.generated_artifact:
            artifact_path = artifact_dir / f"{outcome.fixture_id}.generated-plan.json"
            artifact_path.write_text(
                json.dumps(outcome.generated_artifact, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
    json_path.write_text(report.model_dump_json(indent=2), encoding="utf-8")
    md_path.write_text(_render_md(report), encoding="utf-8")
    if not report.run_id.endswith(".partial"):
        _remove_partial_report(report.run_id)
    return json_path, md_path


def _render_md(report: EvalReport) -> str:
    """Human-readable markdown summary for spot-check."""
    lines = [
        f"# Eval report — {report.scope} ({report.mode})",
        "",
        f"- run_id: `{report.run_id}`",
        f"- git_sha: `{report.git_sha}`",
        f"- judge_prompt_version: `{report.judge_prompt_version}`",
        f"- fixtures: {report.fixtures_total} "
        f"(pass={report.fixtures_passed} / "
        f"marginal={report.fixtures_marginal} / fail={report.fixtures_failed})",
        "",
        "## Per-axis averages",
        "",
    ]
    if report.per_axis_avg:
        lines.append("| Axis | Avg score |")
        lines.append("|------|-----------|")
        for axis, avg in sorted(report.per_axis_avg.items()):
            lines.append(f"| `{axis}` | {avg:.2f} |")
    else:
        lines.append("(no scorable outcomes)")
    lines.extend(["", "## Per-fixture", ""])
    for o in report.per_fixture:
        verdict = o.judge_score.overall_verdict if o.judge_score else "(no judge)"
        l1 = "OK" if o.l1_passed else "BLOCKED"
        total_s = o.timings.get("total_s") or o.timings.get("generation_total_s")
        timing = f" / {float(total_s):.1f}s" if isinstance(total_s, (int, float)) else ""
        iters = f" / iter={o.generation_iterations}" if o.generation_iterations else ""
        suffix = f" / error: {o.error}" if o.error else ""
        lines.append(
            f"- `{o.fixture_id}` — L1 {l1} / verdict: {verdict}{iters}{timing}{suffix}"
        )
    return "\n".join(lines) + "\n"
