"""Season orchestrator — ``generate_season`` (Stage-3b T5).

Drives the whole Stage-3a + 3b stack across every master-plan phase and
assembles the result into a :class:`~coach.schemas.SeasonPlanBundle`. This is
the top-level adapter that ties together all prior 3b tasks:

    per phase, in master_plan.phases order →
      derive_phase_weeks (T2, deterministic ramp; threads the prior phase exit
        volume in for cross-phase continuity)
      → generate_phase_validated (phase-at-once PA-T4, real generator + LLM + DB;
        whole phase in one call, rule-gated per week, regen-with-feedback,
        persistently-violating weeks dropped)
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
   volume threaded forward is the accepted attempt's *representative working
   volume* (its MAX week, via ``representative_working_km``), NOT its last week
   — a phase often ENDS on a planned deload trough, and threading that trough
   would anchor the next phase low and compound volume suppression across the
   season so phases never reach their prescribed bands (Stage-3b I1). Resuming
   the prior phase's established working load after a deload is physiologically
   safe, and ``check_phase_transition`` uses the same working-volume baseline so
   the resumption never reads as a boundary spike.

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
infinite loop. Generation/review failures inside ``generate_phase_validated`` /
``review_phase`` are already swallowed by those callees (violating weeks dropped
or whole-phase degraded to []; review safe-degrades to ``revise``); this
orchestrator additionally guards its own per-phase work in a try/except so one
bad phase cannot crash the season.

This is the **adapter** layer: it touches the LLM + DB (via the Stage-3a/3b
adapters it calls). Per-phase volume is single-sourced by reusing
``coach.graphs.generation.week_schedule.representative_working_km`` (which in
turn derives km via ``rule_filter._total_run_distance_m``) — never hand-rolled.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import date as date_cls, timedelta
import logging
import math

from coach.graphs.generation.season_rule_filter import (
    SeasonRuleReport,
    run_season_rule_filter,
)
from coach.graphs.generation.rule_filter import MAX_WEEKLY_RAMP_RATIO
from coach.graphs.generation.week_schedule import (
    derive_phase_weeks,
    representative_working_km,
)
from coach.graphs.generation.weekly_prompt import WeekMeta
from coach.schemas import PhaseReview, PhaseWeeks, SeasonPlanBundle
from stride_core.master_plan import MasterPlan, MasterPlanWeek, Milestone, Phase
from stride_storage.sqlite.database import Database

from ..coach_runtime import get_generator_model
from .phase_review_adapter import review_phase
from .phase_specialist_adapter import generate_phase_validated

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


def _phase_exit_km(weeks: list[dict]) -> float | None:
    """The volume to thread into the NEXT phase (Stage-3b I1).

    This is the phase's *representative working volume* — the MAX per-week run km
    across its generated weeks — NOT the literal last week. The last week is
    frequently a planned deload trough (or a still-climbing sub-band week);
    threading it forward would anchor the next phase from that trough, and the
    HARD ≤1.10× ramp cap would then suppress volume that compounds across phases
    so the season never reaches its prescribed bands. The working volume is what
    the athlete actually trained at — resuming it after a planned deload is
    physiologically safe, and ``check_phase_transition`` uses the same
    working-volume baseline so the resumption never trips a false boundary spike.

    Single-sourced via ``week_schedule.representative_working_km`` (km derived by
    ``rule_filter._total_run_distance_m``). Returns ``None`` when there are no
    weeks (all blocked) so the caller carries the prior phase's volume forward
    rather than resetting.
    """
    return representative_working_km(weeks)


def _phase_label(phase: Phase) -> str:
    if phase.name:
        return phase.name
    if phase.phase_type is not None:
        return phase.phase_type.value
    return "训练"


def _week_folder(week_start: date_cls, phase_week_index: int) -> str:
    week_end = week_start + timedelta(days=6)
    return f"{week_start.isoformat()}_{week_end.strftime('%m-%d')}(W{phase_week_index})"


def _master_week_target_km(week: MasterPlanWeek) -> float:
    high = float(week.target_weekly_km_high or 0.0)
    if high > 0:
        return high
    return float(week.target_weekly_km_low or 0.0)


def _master_week_metas_for_phase(
    phase: Phase, master_weeks: list[MasterPlanWeek]
) -> list[WeekMeta]:
    """Convert S1's week-level skeleton into S2 ``WeekMeta`` rows.

    ``MasterPlan.weeks`` is the strategic source of truth when present. The
    older deterministic phase-band expander remains a fallback for legacy plans
    that have no week skeleton.
    """
    owned: list[MasterPlanWeek] = [w for w in master_weeks if w.phase_id == phase.id]
    if not owned:
        return []
    owned.sort(key=lambda w: (w.week_index, w.week_start))
    label = _phase_label(phase)
    n = len(owned)
    out: list[WeekMeta] = []
    for i, week in enumerate(owned, start=1):
        try:
            week_start = date_cls.fromisoformat(week.week_start)
        except (TypeError, ValueError):
            continue
        out.append(
            WeekMeta(
                phase_position=f"{label} week {i}/{n}",
                week_folder=_week_folder(week_start, i),
                target_weekly_km=round(_master_week_target_km(week), 1),
            )
        )
    return out


def _resolve_phase_week_metas(
    phase: Phase,
    *,
    prev_phase_end_km: float | None,
    milestones: list[Milestone],
    master_weeks: list[MasterPlanWeek],
) -> list[WeekMeta]:
    from_master = _master_week_metas_for_phase(phase, master_weeks)
    if from_master:
        return from_master
    return derive_phase_weeks(
        phase,
        prev_phase_end_km=prev_phase_end_km,
        milestones=milestones,
    )


def _float_from_mapping(raw: object, *keys: str) -> float | None:
    if not isinstance(raw, dict):
        return None
    for key in keys:
        value = raw.get(key)
        if value in (None, ""):
            continue
        try:
            out = float(value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(out):
            return out
    return None


def _floor_1dp(value: float) -> float:
    return math.floor((float(value) + 1e-9) * 10.0) / 10.0


def _first_week_start(master_plan: MasterPlan) -> date_cls | None:
    starts: list[date_cls] = []
    for week in master_plan.weeks or master_plan.weekly_key_sessions or []:
        try:
            starts.append(date_cls.fromisoformat(week.week_start))
        except (TypeError, ValueError):
            continue
    if starts:
        return min(starts)
    for phase in master_plan.phases:
        try:
            starts.append(date_cls.fromisoformat(phase.start_date))
        except (TypeError, ValueError):
            continue
    return min(starts) if starts else None


@dataclass(frozen=True)
class _ActualExecutionBaseline:
    last_week_km: float
    last_week_dose: float | None = None
    acute_load: float | None = None
    chronic_load: float | None = None


def _last_completed_week_actual(
    user_id: str, first_week_start: date_cls
) -> _ActualExecutionBaseline | None:
    from stride_core.training_load import TRAINING_LOAD_MODEL_VERSION

    prev_start = first_week_start - timedelta(days=7)
    prev_end = first_week_start - timedelta(days=1)
    try:
        db = Database(user=user_id)
        running = db.get_running_week_summaries([
            (0, prev_start.isoformat(), prev_end.isoformat())
        ]).get(0, {})
        dose, load_row = db.fetch_completed_week_training_load(
            prev_start.isoformat(), prev_end.isoformat(),
            algorithm_version=TRAINING_LOAD_MODEL_VERSION,
        )
    except Exception as exc:  # noqa: BLE001 — execution cap is best-effort context
        logger.warning("season: failed to read last completed week actual load: %s", exc)
        return None
    km = float(running.get("actual_distance_km") or 0.0)
    if km <= 0:
        return None
    dose = float(dose or 0.0)
    acute = float(load_row["acute_load"]) if load_row and load_row["acute_load"] is not None else None
    chronic = float(load_row["chronic_load"]) if load_row and load_row["chronic_load"] is not None else None
    return _ActualExecutionBaseline(
        last_week_km=round(km, 1),
        last_week_dose=round(dose, 1) if dose > 0 else None,
        acute_load=round(acute, 1) if acute is not None else None,
        chronic_load=round(chronic, 1) if chronic is not None else None,
    )


def _last_completed_week_actual_km(user_id: str, first_week_start: date_cls) -> float | None:
    baseline = _last_completed_week_actual(user_id, first_week_start)
    return baseline.last_week_km if baseline is not None else None


def _readiness_adjusted_first_ratio(
    requested_ratio: float,
    *,
    last_week_km: float,
    last_week_dose: float | None,
    acute_load: float | None,
    chronic_load: float | None,
    max_end_ratio: float = 1.25,
) -> float:
    if acute_load is None or chronic_load is None or chronic_load <= 0:
        return requested_ratio
    if last_week_dose is None or last_week_dose <= 0 or last_week_km <= 0:
        return requested_ratio

    # Predict the end-of-week ATL/CTL after executing a constant daily planned
    # dose. Keep the final ratio out of overreach (>1.25), not just the first
    # day's ratio. This mirrors STRIDE PMC's 7/42-day EWMA constants.
    k_acute = 1.0 - math.exp(-1.0 / 7.0)
    k_chronic = 1.0 - math.exp(-1.0 / 42.0)

    def _end_ratio(weekly_dose: float) -> float:
        acute = float(acute_load)
        chronic = float(chronic_load)
        daily = weekly_dose / 7.0
        for _ in range(7):
            acute += k_acute * (daily - acute)
            chronic += k_chronic * (daily - chronic)
        return acute / chronic if chronic > 0 else float("inf")

    proposed_dose = last_week_dose * requested_ratio
    if _end_ratio(proposed_dose) <= max_end_ratio:
        return requested_ratio

    lo = 0.0
    hi = proposed_dose
    for _ in range(40):
        mid = (lo + hi) / 2.0
        if _end_ratio(mid) <= max_end_ratio:
            lo = mid
        else:
            hi = mid
    dose_ratio = lo / last_week_dose if last_week_dose > 0 else requested_ratio
    return max(0.0, min(requested_ratio, dose_ratio))


@dataclass
class _ActualExecutionCapper:
    """Safety cap for future week targets after recent under-execution."""

    last_load_km: float
    last_week_dose: float | None = None
    acute_load: float | None = None
    chronic_load: float | None = None
    first_ramp_ratio: float = 1.15
    planned_ramp_ratio: float = MAX_WEEKLY_RAMP_RATIO
    prev_target_km: float | None = None
    _used_actual_baseline: bool = False

    @classmethod
    def from_context(
        cls, context: dict, *, master_plan: MasterPlan
    ) -> "_ActualExecutionCapper | None":
        raw = context.get("actual_execution") or context.get("execution_adjustment")
        baseline = _float_from_mapping(
            raw,
            "last_week_km",
            "last_actual_week_km",
            "actual_last_week_km",
            "completed_week_km",
        )
        last_week_dose = _float_from_mapping(
            raw,
            "last_week_dose",
            "last_week_training_dose",
            "last_actual_week_dose",
            "completed_week_dose",
            "training_dose",
        )
        acute_load = _float_from_mapping(raw, "acute_load", "last_acute_load", "current_acute_load")
        chronic_load = _float_from_mapping(raw, "chronic_load", "last_chronic_load", "current_chronic_load")
        if baseline is None:
            user_id = str(context.get("user_id") or master_plan.user_id or "")
            first = _first_week_start(master_plan)
            if user_id and first is not None:
                actual = _last_completed_week_actual(user_id, first)
                if actual is not None:
                    baseline = actual.last_week_km
                    last_week_dose = last_week_dose if last_week_dose is not None else actual.last_week_dose
                    acute_load = acute_load if acute_load is not None else actual.acute_load
                    chronic_load = chronic_load if chronic_load is not None else actual.chronic_load
        if baseline is None or baseline <= 0:
            return None
        ratio = _float_from_mapping(raw, "max_ramp_ratio", "ramp_ratio") or 1.15
        # The requested safety envelope is 10-15%; never allow a context value to
        # widen the first rebound beyond 15%. Subsequent generated weeks still
        # obey the repository's weekly progression hard gate (10%).
        ratio = min(max(ratio, 1.0), 1.15)
        ratio = _readiness_adjusted_first_ratio(
            ratio,
            last_week_km=float(baseline),
            last_week_dose=last_week_dose,
            acute_load=acute_load,
            chronic_load=chronic_load,
        )
        return cls(
            last_load_km=round(baseline, 1),
            last_week_dose=round(last_week_dose, 1) if last_week_dose is not None else None,
            acute_load=round(acute_load, 1) if acute_load is not None else None,
            chronic_load=round(chronic_load, 1) if chronic_load is not None else None,
            first_ramp_ratio=ratio,
        )

    def apply(self, metas: list[WeekMeta]) -> list[WeekMeta]:
        capped: list[WeekMeta] = []
        for meta in metas:
            target = float(meta.target_weekly_km)
            is_deload = self.prev_target_km is not None and target < self.prev_target_km
            if is_deload:
                emitted = target
            else:
                ratio = (
                    self.first_ramp_ratio
                    if not self._used_actual_baseline
                    else self.planned_ramp_ratio
                )
                ceiling = _floor_1dp(self.last_load_km * ratio)
                emitted = min(target, ceiling) if ceiling > 0 else target
                self.last_load_km = emitted
                self._used_actual_baseline = True
            emitted = round(emitted, 1)
            capped.append(replace(meta, target_weekly_km=emitted))
            self.prev_target_km = emitted
        return capped


def _review_feedback(review: PhaseReview | None) -> str | None:
    """Render a prior attempt's ``PhaseReview`` into a regen feedback string.

    Threaded into ``generate_phase_validated(feedback=…)`` on attempt ≥2 so the
    whole-phase regeneration actually addresses the reviewer's critique instead
    of blindly re-running with identical inputs (the old no-op regen, fixed in
    PA-T5). Renders the verdict-driving ``commentary_md`` plus one bullet per
    ``ReviewIssue`` (``review_class`` + ``severity`` + ``message``, with the
    optional ``suggested_action`` appended).

    Returns ``None`` when there is nothing actionable to feed back (no review,
    or an empty commentary + no issues) so attempt-1-style fresh generation is
    preserved rather than threading an empty header.
    """
    if review is None:
        return None
    commentary = (review.commentary_md or "").strip()
    issues = review.issues or []
    if not commentary and not issues:
        return None
    lines: list[str] = [
        "上一轮阶段评审意见（verdict="
        + review.verdict
        + "，请逐条改进，不要重复同样的问题）："
    ]
    if commentary:
        lines.append(commentary)
    for iss in issues:
        bullet = f"- [{iss.review_class}/{iss.severity}] {iss.message}"
        action = (iss.suggested_action or "").strip()
        if action:
            bullet += f"（建议：{action}）"
        lines.append(bullet)
    return "\n".join(lines)


def _generate_one_phase(
    phase: Phase,
    *,
    week_metas: list[WeekMeta],
    prev_phase_end_km: float | None,
    context: dict,
    injuries: list[str],
    milestones: list[Milestone],
    feedback: str | None = None,
) -> PhaseWeeks:
    """One ``derive → generate → review`` pass for a single phase → ``PhaseWeeks``.

    ``feedback`` (the prior attempt's reviewer critique, rendered by
    :func:`_review_feedback`) is threaded into the phase-at-once generator's
    FIRST generation so a review-driven regen is productive (PA-T5); ``None`` on
    the fresh first attempt.

    Guards the whole pass: any unexpected error degrades to an empty-weeks
    PhaseWeeks with a safe-degrade ``revise`` review, so one bad phase never
    crashes the season (callees already degrade individually; this is the
    belt-and-braces outer guard the orchestration contract requires).
    """
    try:
        # Phase-at-once generation: one LLM call for the whole phase, rule-gated
        # per week, regen-with-rule-feedback, strays dropped. Takes WeekMeta
        # objects directly (no dict conversion). ``feedback`` threads the prior
        # attempt's reviewer critique into the first generation (PA-T5).
        plans = generate_phase_validated(
            phase,
            week_metas,
            context,
            injuries,
            milestones=milestones,
            feedback=feedback,
        )
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
    fallback the phase-at-once generator uses for specialist routing — so the
    bundle schema is always satisfiable. ``phase`` is reserved (unused) — kept
    for call-site symmetry and future per-phase fallback logic."""
    from stride_core.master_plan import PhaseType

    return PhaseType.BASE


