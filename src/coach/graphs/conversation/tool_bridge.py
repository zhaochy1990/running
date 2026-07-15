"""Bridge ``Toolkit`` callables to LangChain ``StructuredTool`` objects.

Two responsibilities:

1. Wrap each Toolkit tool in a LangChain :class:`StructuredTool` so the LLM
   can call them via the standard tool-calling protocol.
2. Serialise the :class:`ToolResult` return value to a JSON string so it can
   ride back inside a ``ToolMessage`` (langchain's tool-call result envelope).
"""

from __future__ import annotations

import inspect
import json
import logging
import time
from collections.abc import Callable
from typing import Any

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, create_model

from coach.runtime.toolkit import Toolkit
from coach.schemas import ToolResult

logger = logging.getLogger(__name__)


def _serialize_result(result: ToolResult) -> str:
    return json.dumps(result.model_dump(), ensure_ascii=False, default=str)


_TOOL_DESCRIPTIONS: dict[str, str] = {
    # read
    "get_training_summary": (
        "Compact deterministic summary for a Shanghai calendar date range: "
        "activities, running totals, STRIDE training dose/PMC, raw RHR/HRV, key sessions, "
        "and plan completion. Omit dates for the previous Monday-Sunday week. "
        "Prefer this single bounded tool for weekly summaries instead of "
        "repeatedly calling activity/detail tools. Computed load is always marked source=stride; "
        "there is no fallback to vendor load."
    ),
    "get_recent_activities": "List recent raw activity facts plus per-activity stride_training_load (cardio_tss/external_tss/mechanical_load/training_dose/confidence). Missing STRIDE load is explicit and never falls back to a vendor training_load score.",
    "get_health_snapshot": "Latest vendor-neutral context with explicit blocks: stride_training_load (training_dose/acute_load/chronic_load/form/load_ratio + form_zone), raw_measurements (RHR/HRV), stride_calibration, and provenance. Do not infer or report watch-vendor fatigue/recovery scores.",
    "get_health_series": "Recent vendor-neutral status series over the last `days` (default 14, max 365). Whitelisted values are raw rhr/HRV measurements plus STRIDE training_dose, acute_load, chronic_load, form, and load_ratio. Use aliases metrics=['recovery'], ['hrv'], ['load'], or explicit metrics. Vendor fatigue/readiness/load scores are intentionally unavailable.",
    "get_pmc_series": "Daily STRIDE PMC series over the last `days` (default 42): acute_load, chronic_load, form, load_ratio per day (STRIDE self-computed, not COROS ati/cti).",
    "get_body_composition_latest": "Latest body-composition scan + delta from prior scan (weight_kg/body_fat_pct/smm_kg).",
    "get_ability_snapshot": "Latest STRIDE ability_snapshot rows by dimension. Legacy readiness-dependent L2/L3 recovery/L4 rows are intentionally excluded.",
    "get_race_predictions": "STRIDE race-time predictions derived from STRIDE L3 VO2max (5K/10K/HM/FM), not watch dashboard predictions.",
    "get_pbs": "Personal bests for 5K/10K/HM/FM, including history points.",
    "get_master_plan_current": "Active master plan (phases + milestones + training principles) or None.",
    "get_master_plan_versions": "Version history of a master plan id.",
    "get_week_plan": "This week's canonical structured WeeklyPlan (sessions + nutrition).",
    "get_activity_detail": "Activity detail by label_id — raw activity facts/timeseries, laps/segments, explicit stride_training_load, and provenance. Vendor scores/zones and prior AI commentary are excluded; missing STRIDE load never falls back to vendor load.",
    "get_training_environment": "Training environment: STRIDE-detected current altitude + band, whether at altitude, and signal-informed acclimatization status (disturbed/recovering/stabilized from RHR/HRV vs baseline) after a recent altitude gain. Consult when assessing status; if a recent gain looks unconfirmed, ask the user to confirm the environment change. (weather TBD).",
    "estimate_master_plan_load": "Estimate historical weekly km/dose anchors and planned master-plan weekly load. Pass a MasterPlan-shaped `plan` draft to check underload/overload alignment; omit it to estimate the active master plan and still get the history anchor.",
    # week-scope draft
    "swap_sessions": "Propose swapping the run scheduled on date_a with the one on date_b (PlanDiff).",
    "shift_session": "Propose moving a single session from `date` to `to_date` (PlanDiff).",
    "reduce_intensity": "Propose reducing intensity over `scope` (week / day) by `factor` for `reason`.",
    "replace_session": "Propose replacing a session at (date, session_index) with `new_kind` + `params`.",
    "add_strength_session": "Propose adding a strength session on `date` with `focus` area.",
    "change_pace_target": "Propose changing the pace target of a session to `new_pace_s_per_km`.",
    "regenerate_week": "Propose regenerating the whole week given `reason` and `constraints`.",
    # master-scope draft
    "extend_phase": "Propose extending a master-plan phase by N weeks.",
    "compress_phase": "Propose shortening a master-plan phase by N weeks.",
    "shift_milestone": "Propose moving a milestone to `new_date`.",
    "change_target": "Propose changing a milestone target time.",
    "propose_alternatives": "Generate alternative master-plan adjustments matching the user's intent.",
    "regenerate_master": "Propose regenerating the whole master plan given `reason`.",
}


