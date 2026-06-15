"""Specialist generator shared helpers (formerly the per-week adapter).

Originally this module held the Stage-3a **per-week** generator
(``generate_specialist_week``) and its per-phase loop (``generate_phase_weeks``).
The phase-at-once optimization (PA-T1…T6) replaced that path with
:mod:`stride_server.coach_adapters.phase_specialist_adapter` (an entire phase
generated in one LLM call). The dead per-week generator + loop + per-week graph
have been removed (PA-T6); what remains here are the **reusable specialist
helpers** the phase-at-once adapter imports:

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
``Database(user=...)``) — which ``coach.*`` core may not.
"""

from __future__ import annotations

import logging
from datetime import date as date_cls
from typing import Any

from langchain_core.tools import StructuredTool

from coach.graphs.conversation.tool_bridge import _build_args_schema, _serialize_result
from coach.graphs.generation.phase_specialists import get_specialist
from coach.graphs.generation.weekly_prompt import WeekMeta
from coach.schemas import PaceTargets, ToolResult, VolumeTargets
from stride_core.master_plan import PhaseType
from stride_core.timefmt import today_shanghai

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
