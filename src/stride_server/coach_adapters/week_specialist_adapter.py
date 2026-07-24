"""Single-week specialist generator + shared specialist helpers.

Originally this module held the Stage-3a **per-week** generator and its per-phase
loop; the phase-at-once optimization (PA-T1…T6) moved *season* generation to
:mod:`stride_server.coach_adapters.phase_specialist_adapter` (an entire phase in
one LLM call) and removed the old per-week loop. This module now hosts:

* the **standalone single-week generator** used by ``build_weekly_plan`` (the
  HTTP ``/plan/weeks/generate`` route + the conversational weekly-plan
  specialist's creation path):
  * ``generate_specialist_week`` — compose → tool-loop → parse(one retry) →
    ``WeeklyPlan`` validate for ONE week,
  * ``generate_week_validated`` — the ``run_rule_filter`` safety gate + bounded
    regen-with-feedback that **raises** ``WeeklyPlanGenerationError`` when no
    rule-valid week can be produced (unlike the phase path, which degrades a
    failed phase to ``[]`` — a standalone weekly request has no season bundle to
    fall back into, so it must surface the failure);
* the **reusable specialist helpers** the phase-at-once adapter also imports:
  * ``build_specialist_context`` — the 必传上下文 (pace table + volume budget) used
    both to compose the prompt and to source the rule_filter's athlete-relative
    Z4-Z5 threshold (``pace_targets.threshold_pace_s_km``),
  * ``_render_context_block`` — renders the continuity / prior-tail / injuries
    pre-rendered context string the prompt composers consume,
  * ``_coerce_phase_type`` / ``_coerce_week_meta`` — input coercion,
  * the LLM tool wiring (``_build_specialist_tools`` + ``_wrap_specialist_tool``)
    that turns a specialist's declared pull-tools (``strength_library`` /
    ``recent_training``) into the langchain ``StructuredTool``s the tool loop
    drives.

This is the **adapter** layer: it touches the DB (running calibration via
``Database(user=...)``) and the LLM — neither of which ``coach.*`` core may.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from datetime import date as date_cls
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.tools import StructuredTool

from coach.graphs.conversation.tool_bridge import _build_args_schema, _serialize_result
from coach.graphs.generation.phase_specialists import get_specialist
from coach.graphs.generation.rule_filter import RuleViolation, run_rule_filter
from coach.graphs.generation.weekly_prompt import WeekMeta, build_weekly_system_prompt
from coach.runtime.llm_factory import CoachLLMUnavailable
from coach.runtime.tool_loop import run_tool_loop
from coach.schemas import PaceTargets, ToolResult, VolumeTargets
from stride_core.master_plan import PhaseType
from stride_core.plan_spec import WeeklyPlan
from stride_core.timefmt import today_shanghai
from stride_storage.sqlite.database import Database

from ..coach_runtime import get_generator_llm
from ..llm_client import LLMError, LLMUnavailable, _map_exception
from ..master_plan_generator import _parse_llm_output
from ..weekly_plan_generator import WeeklyPlanGenerationError
from .specialist_tools import (
    RECENT_TRAINING_TOOL_DESCRIPTION,
    STRENGTH_LIBRARY_TOOL_DESCRIPTION,
    RecentTrainingTool,
    StrengthLibraryTool,
    pace_targets,
    volume_targets,
)

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
# Tool wiring (Task 8) — turn the specialist's declared pull-tools into the
# langchain StructuredTools the tool loop drives.
# ---------------------------------------------------------------------------

# Map a declared specialist tool name → (callable factory, description). Only
# the wired tools live here; an undeclared/unwired name is silently skipped so
# the prompt never promises a tool the runtime can't deliver.
_WIRED_TOOL_DESCRIPTIONS = {
    "strength_library": STRENGTH_LIBRARY_TOOL_DESCRIPTION,
    "recent_training": RECENT_TRAINING_TOOL_DESCRIPTION,
}


def _wrap_specialist_tool(name: str, impl: Any) -> StructuredTool:
    """Wrap a ToolResult-returning callable as a langchain StructuredTool.

    Reuses ``tool_bridge``'s generic ``_build_args_schema`` (derives the args
    schema from the impl's ``__call__`` signature) + ``_serialize_result``
    (``ToolResult`` → JSON string). The description is the specialist-tool one,
    not the conversation ``_TOOL_DESCRIPTIONS`` dict.
    """
    description = _WIRED_TOOL_DESCRIPTIONS.get(name, f"Tool {name}")

    def wrapper(**kwargs: Any) -> str:
        kwargs.pop("_no_args", None)
        result: ToolResult = impl(**kwargs)
        return _serialize_result(result)

    wrapper.__name__ = name
    wrapper.__doc__ = description

    return StructuredTool.from_function(
        wrapper,
        name=name,
        description=description,
        args_schema=_build_args_schema(name, impl),
    )


def _build_specialist_tools(
    phase_type: PhaseType,
    *,
    user_id: str,
    injuries: list[str],
) -> list[StructuredTool]:
    """Build StructuredTools for the tools this specialist is allowed to use.

    The allow-list comes from ``get_specialist(phase_type).tools`` (Task 1).
    Only the wired tools (``strength_library`` / ``recent_training``) are built;
    an empty tuple (e.g. taper) yields no tools, so the loop degrades to a plain
    invoke. ``injuries`` is bound into ``StrengthLibraryTool`` so the LLM gets
    injury-safe T-codes even if it omits the arg.
    """
    declared = get_specialist(phase_type).tools
    tools: list[StructuredTool] = []
    for name in declared:
        if name == "strength_library":
            impl = StrengthLibraryTool(user_id, default_injuries=injuries)
        elif name == "recent_training":
            impl = RecentTrainingTool(user_id)
        else:
            # Declared but not yet wired — skip (don't promise an unbindable tool).
            logger.debug(
                "specialist %s declares unwired tool %r — skipping", phase_type, name
            )
            continue
        tools.append(_wrap_specialist_tool(name, impl))
    return tools


# ---------------------------------------------------------------------------
# Per-week meta coercion (reused by phase_specialist_adapter)
# ---------------------------------------------------------------------------


def _coerce_week_meta(week: Any) -> WeekMeta:
    """Accept a dict descriptor (or a WeekMeta) → WeekMeta.

    The ``weeks`` descriptor contract (one entry per week, ordered):

        {
          "week_index": 2,                       # advisory only (NOT read here —
                                                 # sequencing relies on list order;
                                                 # WeekMeta has no index)
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


# ---------------------------------------------------------------------------
# Single-week LLM generator (the standalone analog of the phase-at-once
# generate_specialist_phase / generate_phase_validated in
# phase_specialist_adapter). Unlike the phase path — which "never raises",
# degrading a failed phase to [] — the weekly path RAISES
# ``WeeklyPlanGenerationError`` when it cannot produce a rule-valid week after
# its bounded retries, because a standalone weekly request has no season bundle
# to fall back into: the caller (build_weekly_plan / the HTTP route / the chat
# specialist) must surface the failure, not silently return an empty week.
# ---------------------------------------------------------------------------


def _render_week_feedback(feedback: str) -> str:
    return f"""\
【上一轮问题——本次重新生成必须逐条修复（fix these）】
下列问题来自上一轮 rule_filter 安全校验。重新设计本周时必须**逐条**针对性修复，不要重复同样的错误：
{feedback}
"""


def _format_week_rule_feedback(violations: list[RuleViolation]) -> str:
    """Render single-week rule violations into a regen feedback string."""
    return "\n".join(f"违反 {v.rule}：{v.message}" for v in violations)


def generate_specialist_week(
    *,
    phase_type: PhaseType,
    week_meta: WeekMeta,
    user_id: str,
    pace_targets: PaceTargets,
    volume_targets: VolumeTargets,
    context_block: str,
    injuries: list[str],
    nutrition_baseline_block: str = "",
) -> dict:
    """Generate ONE week via the generator LLM (compose → tool-loop → parse → validate).

    Mirrors ``generate_specialist_phase`` at week granularity but takes the
    already-computed ``pace_targets`` / ``volume_targets`` (so the caller
    computes the athlete pace table once and can reuse it across regen attempts)
    and a pre-rendered ``context_block`` (continuity + prior-tail + injuries +
    optional regen feedback). Binds the phase's declared pull-tools, runs the
    shared tool loop, then does a 3-tier parse (one retry) + ``WeeklyPlan``
    schema validation.

    Returns the validated ``WeeklyPlan`` dict (does NOT run rule_filter — the
    caller ``generate_week_validated`` owns the safety gate).

    Raises:
        ValueError starting with ``"parse_failed"`` / ``"bad_schema"``: the
            output could not be parsed (after one retry) or is not a valid
            ``WeeklyPlan``.
        LLMUnavailable / LLMError: propagated from the LLM client.
    """
    phase_type = _coerce_phase_type(phase_type)
    injuries = list(injuries or [])

    system_prompt = build_weekly_system_prompt(
        phase=phase_type,
        week_meta=week_meta,
        pace_targets=pace_targets,
        volume_targets=volume_targets,
        context_block=context_block,
        nutrition_baseline_block=nutrition_baseline_block,
    )
    user_text = (
        "请基于上述阶段指导 + 注入的配速/量预算"
        + ("（含营养基线）" if nutrition_baseline_block else "")
        + "，生成该目标周的 WeeklyPlan JSON。"
    )

    structured_tools = _build_specialist_tools(
        phase_type, user_id=user_id, injuries=injuries
    )

    def _run_one_pass() -> str:
        try:
            llm = get_generator_llm()
        except CoachLLMUnavailable as exc:
            raise LLMUnavailable(str(exc)) from exc
        llm_with_tools = llm.bind_tools(structured_tools) if structured_tools else llm
        tool_map = {t.name: t for t in structured_tools}
        messages = [
            SystemMessage(content=system_prompt),
            HumanMessage(content=user_text),
        ]
        try:
            return run_tool_loop(llm_with_tools, messages, tool_map)
        except CoachLLMUnavailable as exc:
            raise LLMUnavailable(str(exc)) from exc
        except (LLMError, LLMUnavailable):
            raise
        except BaseException as exc:  # noqa: BLE001 — LLM/tool boundary
            raise _map_exception(exc) from exc

    def _parse(raw: str) -> dict:
        parsed = _parse_llm_output(raw)
        if parsed is None:
            raise ValueError(
                f"parse_failed: weekly plan output unparseable (raw_len={len(raw)})"
            )
        if not isinstance(parsed, dict):
            raise ValueError(
                f"parse_failed: parsed output is {type(parsed).__name__}, not a WeeklyPlan object"
            )
        return parsed

    raw = _run_one_pass()
    try:
        parsed = _parse(raw)
    except ValueError:
        logger.warning(
            "generate_specialist_week: parse_failed on first attempt "
            "(raw_len=%d) — retrying once",
            len(raw),
        )
        parsed = _parse(_run_one_pass())

    try:
        plan = WeeklyPlan.from_dict(parsed)
    except (ValueError, KeyError, TypeError) as exc:
        raise ValueError(f"bad_schema: WeeklyPlan.from_dict failed: {exc}") from exc
    return plan.to_dict()


def generate_week_validated(
    *,
    phase_type: PhaseType,
    week_meta: WeekMeta,
    context: dict,
    injuries: list[str] | None = None,
    prev_week_km: float | None = None,
    immutable_rules: Iterable[str] = (),
    nutrition_baseline_block: str = "",
    as_of: date_cls | None = None,
    max_attempts: int = 3,
) -> dict:
    """Generate one week, rule-gate it, regen-with-feedback, and RAISE on failure.

    The value-add over the inner ``generate_specialist_week`` (one un-gated pass)
    is the ``run_rule_filter`` safety gate + bounded feedback-driven regen. The
    athlete pace table + volume budget are computed once here (fail-fast on a
    missing calibration snapshot) and reused across attempts; the Z4-Z5 pace
    threshold is single-sourced from ``pace_targets.threshold_pace_s_km``.

    ``immutable_rules`` names rule ids that are already violated by
    *completed* work echoed into the week (e.g. ``weekly_progression`` when a
    mid-week's finished mileage is already over the ramp cap). Those violations
    can't be fixed by regeneration, so they are exempted from the retry/raise
    decision — mirroring the old rule-generator's immutable-rule exemption.

    Args:
        context: shared context — ``user_id``, ``goal`` (dict), ``level``; may
            carry ``continuity`` (ContinuitySignals dict) + ``prior_week_tail``
            + ``nutrition_baseline_block`` is passed separately.
        prev_week_km: prior week's actual km for the progression gate.
        as_of: reference date for the calibration snapshot (usually week_start).
        max_attempts: hard bound on generation attempts (default 3).

    Returns:
        The rule-clean ``WeeklyPlan`` dict.

    Raises:
        WeeklyPlanGenerationError: no usable calibration snapshot, an LLM-infra
            outage, unparseable/invalid output after retries, or rule violations
            that persist after ``max_attempts``.
    """
    week_meta = _coerce_week_meta(week_meta)
    phase_type = _coerce_phase_type(phase_type)
    injuries = list(injuries or [])
    immutable = set(immutable_rules or ())
    target_km = float(week_meta.target_weekly_km)

    user_id = str(context.get("user_id") or "")
    goal = context.get("goal") or {}
    level = float(context.get("level") or 0.0)

    # Compute the athlete pace table + volume budget ONCE (reused every attempt).
    # A missing calibration snapshot is a hard precondition failure — surface it
    # as a generation error instead of retrying uselessly.
    db = Database(user=user_id)
    try:
        try:
            pace_tgts, volume_tgts = build_specialist_context(
                db,
                goal=goal,
                phase_type=phase_type,
                week_meta=week_meta,
                level=level,
                as_of=as_of,
            )
        except ValueError as exc:
            raise WeeklyPlanGenerationError(
                f"cannot build weekly plan: {exc}"
            ) from exc
    finally:
        db.close()

    z45_threshold = pace_tgts.threshold_pace_s_km
    base_context_block = _render_context_block(
        continuity=context.get("continuity"),
        prior_week_tail=context.get("prior_week_tail"),
        injuries=injuries,
    )
    # Caller-supplied extra block (resolution notes + completed-day locks). Kept
    # distinct from the fixed continuity/injury sections above.
    extra = str(context.get("extra_context_block") or "").strip()
    if extra:
        base_context_block = (
            f"{base_context_block}\n{extra}" if base_context_block else extra
        )

    current_feedback: str | None = None
    for attempt in range(1, max_attempts + 1):
        context_block = base_context_block
        if current_feedback:
            context_block = (
                f"{base_context_block}\n{_render_week_feedback(current_feedback)}"
                if base_context_block
                else _render_week_feedback(current_feedback)
            )
        try:
            week = generate_specialist_week(
                phase_type=phase_type,
                week_meta=week_meta,
                user_id=user_id,
                pace_targets=pace_tgts,
                volume_targets=volume_tgts,
                context_block=context_block,
                injuries=injuries,
                nutrition_baseline_block=nutrition_baseline_block,
            )
        except (LLMUnavailable, LLMError) as exc:
            # LLM-infra failure won't fix itself via regen — fail immediately.
            raise WeeklyPlanGenerationError(
                f"weekly plan LLM unavailable/error on attempt "
                f"{attempt}/{max_attempts}: {exc}"
            ) from exc
        except ValueError as exc:
            # parse_failed / bad_schema survived generate_specialist_week's own
            # one retry. Regenerate fresh (schema errors don't feed back well).
            if attempt < max_attempts:
                logger.warning(
                    "generate_week_validated: attempt %d/%d generation failed "
                    "(%s) — retrying",
                    attempt,
                    max_attempts,
                    str(exc)[:200],
                )
                current_feedback = None
                continue
            raise WeeklyPlanGenerationError(
                f"weekly plan generation failed after {max_attempts} attempts: {exc}"
            ) from exc

        report = run_rule_filter(
            week,
            prev_week_km=prev_week_km,
            target_weekly_km=target_km,
            injuries=injuries or None,
            z45_pace_threshold_s_km=z45_threshold,
        )
        actionable = [v for v in report.errors() if v.rule not in immutable]
        if not actionable:
            return week

        if attempt < max_attempts:
            current_feedback = _format_week_rule_feedback(actionable)
            logger.info(
                "generate_week_validated: attempt %d/%d had %d rule violation(s) "
                "— regenerating with feedback",
                attempt,
                max_attempts,
                len(actionable),
            )
            continue

        rules = ", ".join(sorted({v.rule for v in actionable}))
        raise WeeklyPlanGenerationError(
            f"weekly plan persistently violates [{rules}] after {max_attempts} "
            "attempts: "
            + "; ".join(f"{v.rule}: {v.message}" for v in actionable)
        )

    # The loop always returns or raises; this satisfies type-checkers.
    raise WeeklyPlanGenerationError("weekly plan generation exhausted attempts")
