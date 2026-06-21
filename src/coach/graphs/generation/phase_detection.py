"""Deterministic current-phase classifier (S1 pre-generation, core/pure).

Given recent-training features (mostly a passthrough of ``ContinuitySignals``
plus a small quality summary the adapter computes from the DB), decide which
periodization phase the athlete is **currently** in and from which phase a NEW
plan should **begin** — so the planner designs forward from the current
position instead of always restarting at ``base``.

Pure: no DB / LLM / I/O. The adapter
(:mod:`stride_server.coach_adapters.phase_detector`) maps DB + continuity into
:class:`RecentTrainingFeatures`, calls :func:`classify_current_phase`, and
cross-validates the result against an LLM. Constants are tunable module-top
knobs — expect to adjust them after the first real-data test.

See docs/superpowers/plans/2026-06-16-coach-current-phase-detector.md.
"""
from __future__ import annotations

from dataclasses import dataclass

from stride_core.master_plan import PhaseType

# --- tunable coaching constants -------------------------------------------
# Below BASE_MIN_WEEKS aerobic weeks (or returning from a layoff) the athlete
# still needs a base block. At/above BASE_COMPLETE_WEEKS the aerobic base is
# considered satisfied — the plan should advance past base.
BASE_MIN_WEEKS = 4
BASE_COMPLETE_WEEKS = 6
# A long run ≥ this fraction of the race distance, paired with marathon-specific
# quality (threshold/MP) AND closeness to the race, marks marathon-specific
# (build) territory rather than a generic aerobic long run during base.
SPECIFIC_LONGRUN_FRACTION = 0.62
SPECIFIC_RACE_WINDOW_WEEKS = 10

_RACE_KM = {"5K": 5.0, "10K": 10.0, "HM": 21.1, "FM": 42.2}


@dataclass(frozen=True)
class RecentTrainingFeatures:
    """Deterministic inputs to the classifier (adapter assembles these)."""

    aerobic_weeks: int                  # continuity.recent_aerobic_weeks
    longest_run_km: float | None        # continuity.recent_longest_run_km
    return_from_layoff: bool            # continuity.return_from_layoff
    macro_cycle: str                    # 'summer' | 'winter' | 'unknown'
    recent_quality_count: int           # threshold/interval/vo2/race runs, recent window
    recent_threshold_or_mp: bool        # the recent quality is marathon-specific (threshold/tempo/MP)
    weeks_to_race: int | None           # whole weeks from as_of to race date
    race_distance: str | None = None    # '5K'|'10K'|'HM'|'FM' (for the specific-longrun gate)


@dataclass(frozen=True)
class ClassifiedPhase:
    """Deterministic classifier output."""

    current_phase_type: PhaseType
    recommended_entry_phase: PhaseType
    weeks_in_phase: int | None
    confidence: str  # 'high' | 'medium' | 'low'
    rationale: str


def _entry_after_base(macro_cycle: str) -> PhaseType:
    """After a completed base block the next phase is a dedicated speed block in
    a long summer cycle, or straight into build in a compressed winter cycle
    (where speed folds into build)."""
    return PhaseType.SPEED if macro_cycle == "summer" else PhaseType.BUILD


def classify_current_phase(f: RecentTrainingFeatures) -> ClassifiedPhase:
    """Classify the athlete's current phase + recommended entry phase.

    The model is a forward periodization (base → speed → build → peak → taper);
    the athlete may already be mid-cycle. We never look *backward* past the
    current position — completed phases are simply not re-prescribed.
    """
    aerobic = f.aerobic_weeks

    # 1) Clearly still in base: layoff return, or too few aerobic weeks.
    if f.return_from_layoff or aerobic < BASE_MIN_WEEKS:
        why = "断训回归" if f.return_from_layoff else f"近期有氧仅 {aerobic} 周 (<{BASE_MIN_WEEKS})"
        return ClassifiedPhase(
            current_phase_type=PhaseType.BASE,
            recommended_entry_phase=PhaseType.BASE,
            weeks_in_phase=aerobic,
            confidence="high",
            rationale=f"{why} → 需要(重建)基础期",
        )

    # 2) Mid-base: aerobic base accumulating but not yet satisfied.
    if aerobic < BASE_COMPLETE_WEEKS:
        return ClassifiedPhase(
            current_phase_type=PhaseType.BASE,
            recommended_entry_phase=PhaseType.BASE,
            weeks_in_phase=aerobic,
            confidence="medium",
            rationale=f"有氧 {aerobic} 周 ({BASE_MIN_WEEKS}-{BASE_COMPLETE_WEEKS}) → 基础期进行中",
        )

    # 3) Base satisfied (aerobic >= BASE_COMPLETE_WEEKS): advance past base.
    race_km = _RACE_KM.get((f.race_distance or "").upper())
    near_race = f.weeks_to_race is not None and f.weeks_to_race <= SPECIFIC_RACE_WINDOW_WEEKS
    specific = bool(
        race_km
        and f.longest_run_km is not None
        and f.longest_run_km >= SPECIFIC_LONGRUN_FRACTION * race_km
        and f.recent_threshold_or_mp
        and near_race
    )
    entry = _entry_after_base(f.macro_cycle)

    if specific:
        return ClassifiedPhase(
            current_phase_type=PhaseType.BUILD,
            recommended_entry_phase=PhaseType.BUILD,
            weeks_in_phase=None,
            confidence="high",
            rationale=(
                f"基础已满 ({aerobic} 周)；最长跑 {f.longest_run_km}km 接近专项 + 含阈值/MP + "
                f"距赛 {f.weeks_to_race} 周 → 已进入马拉松专项(进展期)"
            ),
        )

    if f.recent_quality_count > 0:
        return ClassifiedPhase(
            current_phase_type=entry,
            recommended_entry_phase=entry,
            weeks_in_phase=None,
            confidence="high",
            rationale=(
                f"基础已满 ({aerobic} 周) + 近期已有 {f.recent_quality_count} 次质量课 + "
                f"macro={f.macro_cycle} → 进入 {entry.value}"
            ),
        )

    # Base done but no quality yet → just completed base, entering first block.
    return ClassifiedPhase(
        current_phase_type=PhaseType.BASE,
        recommended_entry_phase=entry,
        weeks_in_phase=aerobic,
        confidence="medium",
        rationale=(
            f"基础已满 ({aerobic} 周)、尚无质量课 → 基础期视为完成，建议进入 {entry.value}"
        ),
    )
