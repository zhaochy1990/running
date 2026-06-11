"""Per-week specialist generator adapter (Stage-3a Task 4).

The S2-analog of :mod:`stride_server.coach_adapters.master_plan_adapter`'s
``generate_master_plan``, but for a **single phase-week**. It:

1. reads the per-week ``input_payload`` + ``context`` off the ``GenState``,
2. computes the athlete's 必传上下文 — ``pace_targets`` (real pace table) +
   ``volume_targets`` (weekly volume budget) — via Task 3's ``specialist_tools``,
3. renders a ``context_block`` (continuity summary + prior-week tail + injuries),
4. composes the single-week system prompt via
   :func:`coach.graphs.generation.weekly_prompt.build_weekly_system_prompt`
   (pace + volume are REQUIRED kwargs),
5. calls the LLM, runs the shared **3-tier** parse (with one retry on parse
   failure, mirroring the master-plan adapter), and
6. validates with :func:`stride_core.plan_spec.WeeklyPlan.from_dict`,
   returning ``{"current_draft": <validated plan dict>}`` — the shape the
   generation graph's ``generator_node`` expects.

Per-week ``input_payload`` contract (documented for the graph wiring task):

    {
      "phase_type": "build",              # PhaseType value or its .value string
      "week_meta": {                       # → coach.graphs.generation.weekly_prompt.WeekMeta
        "phase_position": "build week 3/7",
        "week_folder": "2026-06-15_06-21(W3)",
        "target_weekly_km": 80.0
      },
      "goal": { "distance": "fm", "goal_time_s": 12600, ... },  # MP derivation
      "level": 65.0,                       # athlete-level signal (CTL / recent weekly km)
      "injuries": ["achilles"]             # optional list[str]
    }

``state["context"]`` may carry:

    {
      "continuity": { ...ContinuitySignals dict... },  # optional
      "prior_week_tail": "上周尾段：完成 78km，长跑 30km @ ...",  # optional str (Task 6)
    }

This is the **adapter** layer: it touches the DB (running calibration via
``Database(user=...)``) and the LLM — neither of which ``coach.*`` core may.
Shared helpers (``_parse_llm_output`` 3-tier parse, ``LLMClient``) are reused,
not reimplemented.
"""

from __future__ import annotations

import logging
from datetime import date as date_cls
from typing import Any

from coach.graphs.generation.rule_filter import _total_run_distance_m
from coach.graphs.generation.state import GenState
from coach.graphs.generation.week_graph import build_week_specialist_graph
from coach.graphs.generation.weekly_prompt import WeekMeta, build_weekly_system_prompt
from coach.schemas import PaceTargets, ReviewReport, VolumeTargets
from stride_core.db import Database
from stride_core.master_plan import Phase, PhaseType
from stride_core.plan_spec import WeeklyPlan
from stride_core.timefmt import today_shanghai

