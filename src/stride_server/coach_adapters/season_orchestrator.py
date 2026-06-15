"""Season orchestrator — ``generate_season`` (Stage-3b T5).

Drives the whole Stage-3a + 3b stack across every master-plan phase and
assembles the result into a :class:`~coach.schemas.SeasonPlanBundle`. This is
the top-level adapter that ties together all prior 3b tasks:

    per phase, in master_plan.phases order →
      derive_phase_weeks (T2, deterministic ramp; threads the prior phase exit
        volume in for cross-phase continuity)
      → generate_phase_weeks (Stage-3a T6, real generator + LLM + DB; blocked
        weeks excluded)
      → review_phase (T4, the per-phase doctrine reviewer; safe-degrades to
        ``revise``)
    → thread the phase's exit volume into the next phase
    → run_season_rule_filter (T3, cross-phase/week deterministic checks)
    → bounded regeneration of phases an error/review points at
    → assemble + return the SeasonPlanBundle

**Regeneration loop structure (chosen for simplicity + correctness):**

1. *Inline per-phase review-driven loop.* For each phase we run
   ``derive → generate → review`` up to ``max_phase_attempts`` times. We accept
   the first attempt whose review verdict is ``pass``; otherwise we keep the
   *best* attempt seen (``pass`` > ``auto_fix`` > ``revise`` > ``block``) and
   move on. This handles "review verdict drives a retry before moving on". The
   exit volume threaded forward is the accepted attempt's last-week run km.

2. *Final season-rule pass with one bounded targeted-regen round per offending
   phase.* After all phases are assembled into a bundle we run
   ``run_season_rule_filter``. Every error whose ``details`` attribute a
   specific phase (``phase_id`` / ``to_phase_id`` / ``taper_phase_id``) marks
   that phase for one more bounded ``derive → generate → review`` regen. We
   then re-assemble and re-run the season filter, repeating for at most
   ``max_phase_attempts`` season rounds. A season-wide error with no single
   owning phase (``blocked_week_budget``) is NOT phase-attributable — we cannot
   fix it by regenerating one phase, so it is left to surface in the returned
   bundle (logged) rather than spun on.

**Season-error → phase attribution map** (the part most prone to ambiguity —
resolved explicitly here):

  * ``volume_arc``        → ``details["phase_id"]``      (the phase the within-phase spike lives in)
  * ``phase_transition``  → ``details["to_phase_id"]``   (the *entering* phase whose first week spiked — regen the phase we step INTO, not the one we left, since its opening volume is what we control)
  * ``taper_peak_sanity`` → ``details["taper_phase_id"]`` (the taper phase that didn't drop)
  * ``milestone_coverage``→ warning only (never triggers regen)
  * ``blocked_week_budget`` → season-wide; NOT phase-attributable → no regen

**Bounded invariant (HARD):** every loop is bounded by ``max_phase_attempts``.
A persistent failure (reviewer always blocks, a season rule we can't satisfy by
regen) degrades into a returned bundle with the issues visible (the phase's
``review.verdict`` + the season report logged) — never an exception, never an
infinite loop. Generation/review failures inside ``generate_phase_weeks`` /
``review_phase`` are already swallowed by those callees (blocked weeks excluded;
review safe-degrades to ``revise``); this orchestrator additionally guards its
own per-phase work in a try/except so one bad phase cannot crash the season.

This is the **adapter** layer: it touches the LLM + DB (via the Stage-3a/3b
adapters it calls). Per-week run-km is single-sourced by reusing
``coach.graphs.generation.rule_filter._total_run_distance_m`` — never hand-rolled.
"""

from __future__ import annotations

import logging

from coach.graphs.generation.rule_filter import _total_run_distance_m
from coach.graphs.generation.season_rule_filter import (
    SeasonRuleReport,
    run_season_rule_filter,
)
from coach.graphs.generation.week_schedule import derive_phase_weeks
from coach.schemas import PhaseReview, PhaseWeeks, SeasonPlanBundle
from stride_core.master_plan import MasterPlan, Milestone, Phase
from stride_core.plan_spec import WeeklyPlan

