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
import math
import re
from dataclasses import replace
from datetime import date as date_cls, timedelta
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage

from coach.graphs.generation.phase_prompt import (
    PhaseWeekSpec,
    build_phase_system_prompt,
)
from coach.graphs.generation.rule_filter import RuleViolation, run_rule_filter
from coach.graphs.generation.weekly_prompt import WeekMeta
from coach.runtime.llm_factory import CoachLLMUnavailable
from coach.runtime.tool_loop import run_tool_loop
from coach.schemas import PaceTargets
from stride_storage.sqlite.database import Database
from stride_core.master_plan import Milestone, MilestoneType, Phase, PhaseType
from stride_core.plan_spec import WeeklyPlan
from stride_core.timefmt import today_shanghai

from ..coach_runtime import get_generator_llm
from ..llm_client import LLMError, LLMUnavailable, _map_exception
from ..master_plan_generator import _parse_llm_output
from .phase_review_adapter import _render_milestone_summary
from .week_specialist_adapter import (
    _build_specialist_tools,
    _coerce_phase_type,
    _coerce_week_meta,
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
    milestones: list[Milestone] | None = None,
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
    milestone_long_runs = _milestone_long_run_by_folder(specs, list(milestones or []))
    if milestone_long_runs:
        specs = [
            replace(
                spec,
                volume=_with_long_run_budget(
                    spec.volume,
                    long_run_km=milestone_long_runs.get(spec.week_folder, spec.volume.long_run_km),
                ),
            )
            for spec in specs
        ]
    return pace, specs


def _parse_week_start(folder: str) -> date_cls | None:
    try:
        return date_cls.fromisoformat(str(folder)[:10])
    except ValueError:
        return None


def _explicit_km_values(text: str | None) -> list[float]:
    if not text:
        return []
    return [
        float(m.group(1))
        for m in re.finditer(r"(\d+(?:\.\d+)?)\s*(?:km|公里)", text, flags=re.I)
    ]


def _required_long_run_km(milestone: Milestone) -> float | None:
    metric = (milestone.metric or "").lower()
    candidates: list[float] = []
    if metric in {"long_run_km", "race_pace_km"} and milestone.target_value:
        candidates.append(float(milestone.target_value))
    if milestone.type is MilestoneType.LONG_RUN or metric in {"long_run_km", "race_pace_km"}:
        candidates.extend(_explicit_km_values(milestone.target))
    return max(candidates) if candidates else None


def _ceil_1dp(value: float) -> float:
    return math.ceil(value * 10) / 10


def _milestone_long_run_by_folder(
    week_specs: list[PhaseWeekSpec], milestones: list[Milestone]
) -> dict[str, float]:
    by_folder: dict[str, float] = {}
    for milestone in milestones:
        required = _required_long_run_km(milestone)
        if required is None:
            continue
        try:
            mdate = date_cls.fromisoformat(milestone.date)
        except (TypeError, ValueError):
            continue
        for spec in week_specs:
            start = _parse_week_start(spec.week_folder)
            if start is None or not (start <= mdate <= start + timedelta(days=6)):
                continue
            cap = spec.target_weekly_km * 0.35
            adjusted = min(_ceil_1dp(required), math.floor(cap * 10) / 10)
            by_folder[spec.week_folder] = max(by_folder.get(spec.week_folder, 0.0), adjusted)
            break
    return by_folder


def _with_long_run_budget(volume: Any, *, long_run_km: float) -> Any:
    current = float(volume.long_run_km)
    target = max(current, float(long_run_km))
    if target <= current:
        return volume
    easy = max(float(volume.easy_km) - (target - current), 0.0)
    return volume.model_copy(
        update={
            "long_run_km": round(target, 1),
            "easy_km": round(easy, 1),
        }
    )


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
    milestones: list[Milestone] | None = None,
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
        milestones: optional — the phase's OWNED ``Milestone`` list. Rendered to
            a one-line summary via the reviewer's ``_render_milestone_summary``
            (single source — the generator and reviewer see the SAME milestone
            framing) and injected into the generation prompt so the generator
            designs the phase (long-run progression, deload placement) toward the
            milestone on the FIRST try. ``None`` / empty → no milestone block.
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
        db,
        goal=goal,
        phase_type=phase_type,
        week_metas=week_metas,
        level=level,
        milestones=list(milestones or []),
    )

    # 2. Render the pre-rendered context block (continuity + prior tail + injuries).
    context_block = _render_context_block(
        continuity=context.get("continuity"),
        prior_week_tail=context.get("prior_week_tail"),
        injuries=injuries,
    )

    # 3. Compose the phase-at-once system prompt (one shared pace table, N week
    #    specs, the phase's milestone target, optional regen feedback). The
    #    milestone is rendered by the SAME helper the reviewer uses
    #    (_render_milestone_summary) so the generator designs toward, and the
    #    reviewer judges against, identical milestone framing — single source.
    milestone_summary = _render_milestone_summary(list(milestones or []))
    system_prompt = build_phase_system_prompt(
        phase_type=phase_type,
        week_specs=week_specs,
        pace_targets=pace_targets,
        context_block=context_block,
        milestone_summary=milestone_summary,
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


# ---------------------------------------------------------------------------
# Phase rule_filter + feedback-regeneration loop (phase-at-once PA-T4)
# ---------------------------------------------------------------------------


def _format_rule_feedback(
    per_week_errors: list[tuple[int, list[RuleViolation]]],
) -> str:
    """Render the per-week rule violations into a regen feedback string.

    ``per_week_errors`` is a list of ``(week_index_0based, [RuleViolation…])``.
    Each violation becomes one line naming the **1-based** week + the rule +
    its message, e.g.::

        第 3 周违反 long_run_share：longest run is 41% of weekly volume (limit 35%)

    The next regen (inside ``generate_phase_validated``) threads this back
    through ``generate_specialist_phase(feedback=…)`` so the LLM fixes the SPECIFIC
    week + rule instead of blindly regenerating the whole phase (the old waste).
    """
    lines: list[str] = []
    for week_idx, errors in per_week_errors:
        for v in errors:
            lines.append(
                f"第 {week_idx + 1} 周违反 {v.rule}：{v.message}"
            )
    header = (
        "上一次生成违反了以下硬性规则（rule_filter），请在本次重新生成时"
        "**逐条修复**对应周次的问题，不要重复同样的错误："
    )
    return header + "\n" + "\n".join(lines)


def generate_phase_validated(
    phase: Phase,
    week_metas: list[dict | WeekMeta],
    context: dict,
    injuries: list[str] | None = None,
    *,
    milestones: list[Milestone] | None = None,
    feedback: str | None = None,
    max_attempts: int = 3,
) -> list[dict]:
    """Generate a whole phase, rule-gate each week, regen-with-feedback, drop strays.

    The name signals the value-add over the inner ``generate_specialist_phase``
    (one UN-gated generation pass): this wrapper returns only **rule-validated**
    weeks. A caller wanting the rule_filter safety gate must call THIS, not the
    inner generator — calling the wrong one would silently skip the gate.

    The phase-at-once replacement for the per-week ``generate_phase_weeks`` loop.
    It generates the entire phase in one LLM call (``generate_specialist_phase``,
    PA-T3), runs the deterministic ``run_rule_filter`` on each week, and — when a
    week violates a HARD rule — regenerates the phase **with the specific
    violations fed back** (bounded by ``max_attempts``). Persistently-violating
    weeks are dropped; only rule-clean weeks are returned.

    **prev_week_km = deterministic target (not generated km).** For week ``i``
    the progression check uses ``week_metas[i-1].target_weekly_km`` — the
    DETERMINISTIC week target the generator aims at — NOT the prior generated
    km. This makes each week's check **independent** of whether its predecessor
    was kept or dropped (which is what lets phase-at-once work: a dropped week
    never perturbs its successor's gate). Week 0 has no within-phase predecessor
    so ``prev_week_km=None``; the cross-phase boundary is checked separately by
    ``run_season_rule_filter`` (not here).

    Args:
        phase: the ``Phase`` to fill (routes the specialist doctrine + tools).
        week_metas: ordered per-week descriptors (dict or ``WeekMeta``). Coerced
            via ``_coerce_week_meta``; ``len(week_metas)`` is the requested week
            count N.
        context: shared per-phase context — ``user_id``, ``goal`` (dict),
            ``level``; may carry ``continuity`` / ``prior_week_tail``.
        injuries: optional injury flags — fed to the prompt AND to the
            rule_filter ``injury_conflict`` check.
        milestones: optional — the phase's OWNED ``Milestone`` list, threaded
            into every ``generate_specialist_phase`` call so the generator
            designs toward the SAME milestone the reviewer judges against
            (OPT-B). ``None`` / empty → no milestone block.
        feedback: optional EXTERNAL feedback (the reviewer's issues from the
            orchestrator, PA-T5 — ``None`` for a fresh generation). Used on the
            FIRST attempt only; later attempts carry the rule-violation feedback
            from the prior attempt instead.
        max_attempts: hard bound on generation attempts (default 3). EVERY loop
            here is bounded by it — a persistently-failing phase never spins.

    Returns:
        The list of rule-clean ``WeeklyPlan`` dicts (length ≤ ``len(week_metas)``;
        the caller computes ``blocked_week_count`` from the difference). Returns
        ``[]`` if ``generate_specialist_phase`` persistently fails to parse /
        validate (whole-phase degrade — the caller then marks every week blocked).

    Never raises: a ``parse_failed`` / ``bad_schema`` that survives PA-T3's own
    retry is caught here and degraded to ``[]`` (the orchestrator contract wants
    fewer/zero weeks, never an exception out of ``generate_phase_validated``).
    A ``max_attempts <= 0`` (empty loop) degrades to ``[]`` rather than raising.
    """
    metas: list[WeekMeta] = [_coerce_week_meta(w) for w in week_metas]
    if not metas:
        return []

    user_id = str(context.get("user_id") or "")
    goal = context.get("goal") or {}
    level = float(context.get("level") or 0.0)
    injuries = list(injuries or [])
    phase_type = _coerce_phase_type(phase.phase_type or PhaseType.BASE)

    # 1. Compute the deterministic, athlete-level rule_filter inputs ONCE. The
    #    Z4-Z5 threshold = pace_targets.threshold_pace_s_km comes from the SAME
    #    build_specialist_context call PA-T3 makes (single-sourced — never a
    #    divergent recompute). One DB handle for the whole loop.
    db = Database(user=user_id)
    pace_targets, _vt = build_specialist_context(
        db, goal=goal, phase_type=phase_type, week_meta=metas[0], level=level
    )
    z45_threshold = pace_targets.threshold_pace_s_km

    # prev_week_km per week i = the prior deterministic LOAD target. Planned
    # deloads are observable as target dips in the metas; the following load
    # week is compared to the last load target, not the deload trough. This
    # mirrors the season/master-plan volume rules and avoids dropping valid
    # post-deload rebounds.
    prev_km_for: list[float | None] = []
    last_load_target: float | None = None
    prev_target: float | None = None
    for i, meta in enumerate(metas):
        current_target = float(meta.target_weekly_km)
        is_deload = prev_target is not None and current_target < prev_target
        prev_km_for.append(prev_target if is_deload else last_load_target)
        if not is_deload:
            last_load_target = current_target
        prev_target = current_target

    # 2. Bounded attempt loop. First attempt carries the EXTERNAL feedback (the
    #    reviewer's issues, or None); later attempts carry the prior attempt's
    #    rule violations.
    current_feedback: str | None = feedback
    last_clean: list[dict] = []
    # Hoisted out of the loop so an empty loop (max_attempts <= 0) degrades to
    # the post-loop drop code with both bound (== []) instead of a NameError —
    # this is what makes the documented "never raises" contract hold.
    per_week_errors: list[tuple[int, list[RuleViolation]]] = []
    n_weeks = len(metas)
    for attempt in range(1, max_attempts + 1):
        logger.info(
            "phase %s: generating %d weeks in one call (attempt %d/%d%s)",
            phase_type.value,
            n_weeks,
            attempt,
            max_attempts,
            ", with feedback" if current_feedback else "",
        )
        try:
            weeks = generate_specialist_phase(
                phase,
                metas,
                context,
                injuries,
                milestones=milestones,
                feedback=current_feedback,
            )
        except (LLMUnavailable, LLMError):
            # Real LLM-infra failure — not a content fault we can regen our way
            # out of. Degrade the whole phase (contract: never raise).
            logger.warning(
                "generate_phase_validated: phase %s LLM unavailable/error on attempt %d/%d "
                "— degrading to 0 weeks",
                phase_type.value,
                attempt,
                max_attempts,
                exc_info=True,
            )
            return []
        except ValueError as exc:
            # parse_failed / bad_schema survived PA-T3's own retry → whole phase
            # failed to generate. Degrade to [] (caller marks all weeks blocked).
            logger.warning(
                "generate_phase_validated: phase %s generation failed on attempt %d/%d "
                "(%s) — degrading to 0 weeks",
                phase_type.value,
                attempt,
                max_attempts,
                str(exc)[:200],
            )
            return []

        # 3. Run rule_filter on each week with the target-based prev_week_km.
        per_week_errors = []
        for i, wk in enumerate(weeks):
            report = run_rule_filter(
                wk,
                prev_week_km=prev_km_for[i],
                target_weekly_km=float(metas[i].target_weekly_km),
                injuries=injuries or None,
                z45_pace_threshold_s_km=z45_threshold,
            )
            errs = report.errors()
            if errs:
                per_week_errors.append((i, errs))

        # 4. No errors anywhere → the whole phase is clean, return it.
        if not per_week_errors:
            logger.info(
                "phase %s: %d/%d weeks rule-clean (0 dropped)",
                phase_type.value,
                n_weeks,
                n_weeks,
            )
            return weeks

        last_clean = [
            wk
            for i, wk in enumerate(weeks)
            if i not in {idx for idx, _ in per_week_errors}
        ]

        # 5. Attempts remain → build the rule-violation feedback and regen.
        if attempt < max_attempts:
            current_feedback = _format_rule_feedback(per_week_errors)
            logger.info(
                "generate_phase_validated: phase %s attempt %d/%d had %d violating week(s) "
                "— regenerating with rule feedback",
                phase_type.value,
                attempt,
                max_attempts,
                len(per_week_errors),
            )

    # 6. Attempts exhausted with violations remaining → keep the rule-clean
    #    weeks, DROP the persistently-violating ones (log a warning per drop).
    #    last_clean was set on the final attempt above.
    for i, errs in per_week_errors:
        rules = ", ".join(sorted({v.rule for v in errs}))
        logger.warning(
            "generate_phase_validated: phase %s week %s (index %d) persistently violates "
            "[%s] after %d attempts — DROPPING it",
            phase_type.value,
            metas[i].week_folder,
            i,
            rules,
            max_attempts,
        )
    logger.info(
        "phase %s: %d/%d weeks rule-clean (%d dropped)",
        phase_type.value,
        len(last_clean),
        n_weeks,
        len(per_week_errors),
    )
    return last_clean
