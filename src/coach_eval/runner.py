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
import subprocess
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

from .graph import run_evaluation_for_fixture
from .judge_s1 import JUDGE_PROMPT_VERSION as S1_JUDGE_VERSION
from .judge_s1 import make_s1_judge
from .schemas import EvalReport, FixtureRunOutcome, aggregate_axis_avg

logger = logging.getLogger(__name__)


REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_DIR = REPO_ROOT / "tests" / "fixtures" / "coach_eval"
REPORT_DIR = REPO_ROOT / ".omc" / "eval" / "reports"


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
        "fatigue": None,
        "rhr": None,
        "training_load_state": None,
        "summary": "(frozen_fixture mode: no live HRV/CTL signals — S1 is strategic/monthly scale)",
    }


def _make_frozen_load_context(fixture: dict) -> Callable[[dict], dict]:
    """Closure: returns a ``load_context`` callable bound to this fixture."""
    fixture_input = fixture.get("input") or {}
    history = _fixture_to_history_dict(fixture_input)
    history_summary = _format_history_summary(history)
    fitness_state = _fixture_to_fitness_state()

    def load_ctx(_state: dict) -> dict:
        return {
            "history": history,
            "history_summary": history_summary,
            "fitness_state": fitness_state,
        }

    return load_ctx


# ---------------------------------------------------------------------------
# S1 initial state builder
# ---------------------------------------------------------------------------


def _build_s1_initial_state(fixture: dict) -> dict:
    """Synthesize the GenState shape the master adapter expects."""
    fixture_input = fixture.get("input") or {}
    user_profile = fixture_input.get("user_profile") or {}
    target_race = user_profile.get("target_race") or {}
    season_window = fixture_input.get("season_window") or {}

    goal = {
        "id": fixture.get("fixture_id"),
        "race_date": target_race.get("race_date"),
        "race_type": target_race.get("distance"),
        "goal_time_s": target_race.get("goal_time_s"),
        "season_start": season_window.get("start_date"),
        "season_end": season_window.get("end_date"),
    }
    profile = {
        "hr_zones": user_profile.get("hr_zones"),
        "prs": user_profile.get("prs"),
        "weekly_run_days_max": user_profile.get("weekly_run_days_max"),
        "experience_level": user_profile.get("experience_level"),
        "weight_kg": user_profile.get("weight_kg"),
        "injuries": user_profile.get("injuries"),
        "user_intent_md": fixture_input.get("user_intent_md"),
    }
    return {
        "job_id": "",  # No job — eval is direct
        "user_id": user_profile.get("user_id") or "eval-fixture-user",
        "plan_type": "master",
        "input_payload": {"goal": goal, "profile": profile},
    }


# ---------------------------------------------------------------------------
# S1 runner
# ---------------------------------------------------------------------------


def run_s1_evaluation(
    *,
    mode: RunMode,
    fixture_ids: list[str] | None = None,
    judge_llm: Any | None = None,
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

    outcomes: list[FixtureRunOutcome] = []
    for i, fixture in enumerate(fixtures, start=1):
        fid = fixture.get("fixture_id", f"<idx={i}>")
        logger.info("S1 eval [%d/%d] mode=%s id=%s", i, len(fixtures), mode.value, fid)

        if mode == RunMode.FROZEN_FIXTURE:
            load_ctx = _make_frozen_load_context(fixture)
        else:
            load_ctx = load_master_context

        # Extract input-aware rule_filter kwargs from the fixture so the
        # input-aware L1 checks (season_window_fits / goal_realism /
        # target_distance_long_run / key_session_density) have data to
        # evaluate. No-op for fixtures lacking a given field.
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
            initial_state_builder=_build_s1_initial_state,
        )
        outcomes.append(outcome)

    return _build_report(
        "s1", mode, outcomes, judge_prompt_version=S1_JUDGE_VERSION
    )


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
        run_id=datetime.now(timezone.utc).isoformat(),
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


def write_report(report: EvalReport) -> tuple[Path, Path]:
    """Write report JSON + markdown to ``.omc/eval/reports/``."""
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    safe_id = report.run_id.replace(":", "-").replace("+", "_")
    json_path = REPORT_DIR / f"{safe_id}.json"
    md_path = REPORT_DIR / f"{safe_id}.md"
    json_path.write_text(report.model_dump_json(indent=2), encoding="utf-8")
    md_path.write_text(_render_md(report), encoding="utf-8")
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
        suffix = f" / error: {o.error}" if o.error else ""
        lines.append(f"- `{o.fixture_id}` — L1 {l1} / verdict: {verdict}{suffix}")
    return "\n".join(lines) + "\n"
