"""Round-trip + re-export tests for SeasonPlanBundle / PhaseWeeks (Stage-3b T1)."""

from __future__ import annotations

import pytest

from coach.schemas import (
    PhaseReview,
    PhaseWeeks,
    ReviewIssue,
    SeasonPlanBundle,
)
from coach.schemas.season_bundle import PhaseReview as PhaseReviewDirect
from stride_core.master_plan import PhaseType


# ---------------------------------------------------------------------------
# Minimal plan-dict builder (mirrors tests/coach/test_rule_filter.py)
# ---------------------------------------------------------------------------


def _minimal_run_session(date: str, distance_m: int = 8000, duration_s: int = 2700):
    return {
        "date": date,
        "session_index": 0,
        "kind": "run",
        "summary": "easy run",
        "spec": None,  # aspirational — no structured spec
        "notes_md": None,
        "total_distance_m": distance_m,
        "total_duration_s": duration_s,
    }


def _plan_dict(sessions, *, folder: str) -> dict:
    return {
        "schema": "weekly-plan/v1",
        "week_folder": folder,
        "sessions": sessions,
        "nutrition": [],
    }


def _base_phase() -> PhaseWeeks:
    return PhaseWeeks(
        phase_id="phase-base-1",
        phase_type=PhaseType.BASE,
        weeks=[
            _plan_dict(
                [_minimal_run_session("2026-05-11")],
                folder="2026-05-11_05-17(W1)",
            ),
            _plan_dict(
                [_minimal_run_session("2026-05-18")],
                folder="2026-05-18_05-24(W2)",
            ),
        ],
    )


def _build_phase() -> PhaseWeeks:
    return PhaseWeeks(
        phase_id="phase-build-1",
        phase_type=PhaseType.BUILD,
        weeks=[
            _plan_dict(
                [_minimal_run_session("2026-05-25")],
                folder="2026-05-25_05-31(W3)",
            ),
        ],
    )


def _bundle() -> SeasonPlanBundle:
    return SeasonPlanBundle(
        master_plan_id="mp-123",
        generated_by="anthropic:claude-opus-4-8",
        phases=[_base_phase(), _build_phase()],
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_reexport_from_coach_schemas():
    assert PhaseReview is PhaseReviewDirect


def test_round_trip_no_review():
    bundle = _bundle()
    dumped = bundle.model_dump(mode="json")
    restored = SeasonPlanBundle.model_validate(dumped)
    assert restored == bundle
    # weeks remain plain dicts, in order
    assert restored.phases[0].weeks[0]["week_folder"] == "2026-05-11_05-17(W1)"
    assert len(restored.phases[0].weeks) == 2


def test_round_trip_with_populated_review():
    review = PhaseReview(
        verdict="revise",
        commentary_md="提升期 acute 持续不足。",
        issues=[
            ReviewIssue(
                review_class="progression",
                severity="warning",
                message="weekly dose below chronic x 7.7",
                target_path="phases[1]",
                suggested_action="add a short jog on rest days",
            )
        ],
    )
    base = _base_phase()
    base.review = review
    bundle = SeasonPlanBundle(
        master_plan_id="mp-123",
        generated_by="anthropic:claude-opus-4-8",
        phases=[base],
    )
    dumped = bundle.model_dump(mode="json")
    restored = SeasonPlanBundle.model_validate(dumped)
    assert restored == bundle
    assert restored.phases[0].review is not None
    assert restored.phases[0].review.verdict == "revise"
    assert restored.phases[0].review.issues[0].review_class == "progression"


def test_blocked_week_count_default_and_set():
    phase = _base_phase()
    assert phase.blocked_week_count == 0
    phase.blocked_week_count = 2
    restored = PhaseWeeks.model_validate(phase.model_dump(mode="json"))
    assert restored.blocked_week_count == 2


def test_schema_version_stamp():
    bundle = _bundle()
    dumped = bundle.model_dump(mode="json", by_alias=True)
    assert dumped["schema"] == "season-plan-bundle/v1"
    # version-stamp survives round-trip (populate_by_name accepts the "schema" key)
    assert SeasonPlanBundle.model_validate(dumped).schema_version == bundle.schema_version


@pytest.mark.parametrize("phase_type", list(PhaseType))
def test_phase_type_accepts_all_values_and_serializes_to_string(phase_type):
    phase = PhaseWeeks(
        phase_id=f"phase-{phase_type.value}",
        phase_type=phase_type,
        weeks=[],
    )
    dumped = phase.model_dump(mode="json")
    assert dumped["phase_type"] == phase_type.value
    restored = PhaseWeeks.model_validate(dumped)
    assert restored.phase_type is phase_type
