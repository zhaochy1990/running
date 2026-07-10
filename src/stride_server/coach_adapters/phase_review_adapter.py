"""Per-phase doctrine reviewer adapter (Stage-3b T4).

The LLM-driven half of the Stage-3b hybrid review. ``review_phase`` is what the
Stage-3b orchestrator (T5) calls after a phase's weeks are generated; it stores
the returned :class:`~coach.schemas.PhaseReview` in ``PhaseWeeks.review`` and
uses ``revise`` / ``block`` to trigger regeneration.

It:

1. filters the master-plan ``milestones`` down to the ones this phase owns,
2. renders a one-line milestone summary (quantifiable metric/target/comparator
   when present, else the natural-language target),
3. assembles the reviewer system prompt via the core
   :func:`coach.graphs.generation.phase_reviewer.build_phase_review_prompt`,
4. calls the **reviewer-role** LLM via ``get_reviewer_llm()`` (the ``[reviewer]``
   deployment from ``config/coach.toml`` — NOT the generator), plain
   single-shot chat: the reviewer needs NO tools, so the tool-loop machinery the
   week generator uses is unnecessary here. Using the reviewer role keeps the
   per-phase judge independent of the model that generated the weeks.
5. parses the XML via core :func:`parse_phase_review`.

**Safe-degrade contract**: a review failure must NOT crash the season. On any
LLM construction / call / parse failure the function returns a ``PhaseReview``
with ``verdict="revise"`` and a "review-unavailable" commentary. Rationale:
``revise`` lets the orchestrator regenerate/retry the phase (bounded by its own
iteration cap) rather than (a) silently shipping unverified weeks with ``pass``
or (b) hard-blocking the whole season with ``block``. The orchestrator can
always proceed.

This is the **adapter** layer: it touches the LLM, which ``coach.*`` core may
not. The prompt strings + XML parsing live in core (``phase_reviewer``); this
module only wires the LLM call + the milestone filtering/rendering.
"""

from __future__ import annotations

import logging

from coach.graphs.generation.phase_reviewer import (
    build_phase_review_prompt,
    parse_phase_review,
)
from coach.runtime.messages import extract_text
from coach.schemas import PhaseReview
from langchain_core.messages import HumanMessage, SystemMessage
from stride_core.master_plan import Milestone, Phase

from ..coach_runtime import get_reviewer_llm

logger = logging.getLogger(__name__)


_SAFE_DEGRADE_COMMENTARY = (
    "(review unavailable — 阶段评审 LLM 调用失败，降级为 revise 以便编排器重生本阶段)"
)


def _phase_milestones(
    phase: Phase, milestones: list[Milestone] | None
) -> list[Milestone]:
    """Filter ``milestones`` to the ones this phase owns.

    A milestone belongs to the phase if its ``phase_id`` matches ``phase.id`` or
    its ``id`` appears in ``phase.milestone_ids`` (the master plan keeps both
    back-refs; either is sufficient).
    """
    if not milestones:
        return []
    owned_ids = set(phase.milestone_ids or [])
    return [
        m
        for m in milestones
        if m.phase_id == phase.id or m.id in owned_ids
    ]


def _render_milestone_summary(milestones: list[Milestone]) -> str | None:
    """One-line natural-language summary of the phase's milestone(s).

    Prefers the quantifiable form (``metric comparator target_value`` —
    e.g. ``race_time_s_5k <= 1140``) appended to the natural-language target;
    falls back to the target text alone when no quantitative fields are set.
    Returns ``None`` when the phase owns no milestone.
    """
    if not milestones:
        return None
    parts: list[str] = []
    for m in milestones:
        target = (m.target or "").strip()
        quant = None
        if m.metric and m.target_value is not None and m.comparator:
            # strip trailing .0 for integer-valued targets so "1140" not "1140.0"
            tv = m.target_value
            tv_str = str(int(tv)) if float(tv).is_integer() else str(tv)
            quant = f"{m.metric} {m.comparator} {tv_str}"
        meta = " | ".join(
            token
            for token in (
                m.date,
                m.type.value,
                quant,
            )
            if token
        )
        body = target or quant
        if body and meta:
            parts.append(f"[{meta}] {body}")
        elif body:
            parts.append(body)
    return "；".join(parts) if parts else None


def review_phase(
    phase: Phase,
    weeks: list[dict],
    *,
    milestones: list[Milestone] | None = None,
) -> PhaseReview:
    """Judge a phase's generated weeks against doctrine + focus + milestone.

    Args:
        phase: the ``stride_core.master_plan.Phase`` being reviewed. Provides the
            ``phase_type`` (specialist doctrine routing) + ``focus`` string.
        weeks: the phase's generated weeks as WeeklyPlan dicts (the same list
            stored in ``PhaseWeeks.weeks``).
        milestones: the master-plan milestones; filtered to the ones this phase
            owns before rendering. ``None`` → the phase is judged on its
            physiological character alone.

    Returns:
        A :class:`PhaseReview` (``verdict`` + ``commentary_md`` + ``issues``).
        On any LLM/parse failure, a safe-degrade ``revise`` review (see module
        docstring) — never raises.
    """
    phase_type = phase.phase_type.value if phase.phase_type else "base"
    owned = _phase_milestones(phase, milestones)
    milestone_summary = _render_milestone_summary(owned)

    system_prompt = build_phase_review_prompt(
        phase_type=phase_type,
        phase_focus=phase.focus or "",
        milestone_summary=milestone_summary,
        weeks=weeks,
    )
    # The per-phase reviewer judges weeks with the reviewer-role deployment, not
    # the generator that produced them, so the review stays model-independent.
    # Plain single-shot langchain invoke (no tools): build the messages directly
    # rather than going through LLMClient (which is hardwired to the generator).
    lc_messages = [
        SystemMessage(content=system_prompt),
        HumanMessage(content="请评审本阶段已生成的周计划，并按规定 XML 格式输出。"),
    ]

    try:
        resp = get_reviewer_llm().invoke(lc_messages)
        raw = extract_text(getattr(resp, "content", resp)).strip()
    except Exception as exc:  # noqa: BLE001 — review failure (construct/call) must not crash the season
        logger.warning(
            "review_phase: LLM call failed for phase %s (%s) — degrading to revise: %s",
            phase.id,
            phase_type,
            exc,
        )
        return PhaseReview(
            verdict="revise",
            commentary_md=_SAFE_DEGRADE_COMMENTARY,
            issues=[],
        )

    try:
        review = parse_phase_review(raw)
        logger.info(
            "review_phase: phase %s (%s) doctrine review → verdict=%s (%d issue(s))",
            phase.id,
            phase_type,
            review.verdict,
            len(review.issues or []),
        )
        return review
    except Exception as exc:  # noqa: BLE001 — parse failure must not crash the season
        logger.warning(
            "review_phase: parse failed for phase %s (%s) — degrading to revise: %s",
            phase.id,
            phase_type,
            exc,
        )
        return PhaseReview(
            verdict="revise",
            commentary_md=_SAFE_DEGRADE_COMMENTARY,
            issues=[],
        )
