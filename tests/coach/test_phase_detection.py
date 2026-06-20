"""Tests for the deterministic current-phase classifier (S1 pre-generation)."""
from __future__ import annotations

from coach.graphs.generation.phase_detection import (
    BASE_COMPLETE_WEEKS,
    RecentTrainingFeatures,
    classify_current_phase,
)
from coach.schemas import CurrentPhaseContext
from stride_core.master_plan import PhaseType


def _feat(**kw) -> RecentTrainingFeatures:
    base = dict(
        aerobic_weeks=8,
        longest_run_km=20.0,
        return_from_layoff=False,
        macro_cycle="summer",
        recent_quality_count=0,
        recent_threshold_or_mp=False,
        weeks_to_race=18,
        race_distance="FM",
    )
    base.update(kw)
    return RecentTrainingFeatures(**base)


def test_layoff_returns_base():
    r = classify_current_phase(_feat(return_from_layoff=True, aerobic_weeks=10))
    assert r.current_phase_type == PhaseType.BASE
    assert r.recommended_entry_phase == PhaseType.BASE
    assert r.confidence == "high"


def test_few_aerobic_weeks_returns_base():
    r = classify_current_phase(_feat(aerobic_weeks=2))
    assert r.current_phase_type == PhaseType.BASE
    assert r.recommended_entry_phase == PhaseType.BASE
    assert r.weeks_in_phase == 2


def test_mid_base_returns_base_medium():
    r = classify_current_phase(_feat(aerobic_weeks=5))
    assert r.current_phase_type == PhaseType.BASE
    assert r.confidence == "medium"


def test_base_done_with_quality_summer_enters_speed():
    # The headline case: 8 weeks aerobic + recent threshold work + summer macro
    # → base is complete, enter the speed phase (NOT another base).
    r = classify_current_phase(
        _feat(aerobic_weeks=8, recent_quality_count=3, recent_threshold_or_mp=True, weeks_to_race=18)
    )
    assert r.current_phase_type == PhaseType.SPEED
    assert r.recommended_entry_phase == PhaseType.SPEED
    assert r.confidence == "high"


def test_base_done_with_quality_winter_enters_build():
    r = classify_current_phase(
        _feat(macro_cycle="winter", aerobic_weeks=8, recent_quality_count=2, recent_threshold_or_mp=True)
    )
    assert r.recommended_entry_phase == PhaseType.BUILD


def test_marathon_specific_near_race_enters_build():
    # Long run near race-specific distance + threshold/MP + close to race → build.
    r = classify_current_phase(
        _feat(
            aerobic_weeks=10,
            longest_run_km=30.0,
            recent_quality_count=4,
            recent_threshold_or_mp=True,
            weeks_to_race=8,
        )
    )
    assert r.current_phase_type == PhaseType.BUILD
    assert r.recommended_entry_phase == PhaseType.BUILD


def test_base_done_no_quality_recommends_entry_but_phase_base():
    # Aerobic base satisfied but no quality yet: functionally just finished base,
    # entry advances to the next phase.
    r = classify_current_phase(
        _feat(aerobic_weeks=BASE_COMPLETE_WEEKS, recent_quality_count=0, macro_cycle="summer")
    )
    assert r.current_phase_type == PhaseType.BASE
    assert r.recommended_entry_phase == PhaseType.SPEED
    assert r.weeks_in_phase == BASE_COMPLETE_WEEKS


def test_classified_phase_maps_into_context_schema():
    r = classify_current_phase(
        _feat(aerobic_weeks=8, recent_quality_count=3, recent_threshold_or_mp=True)
    )
    ctx = CurrentPhaseContext(
        source="inferred",
        current_phase_type=r.current_phase_type,
        recommended_entry_phase=r.recommended_entry_phase,
        weeks_in_phase=r.weeks_in_phase,
        completed_aerobic_weeks=8,
        confidence=r.confidence,
        rationale=r.rationale,
    )
    assert ctx.recommended_entry_phase == PhaseType.SPEED
    # round-trips through pydantic JSON
    assert CurrentPhaseContext.model_validate(ctx.model_dump()).recommended_entry_phase == PhaseType.SPEED