from ..llm_client import LLMClient
from ..master_plan_generator import _parse_llm_output
from .specialist_tools import pace_targets, volume_targets

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Reusable 必传上下文 helper (Task 5/6 reuse this for the rule_filter's
# athlete-relative Z4-Z5 threshold = pace_targets.threshold_pace_s_km).
# ---------------------------------------------------------------------------


def build_specialist_context(
    db: Any,
    *,
    goal: dict,
    phase_type: PhaseType,
    week_meta: WeekMeta,
    level: float,
    as_of: date_cls | None = None,
) -> tuple[PaceTargets, VolumeTargets]:
    """Compute the week's required pace table + volume budget.

    ``pace_targets`` needs the DB (running-calibration snapshot); ``volume_targets``
    is pure (target_weekly_km from ``week_meta`` + phase + athlete level).

    Exposed as a standalone helper so the per-phase loop / graph wiring task can
    reuse it — notably to supply the rule_filter's athlete-relative Z4-Z5
    threshold ``z45_pace_threshold_s_km`` = ``pace_targets.threshold_pace_s_km``
    — instead of recomputing the pace table in a divergent way.

    Raises ``ValueError`` (propagated from ``pace_targets``) when no usable
    calibration snapshot exists — the caller must distinguish a real pace table
    from a degraded one (CLAUDE.md anti-pattern: no magic default).
    """
    ref = as_of or today_shanghai()
    pt = pace_targets(db, goal=goal, as_of=ref)
    vt = volume_targets(week_meta.target_weekly_km, phase_type, level)
    return pt, vt


# ---------------------------------------------------------------------------
# context_block rendering
# ---------------------------------------------------------------------------


def _coerce_phase_type(value: Any) -> PhaseType:
    """Accept a ``PhaseType`` or its ``.value`` string; raise on anything else."""
    if isinstance(value, PhaseType):
        return value
    try:
        return PhaseType(str(value))
    except ValueError as exc:
        raise ValueError(f"bad_schema: unknown phase_type {value!r}") from exc


def _render_context_block(
    *,
    continuity: dict | None,
    prior_week_tail: str | None,
    injuries: list[str] | None,
) -> str:
    """Render the pre-rendered context string the weekly composer consumes.

    Kept deliberately simple/readable. Empty sections are dropped so the prompt
    never carries dangling "None" tokens. Returns ``""`` when nothing applies.
    """
    parts: list[str] = []

    if continuity:
        signals: list[str] = []
        macro = continuity.get("macro_cycle")
        if macro:
            signals.append(f"宏观周期: {macro}")
        chronic = continuity.get("current_chronic_load")
        if chronic is not None:
            signals.append(f"chronic(CTL): {chronic}")
        recovery = continuity.get("post_race_recovery_status")
        if recovery:
            signals.append(f"赛后恢复: {recovery}")
        if signals:
            parts.append("【延续性信号】 " + " · ".join(signals))

    if prior_week_tail:
        parts.append(f"【上周尾段】 {prior_week_tail}")

    inj = [str(i) for i in (injuries or []) if i and str(i).lower() != "none"]
    if inj:
        parts.append("【伤病（适配动作/配速，不改阶段强度占比）】 " + ", ".join(inj))

    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Per-week generator
# ---------------------------------------------------------------------------


def generate_specialist_week(state: GenState) -> dict:
    """Generate one phase-week → ``{"current_draft": <WeeklyPlan dict>}``.

    Mirrors ``master_plan_adapter.generate_master_plan``: compute required
    context → compose prompt → LLM → 3-tier parse (one retry) → validate.

    Raises:
        ValueError starting with ``"parse_failed"``: all 3 parse tiers failed
            twice (garbage LLM output).
        ValueError starting with ``"bad_schema"``: parsed JSON is not a valid
            ``WeeklyPlan`` (``WeeklyPlan.from_dict`` rejected it), or the
            ``phase_type`` in the payload is unknown.
        LLMUnavailable / LLMError: propagated from the LLM client.
    """
    user_id = state.get("user_id") or ""
    payload = state.get("input_payload") or {}
    ctx = state.get("context") or {}

    goal = payload.get("goal") or {}
    level = float(payload.get("level") or 0.0)
    injuries = payload.get("injuries") or []
    phase_type = _coerce_phase_type(payload.get("phase_type"))

    wm_raw = payload.get("week_meta") or {}
    week_meta = WeekMeta(
        phase_position=str(wm_raw.get("phase_position", "")),
        week_folder=str(wm_raw.get("week_folder", "")),
        target_weekly_km=float(wm_raw.get("target_weekly_km") or 0.0),
    )

    # 1. 必传上下文 — open the user DB the same way load_master_context does.
    db = Database(user=user_id)
    pt, vt = build_specialist_context(
        db, goal=goal, phase_type=phase_type, week_meta=week_meta, level=level
    )

    # 2. Render the pre-rendered context block (continuity + prior-week tail + injuries).
    context_block = _render_context_block(
        continuity=ctx.get("continuity"),
        prior_week_tail=ctx.get("prior_week_tail"),
        injuries=injuries,
    )

    # 3. Compose the single-week system prompt (pace + volume REQUIRED).
    system_prompt = build_weekly_system_prompt(
        phase=phase_type,
        week_meta=week_meta,
        pace_targets=pt,
        volume_targets=vt,
        context_block=context_block,
    )

    # 4. User message — inject rule-violation feedback on retry iterations so a
    #    rule_filter block routes back here and the LLM fixes the specific
    #    issue instead of regenerating identical, deterministically-failing
    #    output. iteration > 0 guards against the first call.
    user_text = "请基于上述阶段指导 + 注入的配速/量预算生成本周训练计划 JSON"
    violations = state.get("rule_violations") or []
    iteration = int(state.get("iteration") or 0)
    if iteration > 0 and violations:
        violations_text = "\n".join(
            f"- {v.get('rule', '?')}: {v.get('message', '')}" for v in violations
        )
        user_text += (
            "\n\n上一次生成违反了以下硬性规则（rule_filter），请在本次重新生成时"
            "**显式修复**这些问题，不要重复同样的错误：\n"
            f"{violations_text}"
        )
    user_message = [{"role": "user", "content": user_text}]

    # 5. LLM call + 3-tier parse + one retry (mirror the master-plan adapter).
    client = LLMClient()
    raw = client.chat_sync(system_prompt, user_message)
    parsed = _parse_llm_output(raw)
    if parsed is None:
        logger.warning(
            "generate_specialist_week: parse_failed on first attempt "
            "(raw_len=%d) — retrying once",
            len(raw),
        )
        raw_retry = client.chat_sync(system_prompt, user_message)
        parsed = _parse_llm_output(raw_retry)
        if parsed is None:
            err = ValueError(
                f"parse_failed: all 3 tiers failed twice "
                f"(raw1 len={len(raw)}, raw2 len={len(raw_retry)})"
            )
            err.raw_output = raw_retry[:2000]  # type: ignore[attr-defined]
            raise err

    # 6. Validate as a WeeklyPlan. Return the dict that round-trips through
    #    from_dict so the graph's rule_filter (which re-parses current_draft
    #    via WeeklyPlan.from_dict) succeeds. Stage-3a sessions are aspirational
    #    (spec=None) — we do not invent structured specs.
    try:
        plan = WeeklyPlan.from_dict(parsed)
    except (ValueError, KeyError, TypeError) as exc:
        raise ValueError(f"bad_schema: {exc}") from exc

    return {"current_draft": plan.to_dict()}


# ---------------------------------------------------------------------------
# Stage-3a stub reviewer (mirrors master_plan_adapter.master_reviewer)
# ---------------------------------------------------------------------------


def _week_stub_reviewer(state: GenState) -> ReviewReport:
    """v1 stub per-week reviewer — always passes.

    The real per-phase reviewer (週 judge axes) is deferred to Plan 3b; for
    Stage-3a the only gate that can block a week is the deterministic
    ``rule_filter`` upstream. Mirrors
    ``master_plan_adapter.master_reviewer``.
    """
    return ReviewReport(
        verdict="pass",
        reviewer_model="stub-v1",
        iteration=int(state.get("iteration") or 0),
        issues=[],
        suggested_patches=[],
        commentary_md="(stub week reviewer — pass-through; 3b judge wiring pending)",
    )


# ---------------------------------------------------------------------------
# Per-phase loop (Stage-3a Task 6)
# ---------------------------------------------------------------------------


def _coerce_week_meta(week: Any) -> WeekMeta:
    """Accept a dict descriptor (or a WeekMeta) → WeekMeta.

    The ``weeks`` descriptor contract (one entry per week, ordered):

        {
          "week_index": 2,                       # 0-based position in the phase
          "week_folder": "2026-06-15_06-21(W3)", # ISO week folder
          "phase_position": "build week 3/7",    # human framing
          "target_weekly_km": 80.0               # planned volume (within band)
        }
    """
    if isinstance(week, WeekMeta):
        return week
    return WeekMeta(
        phase_position=str(week.get("phase_position", "")),
        week_folder=str(week.get("week_folder", "")),
        target_weekly_km=float(week.get("target_weekly_km") or 0.0),
    )


def _summarize_prior_week_tail(plan_dict: dict, *, max_sessions: int = 2) -> str:
    """Short tail summary (last 1-2 sessions) to feed the next week's prompt.

    Reads the just-generated week's session summaries — date-ordered — and
    joins the trailing ``max_sessions`` into a one-line string the weekly
    composer renders under 【上周尾段】.
    """
    sessions = plan_dict.get("sessions") or []
    # Order by (date, session_index) so "tail" means chronologically last.
    ordered = sorted(
        sessions,
        key=lambda s: (str(s.get("date") or ""), int(s.get("session_index") or 0)),
    )
    tail = ordered[-max_sessions:] if max_sessions > 0 else ordered
    parts = []
    for s in tail:
        summ = (s.get("summary") or "").strip()
        if summ:
            parts.append(summ)
    if not parts:
        return ""
    total_km = sum((s.get("total_distance_m") or 0) for s in sessions) / 1000.0
    return f"上周完成约 {total_km:.0f}km；尾段课次：" + "；".join(parts)


def generate_phase_weeks(
    phase: Phase,
    weeks: list[dict],
    context: dict,
    injuries: list[str] | None = None,
) -> list[dict]:
    """Walk a phase's weeks sequentially → one ``WeeklyPlan`` dict per success.

    For each week descriptor (in order) this builds the per-week generation
    graph (Task 5) wired with the per-week generator (``generate_specialist_week``,
    Task 4) and the Stage-3a stub reviewer, invokes it, and threads week-to-week
    continuity into the next iteration.

    Args:
        phase: the ``stride_core.master_plan.Phase`` this loop fills. Used for
            ``phase_type`` (specialist routing) and as a sanity reference; the
            per-week volume comes from each descriptor's ``target_weekly_km``,
            not the phase band directly.
        weeks: ordered per-week meta descriptors. Each carries ``week_index``,
            ``week_folder``, ``phase_position`` and ``target_weekly_km`` — see
            :func:`_coerce_week_meta`. The Plan-3b orchestrator builds these
            from the phase; Task 6 just consumes them.
        context: shared per-phase context. Must carry ``user_id``, ``goal``
            (dict, for MP derivation), ``level`` (athlete-level signal for the
            volume budget); may carry ``continuity`` (ContinuitySignals dict).
        injuries: optional list of injury flags, forwarded to both the prompt
            context block and the rule_filter ``injury_conflict`` check.

    Returns:
        A list of validated ``WeeklyPlan`` dicts — one per **successfully**
        generated week. A week whose graph returns ``final_verdict == "block"``
        (rule_filter unsatisfiable within max_iterations, or reviewer blocked)
        produces no plan and is omitted; the loop logs a warning and continues.

    Blocked-week threading decision: when a week is blocked we keep the last
    **successful** week's ``prev_week_km`` / ``prior_week_tail`` for the next
    iteration (rather than threading the blocked draft's numbers, which were
    rejected, or resetting to None). Rationale: the next week should progress
    from the last plan we actually trust, not from a draft we refused to ship.
    """
    phase_type = phase.phase_type or PhaseType.BASE
    user_id = str(context.get("user_id") or "")
    goal = context.get("goal") or {}
    level = float(context.get("level") or 0.0)
    continuity = context.get("continuity")
    injuries = list(injuries or [])

    results: list[dict] = []
    # Continuity threaded from the last *successful* week (None before week 1).
    prev_week_km: float | None = None
    prior_week_tail: str = ""

    # One DB handle per phase loop for the deterministic pace/volume context.
    db = Database(user=user_id)

    for week in weeks:
        week_meta = _coerce_week_meta(week)

        # 1. Per-week input_payload — Task 4's documented generator contract.
        input_payload = {
            "phase_type": phase_type.value,
            "week_meta": {
                "phase_position": week_meta.phase_position,
                "week_folder": week_meta.week_folder,
                "target_weekly_km": week_meta.target_weekly_km,
            },
            "goal": goal,
            "level": level,
            "injuries": injuries,
        }

        # 2. rule_filter inputs — incl. the Task-0 athlete-relative Z4-Z5
        #    threshold = pace_targets.threshold_pace_s_km. Deterministic, so it
        #    matches the pace table generate_specialist_week recomputes internally.
        pace_t, _volume_t = build_specialist_context(
            db, goal=goal, phase_type=phase_type, week_meta=week_meta, level=level
        )
        rule_filter_kwargs: dict[str, Any] = {
            "prev_week_km": prev_week_km,
            "injuries": injuries or None,
            "z45_pace_threshold_s_km": pace_t.threshold_pace_s_km,
        }

        # 3. Build the per-week graph (generator + stub reviewer + rules).
        #    Override the graph's default no-op context loader with one that
        #    *preserves* the threaded continuity context — the no-op loader
        #    would otherwise overwrite state["context"] with {} before the
        #    generator runs, dropping prior_week_tail / continuity.
        graph = build_week_specialist_graph(
            generator=generate_specialist_week,
            reviewer=_week_stub_reviewer,
            rule_filter_kwargs=rule_filter_kwargs,
            load_context=lambda s: dict(s.get("context") or {}),
        )

        # 4. Invoke with the per-week state (continuity threaded in context).
        state: GenState = {
            "user_id": user_id,
            "plan_type": "week",
            "input_payload": input_payload,
            "context": {
                "continuity": continuity,
                "prior_week_tail": prior_week_tail,
            },
        }
        final = graph.invoke(state)

        # 5. Handle the verdict.
        verdict = final.get("final_verdict")
        artifact = final.get("final_artifact")
        if verdict == "block" or not artifact:
            logger.warning(
                "generate_phase_weeks: week %s (%s) blocked (verdict=%s) — "
                "excluded from results; keeping prior week's continuity",
                week_meta.week_folder,
                week_meta.phase_position,
                verdict,
            )
            # Keep prior successful week's prev_week_km / prior_week_tail.
            continue

        results.append(artifact)

        # 6. Thread continuity to the next week from this successful plan.
        try:
            plan = WeeklyPlan.from_dict(artifact)
            prev_week_km = _total_run_distance_m(plan) / 1000.0
        except (ValueError, KeyError, TypeError):
            # Should not happen (the graph already validated), but never let
            # threading crash the loop — fall back to a dict-level sum.
            prev_week_km = (
                sum(
                    (s.get("total_distance_m") or 0)
                    for s in (artifact.get("sessions") or [])
                    if s.get("kind") == "run"
                )
                / 1000.0
            )
        prior_week_tail = _summarize_prior_week_tail(artifact)

    return results