from ..coach_runtime import get_generator_model
from .phase_review_adapter import review_phase
from .week_specialist_adapter import generate_phase_weeks

logger = logging.getLogger(__name__)


# Verdict ranking — higher is better (used to keep the "best" attempt).
_VERDICT_RANK = {"block": 0, "revise": 1, "auto_fix": 2, "pass": 3}

# Season-error rule → the details key that names the phase to regenerate. A rule
# absent from this map (e.g. blocked_week_budget) is NOT phase-attributable.
_SEASON_ERROR_PHASE_KEY = {
    "volume_arc": "phase_id",
    "phase_transition": "to_phase_id",
    "taper_peak_sanity": "taper_phase_id",
}


def _phase_milestones(
    phase: Phase, milestones: list[Milestone]
) -> list[Milestone]:
    """Milestones this phase owns (``phase_id`` match or ``id`` in ``milestone_ids``).

    Mirrors ``phase_review_adapter._phase_milestones`` — kept here too so the
    orchestrator passes the already-filtered list explicitly (``review_phase``
    re-filters defensively, which is a harmless no-op on a pre-filtered list).
    """
    owned_ids = set(phase.milestone_ids or [])
    return [m for m in milestones if m.phase_id == phase.id or m.id in owned_ids]


def _last_week_exit_km(weeks: list[dict]) -> float | None:
    """Run km of the last generated week, single-sourced via ``_total_run_distance_m``.

    Returns ``None`` when there are no weeks (all blocked) so the caller can
    carry the prior phase's exit volume forward rather than resetting.
    """
    if not weeks:
        return None
    last = weeks[-1]
    try:
        plan = WeeklyPlan.from_dict(last)
    except (ValueError, KeyError, TypeError):
        logger.warning(
            "season: last week of a phase failed to parse for exit-volume "
            "threading — treating exit volume as unknown"
        )
        return None
    return _total_run_distance_m(plan) / 1000.0


def _generate_one_phase(
    phase: Phase,
    *,
    prev_phase_end_km: float | None,
    context: dict,
    injuries: list[str],
    milestones: list[Milestone],
) -> PhaseWeeks:
    """One ``derive → generate → review`` pass for a single phase → ``PhaseWeeks``.

    Guards the whole pass: any unexpected error degrades to an empty-weeks
    PhaseWeeks with a safe-degrade ``revise`` review, so one bad phase never
    crashes the season (callees already degrade individually; this is the
    belt-and-braces outer guard the orchestration contract requires).
    """
    try:
        week_metas = derive_phase_weeks(phase, prev_phase_end_km=prev_phase_end_km)
        # WeekMeta → the dict descriptor contract generate_phase_weeks consumes.
        week_dicts = [
            {
                "phase_position": wm.phase_position,
                "week_folder": wm.week_folder,
                "target_weekly_km": wm.target_weekly_km,
            }
            for wm in week_metas
        ]
        plans = generate_phase_weeks(phase, week_dicts, context, injuries)
        review = review_phase(phase, plans, milestones=milestones)
        blocked = max(0, len(week_metas) - len(plans))
    except Exception as exc:  # noqa: BLE001 — one phase must not crash the season
        logger.warning(
            "season: phase %s (%s) generation pass raised %r — degrading to an "
            "empty-weeks PhaseWeeks (revise)",
            phase.id,
            phase.phase_type,
            exc,
        )
        plans = []
        review = PhaseReview(
            verdict="revise",
            commentary_md="(phase generation failed — degraded to revise)",
            issues=[],
        )
        blocked = 0

    return PhaseWeeks(
        phase_id=phase.id,
        phase_type=phase.phase_type or _fallback_phase_type(phase),
        weeks=plans,
        review=review,
        blocked_week_count=blocked,
    )