def _build_args_schema(name: str, callable_: Callable[..., Any]) -> type[BaseModel]:
    """Generate a Pydantic args model from the callable's signature.

    We pass this as ``StructuredTool.args_schema`` so langchain skips its own
    annotation-based inference (which fails when the wrapper uses ``**kwargs``).

    Resolution order: the callable directly (works for plain functions +
    bound methods), then ``__call__`` on the type (works for instances with
    user-defined ``__call__``). Calling ``callable_.__call__`` on a plain
    function returns the descriptor whose signature is ``(*args, **kwargs)``,
    which would silently produce an empty schema — so the direct path comes
    first.
    """
    try:
        sig = inspect.signature(callable_)
    except (TypeError, ValueError):
        # Fall back to the instance's __call__ method (custom-callable class).
        try:
            sig = inspect.signature(type(callable_).__call__)
        except (TypeError, ValueError):
            sig = inspect.Signature()

    fields: dict[str, tuple[Any, Any]] = {}
    for pname, p in sig.parameters.items():
        if pname == "self":
            continue
        ann = p.annotation if p.annotation is not inspect.Parameter.empty else Any
        default = ... if p.default is inspect.Parameter.empty else p.default
        fields[pname] = (ann, default)

    # When the impl takes no kwargs, langchain still wants a non-empty schema.
    if not fields:
        fields["_no_args"] = (bool, False)

    return create_model(f"{name}Args", **fields)  # type: ignore[call-overload]


def _wrap(name: str, callable_: Callable[..., ToolResult]) -> StructuredTool:
    """Wrap one Toolkit callable as a LangChain StructuredTool.

    We avoid langchain's signature-inference path by providing an explicit
    ``args_schema``. The wrapper just unpacks the validated kwargs into the
    real impl and JSON-serialises the ``ToolResult``.
    """

    def wrapper(**kwargs: Any) -> str:
        kwargs.pop("_no_args", None)
        started = time.perf_counter()
        result = callable_(**kwargs)
        payload = _serialize_result(result)
        logger.debug(
            "tool call | name=%s elapsed=%.0fms result_chars=%d ok=%s",
            name,
            (time.perf_counter() - started) * 1000.0,
            len(payload),
            result.ok,
        )
        return payload

    wrapper.__name__ = name
    wrapper.__doc__ = _TOOL_DESCRIPTIONS.get(name, f"Tool {name}")

    return StructuredTool.from_function(
        wrapper,
        name=name,
        description=_TOOL_DESCRIPTIONS.get(name, f"Tool {name}"),
        args_schema=_build_args_schema(name, callable_),
    )


READ_TOOL_NAMES = (
    "get_training_summary",
    "get_recent_activities",
    "get_health_snapshot",
    "get_health_series",
    "get_pmc_series",
    "get_body_composition_latest",
    "get_ability_snapshot",
    "get_race_predictions",
    "get_pbs",
    "get_master_plan_current",
    "get_master_plan_versions",
    "get_week_plan",
    "get_activity_detail",
    "get_training_environment",
    "estimate_master_plan_load",
)

WEEK_DRAFT_TOOL_NAMES = (
    "swap_sessions",
    "shift_session",
    "reduce_intensity",
    "replace_session",
    "add_strength_session",
    "change_pace_target",
    "regenerate_week",
)

MASTER_DRAFT_TOOL_NAMES = (
    "extend_phase",
    "compress_phase",
    "shift_milestone",
    "change_target",
    "propose_alternatives",
    "regenerate_master",
)


def tool_names_for_scope(scope: str) -> tuple[str, ...]:
    """Return the (read + scope-specific draft) tool names exposed to the LLM."""
    if scope == "qa":
        return READ_TOOL_NAMES
    if scope == "week_chat":
        return READ_TOOL_NAMES + WEEK_DRAFT_TOOL_NAMES
    if scope == "master_chat":
        return READ_TOOL_NAMES + MASTER_DRAFT_TOOL_NAMES
    raise ValueError(f"unknown scope {scope!r}")


def build_langchain_tools(toolkit: Toolkit, scope: str) -> list[StructuredTool]:
    """Pack the (read + scope-specific draft) tools into a list of langchain tools."""
    names = tool_names_for_scope(scope)
    return [_wrap(name, getattr(toolkit, name)) for name in names]


def is_draft_tool(name: str) -> bool:
    """Whether ``name`` belongs to a draft tool family (week or master)."""
    return name in WEEK_DRAFT_TOOL_NAMES or name in MASTER_DRAFT_TOOL_NAMES