def _best_phase_attempt(
    phase: Phase,
    *,
    week_metas: list[WeekMeta],
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

    **Productive regen (PA-T5):** attempt 1 generates fresh (``feedback=None``);
    each subsequent attempt threads the PRIOR attempt's reviewer critique
    (rendered via :func:`_review_feedback`) into ``generate_phase_validated`` so
    the whole-phase regeneration actually addresses the critique — replacing the
    old blind re-run with identical inputs that changed nothing.
    """
    attempts = max(1, int(max_phase_attempts))
    best: PhaseWeeks | None = None
    prev_review: PhaseReview | None = None
    for attempt in range(attempts):
        # attempt 0 → no feedback (fresh); later → the prior attempt's critique.
        feedback = _review_feedback(prev_review) if attempt > 0 else None
        if attempt > 0 and feedback:
            logger.info(
                "season: phase %s regenerating attempt %d/%d WITH reviewer feedback",
                phase.id,
                attempt + 1,
                attempts,
            )
        pw = _generate_one_phase(
            phase,
            week_metas=week_metas,
            prev_phase_end_km=prev_phase_end_km,
            context=context,
            injuries=injuries,
            milestones=milestones,
            feedback=feedback,
        )
        prev_review = pw.review
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
        context: shared per-phase context for ``generate_phase_validated`` — must
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
    master_weeks = list(master_plan.weeks or master_plan.weekly_key_sessions or [])
    actual_capper = _ActualExecutionCapper.from_context(context, master_plan=master_plan)
    phase_week_metas: dict[str, list[WeekMeta]] = {}

    # --- Pass 1: inline per-phase generation with review-driven regen. -------
    n_phases = len(master_plan.phases)
    logger.info(
        "season: starting — %d phases, %d milestones, max_phase_attempts=%d",
        n_phases,
        len(milestones),
        max_phase_attempts,
    )
    phase_results: list[PhaseWeeks] = []
    prev_exit_km: float | None = None
    for i, phase in enumerate(master_plan.phases):
        owned = _phase_milestones(phase, milestones)
        week_metas = _resolve_phase_week_metas(
            phase,
            prev_phase_end_km=prev_exit_km,
            milestones=owned,
            master_weeks=master_weeks,
        )
        if actual_capper is not None:
            week_metas = actual_capper.apply(week_metas)
        phase_week_metas[phase.id] = week_metas
        logger.info(
            "season: ▶ phase %d/%d %s — generating (prev_working=%s)",
            i + 1,
            n_phases,
            phase.phase_type.value if phase.phase_type else "base",
            f"{prev_exit_km:.0f}km" if prev_exit_km is not None else "—",
        )
        pw = _best_phase_attempt(
            phase,
            week_metas=week_metas,
            prev_phase_end_km=prev_exit_km,
            context=context,
            injuries=injuries,
            milestones=owned,
            max_phase_attempts=max_phase_attempts,
        )
        phase_results.append(pw)
        logger.info(
            "season: ✓ phase %d/%d %s — %d weeks, %d blocked, review=%s",
            i + 1,
            n_phases,
            phase.phase_type.value if phase.phase_type else "base",
            len(pw.weeks),
            pw.blocked_week_count,
            pw.review.verdict if pw.review else "—",
        )
        # Thread the working volume forward (I1): the next phase derives from
        # what this phase actually trained at (its max week), not its last
        # (possibly deload-trough) week. If this phase produced zero weeks (all
        # blocked), CARRY the prior volume rather than resetting — the next phase
        # should still continue from the last real working volume.
        exit_km = _phase_exit_km(pw.weeks)
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
        logger.info(
            "season: ◆ validating cross-phase rules (round %d/%d)",
            _round + 1,
            season_rounds,
        )
        bundle = _assemble(master_plan, phase_results, generated_by)
        report = run_season_rule_filter(bundle, master_plan)
        final_report = report
        logger.info(
            "season: season rules %s — %d error(s), %d warning(s)",
            "OK" if report.ok else "FAILED",
            len(report.errors()),
            len(report.warnings()),
        )
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
            week_metas = phase_week_metas.get(phase.id)
            if week_metas is None:
                week_metas = _resolve_phase_week_metas(
                    phase,
                    prev_phase_end_km=upstream_exit,
                    milestones=owned,
                    master_weeks=master_weeks,
                )
            regen = _best_phase_attempt(
                phase,
                week_metas=week_metas,
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
    total_weeks = sum(len(p.weeks) for p in bundle.phases)
    total_blocked = sum(p.blocked_week_count for p in bundle.phases)
    n_pass = sum(1 for p in bundle.phases if p.review and p.review.verdict == "pass")
    logger.info(
        "season: ✅ complete — %d weeks across %d phases (%d blocked), "
        "%d/%d phases review=pass, season rules %s",
        total_weeks,
        len(bundle.phases),
        total_blocked,
        n_pass,
        len(bundle.phases),
        "OK" if (final_report is None or final_report.ok) else "FAILED",
    )
    return bundle


def _upstream_exit_km(
    phase_results: list[PhaseWeeks], idx: int
) -> float | None:
    """Working volume threaded INTO the phase at ``idx`` (I1) — the nearest prior
    phase that has present weeks (carry-forward past all-blocked phases). Uses
    the prior phase's representative working volume (max week), matching the
    pass-1 forward thread and ``check_phase_transition``'s baseline. ``None`` for
    the first phase / when no upstream phase has weeks."""
    for j in range(idx - 1, -1, -1):
        km = _phase_exit_km(phase_results[j].weeks)
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