def _fallback_phase_type(phase: Phase):
    """``PhaseWeeks.phase_type`` is required (non-optional) but ``Phase.phase_type``
    is optional for backcompat. Default a typeless phase to BASE — the same
    fallback ``generate_phase_weeks`` uses for specialist routing — so the
    bundle schema is always satisfiable. ``phase`` is reserved (unused) — kept
    for call-site symmetry and future per-phase fallback logic."""
    from stride_core.master_plan import PhaseType

    return PhaseType.BASE


def _best_phase_attempt(
    phase: Phase,
    *,
    prev_phase_end_km: float | None,
    context: dict,
    injuries: list[str],
    milestones: list[Milestone],
    max_phase_attempts: int,
) -> PhaseWeeks:
    """Run the inline review-driven loop for one phase (bounded).

    Up to ``max_phase_attempts`` ``derive → generate → review`` passes. Accept
    the first ``pass``; otherwise keep the best-ranked attempt. Every loop is
    bounded by ``max_phase_attempts`` — never spins.
    """
    attempts = max(1, int(max_phase_attempts))
    best: PhaseWeeks | None = None
    for attempt in range(attempts):
        pw = _generate_one_phase(
            phase,
            prev_phase_end_km=prev_phase_end_km,
            context=context,
            injuries=injuries,
            milestones=milestones,
        )
        verdict = pw.review.verdict if pw.review is not None else "revise"
        if best is None or _VERDICT_RANK.get(verdict, 0) > _VERDICT_RANK.get(
            best.review.verdict if best.review is not None else "revise", 0
        ):
            best = pw
        if verdict == "pass":
            break
        if attempt + 1 < attempts:
            logger.info(
                "season: phase %s review=%s on attempt %d/%d — regenerating",
                phase.id,
                verdict,
                attempt + 1,
                attempts,
            )
    assert best is not None  # the loop runs at least once
    return best


def _attributed_phase_ids(report: SeasonRuleReport) -> set[str]:
    """Phase ids a season ERROR attributes to (regen targets).

    Only errors mapped in ``_SEASON_ERROR_PHASE_KEY`` are phase-attributable;
    season-wide errors (blocked_week_budget) and warnings never trigger regen.
    """
    targets: set[str] = set()
    for v in report.errors():
        key = _SEASON_ERROR_PHASE_KEY.get(v.rule)
        if key is None:
            continue
        pid = v.details.get(key)
        if isinstance(pid, str) and pid:
            targets.add(pid)
    return targets


