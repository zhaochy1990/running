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

from coach.graphs.generation.state import GenState
from coach.graphs.generation.weekly_prompt import WeekMeta, build_weekly_system_prompt
from coach.schemas import PaceTargets, VolumeTargets
from stride_core.db import Database
from stride_core.master_plan import PhaseType
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
