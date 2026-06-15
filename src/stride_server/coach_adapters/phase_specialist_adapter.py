"""Phase-at-once specialist generator adapter (phase-at-once PA-T3).

The phase-granularity analog of
:func:`stride_server.coach_adapters.week_specialist_adapter.generate_specialist_week`.
Where the per-week path asks the generator LLM for ONE week, this adapter asks
for an **entire phase's weeks in a single LLM call** — the point being that a
phase-holistic generator can progress the long run across the weeks, place the
deload week(s), and keep the doctrine's intensity distribution in ways a
per-week greedy generator cannot.

``generate_specialist_phase`` (the entry point):

1. builds the per-week ``PhaseWeekSpec`` list — ONE shared athlete pace table
   (identical across weeks) + one per-week ``VolumeTargets`` budget (derived
   from each ``WeekMeta.target_weekly_km``), with each week's ``is_deload``
   derived from a target-km dip (see :func:`build_phase_week_specs`),
2. composes the phase-level system prompt via
   :func:`coach.graphs.generation.phase_prompt.build_phase_system_prompt`
   (reusing the per-week adapter's ``_render_context_block`` for continuity +
   prior-phase tail + injuries, and threading an optional ``feedback`` string
   into the regen block),
3. binds the specialist's declared pull-tools (reusing the per-week adapter's
   ``_build_specialist_tools`` / tool wrappers) and runs the shared tool loop,
4. parses the ``{"weeks":[…×N]}`` batch via :func:`parse_phase_batch` (one
   retry on a parse failure, mirroring the per-week adapter) and validates each
   week via :func:`stride_core.plan_spec.WeeklyPlan.from_dict`,
5. returns the list of N validated ``WeeklyPlan`` dicts.

The rule_filter + feedback-regen LOOP is a SEPARATE task (PA-T4); here we only
generate + parse + validate one phase. ``feedback`` is just passed through to
``build_phase_system_prompt`` for a one-shot regen.

This is the **adapter** layer: it touches the DB (running calibration via
``Database(user=...)``) and the LLM — neither of which ``coach.*`` core may.
Everything reusable (``build_specialist_context``, ``_render_context_block``,
the tool wrappers, ``_build_specialist_tools``, ``_coerce_phase_type``, the
shared 3-tier ``_parse_llm_output``, ``run_tool_loop``, ``get_generator_llm``)
is imported, not reimplemented.
"""

from __future__ import annotations

import logging
from datetime import date as date_cls
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage

from coach.graphs.generation.phase_prompt import (
    PhaseWeekSpec,
    build_phase_system_prompt,
)
from coach.graphs.generation.weekly_prompt import WeekMeta
from coach.runtime.llm_factory import CoachLLMUnavailable
from coach.runtime.tool_loop import run_tool_loop
from coach.schemas import PaceTargets
from stride_core.db import Database
from stride_core.master_plan import Phase, PhaseType
from stride_core.plan_spec import WeeklyPlan
from stride_core.timefmt import today_shanghai