def generate_season(
    master_plan: MasterPlan,
    context: dict,
    injuries: list[str] | None = None,
    *,
    generated_by: str | None = None,
    max_phase_attempts: int = 2,
) -> SeasonPlanBundle:
    """Generate a full season bundle across every master-plan phase.

    Args:
        master_plan: the confirmed ``MasterPlan`` whose phases drive generation.
        context: shared per-phase context for ``generate_phase_weeks`` — must
            carry ``user_id``, ``goal`` (dict), ``level``; may carry
            ``continuity``. Passed through unchanged per phase.
        injuries: optional injury flags, forwarded to every phase's generator +
            reviewer context.
        generated_by: provenance stamp; defaults to the configured generator
            model (``get_generator_model()``), matching the master-plan adapter.
        max_phase_attempts: bound on BOTH the inline review-driven regen loop
            (per phase) AND the number of season-rule regen rounds. Guarantees
            termination.

    Returns:
        A :class:`SeasonPlanBundle` with one :class:`PhaseWeeks` per phase, in
        order. A persistent per-phase failure leaves that phase's
        ``review.verdict`` (``revise`` / ``block``) visible; persistent season
        errors are logged. Never raises, never loops unbounded.
    """
    injuries = list(injuries or [])
    milestones = list(master_plan.milestones or [])

    # --- Pass 1: inline per-phase generation with review-driven regen. -------
    phase_results: list[PhaseWeeks] = []
    prev_exit_km: float | None = None
    for phase in master_plan.phases:
        owned = _phase_milestones(phase, milestones)
        pw = _best_phase_attempt(
            phase,
            prev_phase_end_km=prev_exit_km,
            context=context,
            injuries=injuries,
            milestones=owned,
            max_phase_attempts=max_phase_attempts,
        )
        phase_results.append(pw)
        # Thread the exit volume forward. If this phase produced zero weeks
        # (all blocked), CARRY the prior exit volume rather than resetting —
        # the next phase should still continue from the last real volume.
        exit_km = _last_week_exit_km(pw.weeks)
        if exit_km is not None:
            prev_exit_km = exit_km

    # --- Pass 2: season-rule pass + bounded targeted regen rounds. -----------
    # Index phases by id for targeted regen; remember each phase's position so a
    # regenerated PhaseWeeks slots back in order.
    phase_by_id = {p.id: p for p in master_plan.phases}
    pos_by_id = {p.id: i for i, p in enumerate(master_plan.phases)}

    season_rounds = max(1, int(max_phase_attempts))
    final_report: SeasonRuleReport | None = None
    for _round in range(season_rounds):
        bundle = _assemble(master_plan, phase_results, generated_by)
        report = run_season_rule_filter(bundle, master_plan)
        final_report = report
        if report.ok:
            break
        targets = _attributed_phase_ids(report)
        if not targets:
            # All errors are season-wide / non-attributable — regenerating a
            # single phase can't fix them. Stop and surface in the bundle.
            logger.warning(
                "season: %d season error(s) not attributable to a single phase "
                "— surfacing in the returned bundle without further regen: %s",
                len(report.errors()),
                [v.rule for v in report.errors()],
            )
            break
        if _round + 1 >= season_rounds:
            # Last allowed round already produced a bundle; don't regen again.
            break
        # Recompute the exit volume threaded INTO each targeted phase from the
        # current (accepted) weeks of the phase before it, so a regen re-derives
        # against the real upstream volume.
        for pid in targets:
            phase = phase_by_id.get(pid)
            if phase is None:
                continue
            idx = pos_by_id[pid]
            upstream_exit = _upstream_exit_km(phase_results, idx)
            owned = _phase_milestones(phase, milestones)
            regen = _best_phase_attempt(
                phase,
                prev_phase_end_km=upstream_exit,
                context=context,
                injuries=injuries,
                milestones=owned,
                max_phase_attempts=max_phase_attempts,
            )
            phase_results[idx] = regen
        logger.info(
            "season: regenerated %d phase(s) on season-error round %d/%d: %s",
            len(targets),
            _round + 1,
            season_rounds,
            sorted(targets),
        )

    bundle = _assemble(master_plan, phase_results, generated_by)
    if final_report is not None and not final_report.ok:
        logger.warning(
            "season: returned bundle still trips %d season error(s): %s",
            len(final_report.errors()),
            [v.message for v in final_report.errors()],
        )
    for w in (final_report.warnings() if final_report is not None else []):
        logger.info("season warning: %s", w.message)
    return bundle


def _upstream_exit_km(
    phase_results: list[PhaseWeeks], idx: int
) -> float | None:
    """Exit km threaded INTO the phase at ``idx`` — the nearest prior phase that
    has present weeks (carry-forward past all-blocked phases). ``None`` for the
    first phase / when no upstream phase has weeks."""
    for j in range(idx - 1, -1, -1):
        km = _last_week_exit_km(phase_results[j].weeks)
        if km is not None:
            return km
    return None


def _assemble(
    master_plan: MasterPlan,
    phase_results: list[PhaseWeeks],
    generated_by: str | None,
) -> SeasonPlanBundle:
    """Assemble the bundle. ``generated_by`` defaults to the configured
    generator model (same provenance as the master-plan adapter stamps)."""
    return SeasonPlanBundle(
        master_plan_id=master_plan.plan_id,
        generated_by=generated_by or get_generator_model(),
        phases=phase_results,
    )
