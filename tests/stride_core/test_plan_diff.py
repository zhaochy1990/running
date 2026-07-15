"""Pure WeeklyPlan PlanDiff transformation tests."""

from __future__ import annotations

import uuid

import pytest

from stride_core.plan_diff import (
    DiffOp, DiffOpKind, PlanDiff, apply_diff_to_weekly_plan,
)
from stride_core.plan_spec import PlannedNutrition, PlannedSession, SessionKind, WeeklyPlan

FOLDER = "2026-05-04_05-10(W2)"


def _op(kind: DiffOpKind, date: str = "2026-05-05", index: int = 0,
        patch: dict | None = None) -> DiffOp:
    return DiffOp(
        id=str(uuid.uuid4()), op=kind, date=date, session_index=index,
        old_value=None, new_value=None, spec_patch=patch, accepted=None,
    )


def _diff(*ops: DiffOp, folder: str = FOLDER) -> PlanDiff:
    return PlanDiff(
        diff_id=str(uuid.uuid4()), folder=folder, ops=list(ops),
        ai_explanation="test", created_at="2026-05-01T00:00:00Z",
    )


def _plan() -> WeeklyPlan:
    return WeeklyPlan(
        week_folder=FOLDER,
        sessions=(
            PlannedSession(
                date="2026-05-05", session_index=0, kind=SessionKind.RUN,
                summary="Easy 10km", notes_md="keep", total_distance_m=10000,
            ),
            PlannedSession(
                date="2026-05-06", session_index=0, kind=SessionKind.STRENGTH,
                summary="Strength",
            ),
        ),
        nutrition=(PlannedNutrition(date="2026-05-05", kcal_target=2400),),
        notes_md="top-level notes must survive",
    )


def _apply(plan: WeeklyPlan, *ops: DiffOp, accepted: list[str] | None = None):
    accepted = accepted if accepted is not None else [op.id for op in ops]
    return apply_diff_to_weekly_plan(plan, _diff(*ops), accepted)


def test_remove_session_preserves_plan_metadata_and_nutrition():
    op = _op(DiffOpKind.REMOVE_SESSION, patch=None)
    result = _apply(_plan(), op)
    assert [(s.date, s.kind) for s in result.sessions] == [
        ("2026-05-06", SessionKind.STRENGTH)
    ]
    assert result.nutrition == _plan().nutrition
    assert result.notes_md == "top-level notes must survive"


def test_add_session():
    op = _op(
        DiffOpKind.ADD_SESSION, date="2026-05-08",
        patch={"kind": "run", "summary": "Tempo", "total_distance_m": 8000},
    )
    result = _apply(_plan(), op)
    added = next(s for s in result.sessions if s.date == "2026-05-08")
    assert added.summary == "Tempo"
    assert added.total_distance_m == 8000


def test_move_session():
    op = _op(
        DiffOpKind.MOVE_SESSION,
        patch={"new_date": "2026-05-07", "new_session_index": 1},
    )
    result = _apply(_plan(), op)
    moved = next(s for s in result.sessions if s.summary == "Easy 10km")
    assert (moved.date, moved.session_index) == ("2026-05-07", 1)


@pytest.mark.parametrize(
    ("kind", "patch", "attr", "expected"),
    [
        (DiffOpKind.REPLACE_DISTANCE, {"total_distance_m": 7000},
         "total_distance_m", 7000),
        (DiffOpKind.REPLACE_NOTE, {"notes_md": "new"}, "notes_md", "new"),
        (DiffOpKind.REPLACE_KIND, {"kind": "rest", "summary": "Rest"},
         "kind", SessionKind.REST),
    ],
)
def test_replace_ops(kind, patch, attr, expected):
    result = _apply(_plan(), _op(kind, patch=patch))
    changed = next(s for s in result.sessions if s.date == "2026-05-05")
    assert getattr(changed, attr) == expected


def test_unaccepted_and_missing_patch_are_noops():
    op = _op(DiffOpKind.REPLACE_NOTE, patch={"notes_md": "new"})
    assert _apply(_plan(), op, accepted=[]) == _plan()
    missing = _op(DiffOpKind.REPLACE_NOTE, patch=None)
    assert _apply(_plan(), missing) == _plan()


def test_source_must_exist():
    op = _op(DiffOpKind.REMOVE_SESSION, date="2026-05-07")
    with pytest.raises(ValueError, match="does not exist"):
        _apply(_plan(), op)


@pytest.mark.parametrize("kind", [DiffOpKind.ADD_SESSION, DiffOpKind.MOVE_SESSION])
def test_target_must_stay_in_week(kind):
    patch = {"kind": "run", "summary": "x"}
    date = "2026-05-20"
    if kind == DiffOpKind.MOVE_SESSION:
        date = "2026-05-05"
        patch = {"new_date": "2026-05-20"}
    op = _op(kind, date=date, patch=patch)
    with pytest.raises(ValueError, match="outside plan bounds"):
        _apply(_plan(), op)


def test_duplicate_target_is_rejected():
    op = _op(
        DiffOpKind.MOVE_SESSION,
        patch={"new_date": "2026-05-06", "new_session_index": 0},
    )
    with pytest.raises(ValueError, match="duplicate"):
        _apply(_plan(), op)


def test_diff_folder_must_match_plan():
    with pytest.raises(ValueError, match="folder"):
        apply_diff_to_weekly_plan(
            _plan(), _diff(folder="2026-05-11_05-17"), []
        )


def test_swap_is_order_independent():
    left = _op(
        DiffOpKind.MOVE_SESSION, date="2026-05-05",
        patch={"new_date": "2026-05-06", "new_session_index": 0},
    )
    right = _op(
        DiffOpKind.MOVE_SESSION, date="2026-05-06",
        patch={"new_date": "2026-05-05", "new_session_index": 0},
    )
    result = _apply(_plan(), left, right)
    assert [(s.date, s.summary) for s in result.sessions] == [
        ("2026-05-05", "Strength"), ("2026-05-06", "Easy 10km")
    ]
