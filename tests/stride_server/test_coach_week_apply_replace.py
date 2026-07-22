"""Unit tests for the weekly apply route's create-vs-replace proposal branch.

Exercises ``apply_coach_week_diff`` directly (bypassing the TestClient auth
machinery) with the store functions monkeypatched, focusing on the new
``replace`` flag that lands a full-plan proposal onto an EXISTING week via
``save_weekly_plan`` instead of ``create_weekly_plan`` (which 409s).
"""

from __future__ import annotations

from datetime import date

import pytest

import stride_server.routes.coach as coach_routes
from stride_server.routes.coach import CoachWeekApplyRequest, apply_coach_week_diff
from stride_core.plan_diff import PlanDiff
from stride_core.plan_spec import PlannedSession, SessionKind, WeeklyPlan
from stride_core.weekly_plan_proposal import WeeklyPlanCreateProposal

_FOLDER = "2026-05-11_05-17"
_USER = "a1b2c3d4-e5f6-4aaa-89ab-000000000001"


def _proposal() -> WeeklyPlanCreateProposal:
    plan = WeeklyPlan(
        week_folder=_FOLDER,
        sessions=(
            PlannedSession(
                date="2026-05-11",
                session_index=0,
                kind=SessionKind.REST,
                summary="休息",
            ),
            PlannedSession(
                date="2026-05-12",
                session_index=0,
                kind=SessionKind.RUN,
                summary="E 轻松跑（10K）",
                total_distance_m=10000,
            ),
        ),
    )
    return WeeklyPlanCreateProposal(
        proposal_id="p1",
        folder=_FOLDER,
        plan=plan.to_dict(),
        total_distance_km=10.0,
        ai_explanation="regenerated week",
        created_at="2026-05-10T00:00:00Z",
    )


@pytest.fixture(autouse=True)
def _supported(monkeypatch):
    monkeypatch.setattr(coach_routes, "today_shanghai", lambda: date(2026, 5, 12))
    monkeypatch.setattr(
        coach_routes, "is_supported_weekly_plan_generation", lambda *a, **k: True
    )


def test_replace_true_saves_full_plan_over_existing_week(monkeypatch):
    calls: dict = {}

    def _save(user_id, plan, *, expected_folder, generated_by):
        calls["save"] = (user_id, expected_folder, generated_by, plan)

    def _create(*_a, **_k):  # must NOT be called on the replace path
        raise AssertionError("create_weekly_plan must not run when replace=true")

    monkeypatch.setattr(coach_routes, "save_weekly_plan", _save)
    monkeypatch.setattr(coach_routes, "create_weekly_plan", _create)

    body = CoachWeekApplyRequest(proposal=_proposal(), replace=True)
    result = apply_coach_week_diff(_FOLDER, body, payload={"sub": _USER})

    assert result["replaced"] is True
    assert result["created"] is False
    assert result["folder"] == _FOLDER
    assert calls["save"][0] == _USER
    assert calls["save"][1] == _FOLDER
    assert calls["save"][2] == "coach-generation-replace"


def test_replace_false_create_conflict_returns_409(monkeypatch):
    monkeypatch.setattr(coach_routes, "create_weekly_plan", lambda *a, **k: False)
    monkeypatch.setattr(
        coach_routes,
        "save_weekly_plan",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not save")),
    )

    body = CoachWeekApplyRequest(proposal=_proposal(), replace=False)
    with pytest.raises(coach_routes.HTTPException) as exc:
        apply_coach_week_diff(_FOLDER, body, payload={"sub": _USER})
    assert exc.value.status_code == 409


def test_replace_true_requires_a_proposal_not_a_diff():
    diff = PlanDiff(
        diff_id="d1",
        folder=_FOLDER,
        ops=[],
        ai_explanation="x",
        created_at="2026-05-10T00:00:00Z",
    )
    with pytest.raises(ValueError, match="replace=true is only valid"):
        CoachWeekApplyRequest(diff=diff, replace=True)
