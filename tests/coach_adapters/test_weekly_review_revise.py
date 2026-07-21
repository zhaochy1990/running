"""Pure Review write-path projection: draft proposal + PlanDiff -> new proposal."""

from __future__ import annotations

from uuid import uuid4

import pytest

from stride_core.plan_diff import DiffOp, DiffOpKind, PlanDiff
from stride_core.plan_spec import (
    PlannedNutrition,
    PlannedSession,
    SessionKind,
    WeeklyPlan,
)
from stride_core.weekly_plan_proposal import WeeklyPlanCreateProposal
from stride_server.coach_adapters.orchestrator.weekly_review_revise import (
    revise_weekly_create_proposal,
)

_FOLDER = "2026-07-13_07-19"


def _draft() -> WeeklyPlanCreateProposal:
    plan = WeeklyPlan(
        week_folder=_FOLDER,
        sessions=(
            PlannedSession(
                date="2026-07-15",
                session_index=0,
                kind=SessionKind.RUN,
                summary="周三间歇 8km",
                total_distance_m=8000,
            ),
            PlannedSession(
                date="2026-07-19",
                session_index=0,
                kind=SessionKind.RUN,
                summary="周日长跑 20km",
                total_distance_m=20000,
            ),
        ),
        nutrition=(
            PlannedNutrition(date="2026-07-15", kcal_target=2600),
        ),
        notes_md="本周维持负荷",
    )
    return WeeklyPlanCreateProposal(
        proposal_id="draft-1",
        folder=_FOLDER,
        plan=plan.to_dict(),
        total_distance_km=28.0,
        ai_explanation="初版草案",
        created_at="2026-07-14T00:00:00Z",
        base_revision="original-week-revision",
    )


def _move_wed_to_thu() -> PlanDiff:
    return PlanDiff(
        diff_id="d1",
        folder=_FOLDER,
        ops=[
            DiffOp(
                id=str(uuid4()),
                op=DiffOpKind.MOVE_SESSION,
                date="2026-07-15",
                session_index=0,
                old_value={"date": "2026-07-15"},
                new_value={"date": "2026-07-16"},
                spec_patch={"new_date": "2026-07-16"},
                accepted=None,
            )
        ],
        ai_explanation="把周三的间歇挪到周四",
        created_at="2026-07-14T08:00:00Z",
    )


def test_revise_applies_diff_to_draft_and_returns_new_proposal() -> None:
    result = revise_weekly_create_proposal(_draft(), _move_wed_to_thu())

    assert isinstance(result, WeeklyPlanCreateProposal)
    plan = result.to_weekly_plan()
    dates = sorted(s.date for s in plan.sessions)
    assert dates == ["2026-07-16", "2026-07-19"]  # Wed session moved to Thu
    assert result.ai_explanation == "把周三的间歇挪到周四"
    assert result.base_revision == "original-week-revision"


def test_revise_preserves_unchanged_nutrition_and_notes() -> None:
    result = revise_weekly_create_proposal(_draft(), _move_wed_to_thu())
    plan = result.to_weekly_plan()

    assert plan.notes_md == "本周维持负荷"
    assert len(plan.nutrition) == 1
    assert plan.nutrition[0].kcal_target == 2600


def test_revise_mints_fresh_identity() -> None:
    draft = _draft()
    result = revise_weekly_create_proposal(draft, _move_wed_to_thu())

    assert result.proposal_id != draft.proposal_id
    assert result.created_at != draft.created_at
    assert result.folder == draft.folder


def test_revise_recomputes_total_distance() -> None:
    """Removing the long run drops weekly volume to the remaining sessions."""
    long_run = _draft().to_weekly_plan().sessions[1]
    remove = PlanDiff(
        diff_id="d2",
        folder=_FOLDER,
        ops=[
            DiffOp(
                id="op-remove",
                op=DiffOpKind.REMOVE_SESSION,
                date=long_run.date,
                session_index=long_run.session_index,
                old_value=None,
                new_value=None,
                spec_patch=None,
                accepted=None,
            )
        ],
        ai_explanation="去掉周日长跑",
        created_at="2026-07-14T08:00:00Z",
    )

    result = revise_weekly_create_proposal(_draft(), remove)

    assert result.total_distance_km == pytest.approx(8.0)  # only the 8km interval


def test_revise_skips_rejected_ops() -> None:
    diff = _move_wed_to_thu()
    diff = diff.model_copy(
        update={"ops": [diff.ops[0].model_copy(update={"accepted": False})]}
    )

    result = revise_weekly_create_proposal(_draft(), diff)
    dates = sorted(s.date for s in result.to_weekly_plan().sessions)

    assert dates == ["2026-07-15", "2026-07-19"]  # nothing moved


def test_revise_rejects_folder_mismatch() -> None:
    diff = _move_wed_to_thu().model_copy(update={"folder": "2026-07-20_07-26"})
    with pytest.raises(ValueError, match="does not match draft folder"):
        revise_weekly_create_proposal(_draft(), diff)


def test_revise_rejects_remove_all_without_replacement() -> None:
    """A regenerate marker must never replace Review with an empty calendar."""
    plan = _draft().to_weekly_plan()
    diff = PlanDiff(
        diff_id="d-empty",
        folder=_FOLDER,
        ops=[
            DiffOp(
                id=f"remove-{index}",
                op=DiffOpKind.REMOVE_SESSION,
                date=session.date,
                session_index=session.session_index,
                old_value=None,
                new_value=None,
                spec_patch=None,
                accepted=None,
            )
            for index, session in enumerate(plan.sessions)
        ],
        ai_explanation="清空本周训练以重新生成",
        created_at="2026-07-14T08:00:00Z",
    )

    with pytest.raises(ValueError, match="remove every session"):
        revise_weekly_create_proposal(_draft(), diff)