from ..coach_runtime import get_generator_llm
from ..llm_client import LLMError, LLMUnavailable, _map_exception
from ..master_plan_generator import _parse_llm_output
from .week_specialist_adapter import (
    _build_specialist_tools,
    _coerce_phase_type,
    _render_context_block,
    build_specialist_context,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Per-week spec builder (pace shared / volume per-week / deload derivation)
# ---------------------------------------------------------------------------


def build_phase_week_specs(
    db: Any,
    *,
    goal: dict,
    phase_type: PhaseType,
    week_metas: list[WeekMeta],
    level: float,
    as_of: date_cls | None = None,
) -> tuple[PaceTargets, list[PhaseWeekSpec]]:
    """Build the ``(shared pace table, per-week PhaseWeekSpec list)`` for a phase.

    The athlete pace table is **identical across every week** of the phase, so
    we compute it exactly once (reusing the first week's
    :func:`build_specialist_context`) and share it. Each week's
    ``VolumeTargets`` budget differs — it is derived from that week's
    ``target_weekly_km`` — so we recompute it per week.

    **is_deload derivation:** a ``WeekMeta`` carries no deload flag, so we
    derive one heuristically: a week is a deload iff its ``target_weekly_km`` is
    **lower than the immediately preceding week's** (a volume dip = a planned
    cutback / recovery week). Week 1 is never a deload (no predecessor). This is
    a deliberate heuristic — the phase week-expander (``derive_phase_weeks``)
    already ramps volume up over the phase and dips it for 3:1 recovery weeks,
    so a dip is the observable signal of a deload without an explicit flag.

    Args:
        db: an open user ``Database`` handle (reused across all per-week
            ``build_specialist_context`` calls).
        goal / phase_type / level: shared per-phase context (see
            :func:`build_specialist_context`).
        week_metas: ordered per-week ``WeekMeta`` (from ``derive_phase_weeks``).
        as_of: reference date for the pace-table snapshot lookup.

    Returns:
        ``(pace_targets, week_specs)`` — ``pace_targets`` shared, ``week_specs``
        one ``PhaseWeekSpec`` per ``WeekMeta`` (in order), each carrying its own
        volume budget + derived ``is_deload``.

    Raises:
        ValueError: propagated from :func:`build_specialist_context` /
            ``pace_targets`` when no usable calibration snapshot exists. The
            caller must distinguish this real precondition failure from a
            ``parse_failed`` / ``bad_schema`` — it is NOT re-wrapped.
    """
    n = len(week_metas)
    pace: PaceTargets | None = None
    specs: list[PhaseWeekSpec] = []
    prev_km: float | None = None
    for i, wm in enumerate(week_metas):
        pt, vt = build_specialist_context(
            db, goal=goal, phase_type=phase_type, week_meta=wm, level=level, as_of=as_of
        )
        # pace is athlete-level (identical every week) — keep the first one.
        if pace is None:
            pace = pt
        this_km = float(wm.target_weekly_km)
        # Deload heuristic: a dip below the previous week's target (week 1 never).
        is_deload = prev_km is not None and this_km < prev_km
        specs.append(
            PhaseWeekSpec(
                week_index=i + 1,
                n_weeks=n,
                week_folder=wm.week_folder,
                target_weekly_km=this_km,
                volume=vt,
                is_deload=is_deload,
            )
        )
        prev_km = this_km

    if pace is None:
        # No weeks → no pace table can be derived. This is a CALLER precondition
        # failure (empty week_metas was passed in) — it fires BEFORE any LLM
        # output exists, so it must NOT carry the ``parse_failed`` sentinel
        # (which is reserved for unparseable LLM responses and is caught +
        # retried by ``generate_specialist_phase``).
        raise ValueError("empty week_metas — nothing to generate")
    return pace, specs


# ---------------------------------------------------------------------------
# Batch parser (phase {"weeks":[…×N]} envelope → list[dict])
# ---------------------------------------------------------------------------


def parse_phase_batch(raw: str) -> list[dict]:
    """Parse the phase batch LLM output → the ``weeks`` list (unvalidated dicts).

    Reuses the adapter-layer 3-tier :func:`_parse_llm_output` (sentinel / fenced
    / balanced-braces) to recover the envelope object, then extracts its
    ``weeks`` list. Per-week ``WeeklyPlan`` validation happens in the caller —
    this only enforces the envelope shape.

    Raises:
        ValueError starting with ``"parse_failed"``: the 3-tier parse failed, or
            the parsed object has no ``weeks`` key / a non-list ``weeks``.
    """
    parsed = _parse_llm_output(raw)
    if parsed is None:
        raise ValueError(
            f"parse_failed: all 3 tiers failed (raw_len={len(raw)})"
        )
    if not isinstance(parsed, dict):
        raise ValueError(
            f"parse_failed: parsed output is {type(parsed).__name__}, not a dict envelope"
        )
    weeks = parsed.get("weeks")
    if not isinstance(weeks, list):
        raise ValueError(
            "parse_failed: envelope has no 'weeks' list "
            f"(keys={sorted(parsed.keys())})"
        )
    return weeks


# ---------------------------------------------------------------------------
# Phase generator
# ---------------------------------------------------------------------------


def generate_specialist_phase(
    phase: Phase,
    week_metas: list[WeekMeta],
    context: dict,
    injuries: list[str] | None = None,
    *,
    feedback: str | None = None,
) -> list[dict]:
    """Generate ALL weeks of one phase in a single LLM call.

    Mirrors ``generate_specialist_week`` at phase granularity: compute required
    context → compose the phase prompt → bind tools + tool-loop LLM → 3-tier
    batch parse (one retry) → validate each week.

    Args:
        phase: the ``stride_core.master_plan.Phase`` to fill — its ``phase_type``
            routes the specialist doctrine + tools.
        week_metas: ordered per-week ``WeekMeta`` (from ``derive_phase_weeks``).
            ``len(week_metas)`` is the exact week count N the LLM must emit.
        context: shared per-phase context — must carry ``user_id``, ``goal``
            (dict), ``level`` (athlete signal); may carry ``continuity``
            (ContinuitySignals dict) and ``prior_week_tail`` (str).
        injuries: optional injury flags — fed to the prompt context block AND
            bound into the strength_library tool so the LLM gets injury-safe
            T-codes.
        feedback: optional regen feedback (rule_filter violations / reviewer
            issues) → threaded into ``build_phase_system_prompt(feedback=...)``.

    Returns:
        A list of exactly ``len(week_metas)`` validated ``WeeklyPlan`` dicts —
        the week count is asserted (a mismatch is a retryable ``parse_failed``).
        Does NOT run rule_filter (PA-T4).

    Raises:
        ValueError starting with ``"parse_failed"``: the batch envelope could
            not be parsed, OR the batch returned a week count other than
            ``len(week_metas)`` — both after one retry. (A wrong count is a
            retryable generator fault, not a silent success: too few weeks would
            otherwise be mislabeled "blocked" downstream; zero weeks would look
            like a clean empty success.)
        ValueError starting with ``"bad_schema"``: a week in the batch is not a
            valid ``WeeklyPlan`` (or ``phase_type`` is unknown).
        LLMUnavailable / LLMError: propagated from the LLM client.
    """
    user_id = str(context.get("user_id") or "")
    goal = context.get("goal") or {}
    level = float(context.get("level") or 0.0)
    injuries = list(injuries or [])
    phase_type = _coerce_phase_type(phase.phase_type or PhaseType.BASE)

    # 1. Open the user DB once and build the shared pace table + per-week specs.
    db = Database(user=user_id)
    pace_targets, week_specs = build_phase_week_specs(
        db, goal=goal, phase_type=phase_type, week_metas=week_metas, level=level
    )

    # 2. Render the pre-rendered context block (continuity + prior tail + injuries).
    context_block = _render_context_block(
        continuity=context.get("continuity"),
        prior_week_tail=context.get("prior_week_tail"),
        injuries=injuries,
    )

    # 3. Compose the phase-at-once system prompt (one shared pace table, N week
    #    specs, optional regen feedback).
    system_prompt = build_phase_system_prompt(
        phase_type=phase_type,
        week_specs=week_specs,
        pace_targets=pace_targets,
        context_block=context_block,
        feedback=feedback,
    )

    user_text = (
        f"请基于上述阶段指导 + 注入的配速/逐周量预算，一次性生成整个阶段"
        f"（共 {len(week_specs)} 周）的训练计划 JSON 信封。"
    )

    # 4. Build the specialist's tool surface (empty for taper → plain invoke),
    #    bind it to the generator model, and run the langchain tool loop. Reuses
    #    the per-week adapter's _build_specialist_tools / tool wrappers.
    structured_tools = _build_specialist_tools(
        phase_type, user_id=user_id, injuries=injuries
    )

    def _run_one_pass() -> str:
        """One full tool-loop pass → final assistant text. Errors mapped to the
        same LLMError / LLMUnavailable semantics the per-week adapter uses."""
        try:
            llm = get_generator_llm()
        except CoachLLMUnavailable as exc:
            raise LLMUnavailable(str(exc)) from exc

        llm_with_tools = llm.bind_tools(structured_tools) if structured_tools else llm
        tool_map = {t.name: t for t in structured_tools}
        messages = [SystemMessage(content=system_prompt), HumanMessage(content=user_text)]
        try:
            return run_tool_loop(llm_with_tools, messages, tool_map)
        except CoachLLMUnavailable as exc:
            raise LLMUnavailable(str(exc)) from exc
        except (LLMError, LLMUnavailable):
            raise
        except BaseException as exc:  # noqa: BLE001 — LLM/tool boundary
            raise _map_exception(exc) from exc

    expected_n = len(week_specs)

    def _parse_and_count(raw_text: str) -> list[dict]:
        """Parse the batch envelope AND assert it carries exactly ``expected_n``
        weeks. A wrong count is raised as a ``parse_failed`` ``ValueError`` so it
        flows through the SAME one-retry loop a garbage / unparseable response
        takes — a phase-at-once generator that returns too few weeks (the
        missing weeks would otherwise be silently mislabeled "blocked" by the
        orchestrator) or too many (silently carried) gets one regen before we
        fail, instead of returning a quietly wrong batch."""
        week_dicts = parse_phase_batch(raw_text)
        if len(week_dicts) != expected_n:
            raise ValueError(
                f"parse_failed: batch returned {len(week_dicts)} weeks, "
                f"expected {expected_n}"
            )
        return week_dicts

    # 5. Tool-loop pass + batch parse + length check + one retry on failure
    #    (mirror the per-week adapter's parse_failed / one-retry semantics). The
    #    week-count assertion lives INSIDE _parse_and_count so a count mismatch
    #    participates in the retry exactly like an unparseable response.
    raw = _run_one_pass()
    try:
        week_dicts = _parse_and_count(raw)
    except ValueError:
        logger.warning(
            "generate_specialist_phase: parse_failed on first attempt "
            "(raw_len=%d) — retrying once",
            len(raw),
        )
        raw_retry = _run_one_pass()
        try:
            week_dicts = _parse_and_count(raw_retry)
        except ValueError as exc:
            err = ValueError(
                f"parse_failed: batch envelope unparseable or wrong-count twice "
                f"(raw1 len={len(raw)}, raw2 len={len(raw_retry)}): {exc}"
            )
            err.raw_output = raw_retry[:2000]  # type: ignore[attr-defined]
            raise err from exc

    # 6. Validate each week as a WeeklyPlan. Return the dicts that round-trip
    #    through from_dict (Stage sessions are aspirational, spec=None — we do
    #    not invent structured specs). A single bad week fails the whole batch
    #    with bad_schema, mirroring the per-week adapter's error semantics.
    validated: list[dict] = []
    for i, wk in enumerate(week_dicts):
        try:
            plan = WeeklyPlan.from_dict(wk)
        except (ValueError, KeyError, TypeError) as exc:
            raise ValueError(f"bad_schema: week {i + 1}/{len(week_dicts)}: {exc}") from exc
        validated.append(plan.to_dict())

    return validated
