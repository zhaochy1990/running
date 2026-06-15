"""Tests for the per-phase weekly-generation loop (Stage-3a Task 6).

``generate_phase_weeks(phase, weeks, context, injuries)`` walks a phase's
weeks sequentially, generating one ``WeeklyPlan`` per week through the per-week
generation graph (Task 5) driven by the per-week generator adapter (Task 4),
threading week-to-week continuity (``prev_week_km`` + ``prior_week_tail``).

All LLM calls are faked (no network). A calibration snapshot is seeded so the
real ``pace_targets`` / ``volume_targets`` calculators (and thus the
athlete-relative ``z45_pace_threshold_s_km`` the rule_filter consumes) run
end-to-end.
"""

from __future__ import annotations

import json
from datetime import date

import pytest

from stride_core.db import Database
from stride_core.master_plan import Phase, PhaseType
from stride_core.plan_spec import WeeklyPlan
from stride_core.running_calibration.sqlite_connector import (
    SQLiteRunningCalibrationRepository,
)
from stride_core.running_calibration.types import (
    CalibrationConfidence,
    RunningCalibrationSnapshot,
)
import stride_server.coach_adapters.week_specialist_adapter as adapter_mod
from stride_server.coach_adapters.week_specialist_adapter import generate_phase_weeks

# threshold speed 4.0 m/s → threshold pace 250 s/km (4:10/km)
_THRESHOLD_SPEED_MPS = 4.0
_AS_OF = date(2026, 6, 1)

USER_ID = "a1b2c3d4-e5f6-4aaa-89ab-000000000099"


# ---------------------------------------------------------------------------
# Seeding helpers
# ---------------------------------------------------------------------------


def _seed_calibration(db: Database) -> None:
    repo = SQLiteRunningCalibrationRepository(db)
    repo.save_snapshot(
        RunningCalibrationSnapshot(
            as_of_date=date(2026, 5, 20),
            threshold_speed_mps=_THRESHOLD_SPEED_MPS,
            threshold_hr=168.0,
            threshold_speed_confidence=CalibrationConfidence.HIGH,
            threshold_hr_confidence=CalibrationConfidence.HIGH,
            hrmax_confidence=CalibrationConfidence.NONE,
        )
    )


def _fm_goal() -> dict:
    return {"distance": "fm", "goal_time_s": 3 * 3600 + 30 * 60, "race_date": "2026-11-01"}


def _phase() -> Phase:
    return Phase(
        id="p-build-1",
        name="专项期",
        start_date="2026-06-08",
        end_date="2026-07-19",
        focus="专项耐力 + 阈值",
        weekly_distance_km_low=60.0,
        weekly_distance_km_high=85.0,
        key_session_types=["长距离", "阈值", "有氧"],
        milestone_ids=[],
        phase_type=PhaseType.BUILD,
    )


def _week_descriptors(n: int, *, base_km: float = 70.0) -> list[dict]:
    """N ordered per-week meta descriptors inside the phase band."""
    out: list[dict] = []
    for i in range(n):
        out.append(
            {
                "week_index": i,
                "week_folder": f"2026-06-{8 + i * 7:02d}_06-{14 + i * 7:02d}(W{i + 1})",
                "phase_position": f"build week {i + 1}/{n}",
                "target_weekly_km": base_km,
            }
        )
    return out


def _context() -> dict:
    return {
        "user_id": USER_ID,
        "goal": _fm_goal(),
        "level": 65.0,
        "continuity": {"macro_cycle": "build", "current_chronic_load": 62.0},
    }


def _valid_plan_dict(week_folder: str, *, total_km: float = 56.0) -> dict:
    """A valid aspirational WeeklyPlan (all spec=null) summing to ~total_km.

    Three runs + one full rest day so check_rest_days / check_long_run_share
    pass. Longest run kept under 35% of weekly volume.
    """
    # split total across 3 runs; keep longest < 35%
    longest = total_km * 0.33
    other = (total_km - longest) / 2.0
    return {
        "schema": "weekly-plan/v1",
        "week_folder": week_folder,
        "sessions": [
            {
                "schema": "plan-session/v1",
                "date": "2026-06-15",
                "session_index": 0,
                "kind": "run",
                "summary": f"z2 easy {other:.0f}km @ 5:30/km",
                "spec": None,
                "notes_md": "轻松有氧",
                "total_distance_m": other * 1000,
                "total_duration_s": None,
                "scheduled_workout_id": None,
            },
            {
                "schema": "plan-session/v1",
                "date": "2026-06-18",
                "session_index": 0,
                "kind": "run",
                "summary": f"有氧 {other:.0f}km @ 5:20/km",
                "spec": None,
                "notes_md": "有氧",
                "total_distance_m": other * 1000,
                "total_duration_s": None,
                "scheduled_workout_id": None,
            },
            {
                "schema": "plan-session/v1",
                "date": "2026-06-21",
                "session_index": 0,
                "kind": "run",
                "summary": f"专项长跑 {longest:.0f}km（后段 MP）",
                "spec": None,
                "notes_md": "MP 段 4:58/km",
                "total_distance_m": longest * 1000,
                "total_duration_s": None,
                "scheduled_workout_id": None,
            },
        ],
        "nutrition": [],
        "notes_md": f"{week_folder}: 1 长跑 + 2 有氧 + 休息日",
    }


def _no_rest_day_plan(week_folder: str) -> dict:
    """A plan that schedules a run on all 7 days → check_rest_days fails.

    Persistently rule-violating: the rule_filter blocks it every iteration, so
    the graph runs out of iterations and returns final_verdict='block'.
    """
    sessions = []
    for i in range(7):
        sessions.append(
            {
                "schema": "plan-session/v1",
                "date": f"2026-06-{15 + i:02d}",
                "session_index": 0,
                "kind": "run",
                "summary": f"easy 8km day {i}",
                "spec": None,
                "notes_md": "",
                "total_distance_m": 8000,
                "total_duration_s": None,
                "scheduled_workout_id": None,
            }
        )
    return {
        "schema": "weekly-plan/v1",
        "week_folder": week_folder,
        "sessions": sessions,
        "nutrition": [],
        "notes_md": "no rest day — should be blocked",
    }


# ---------------------------------------------------------------------------
# Fake LLM — returns a per-call canned reply, captures (system, messages)
# ---------------------------------------------------------------------------


from tests.stride_server._fake_bindable_llm import FakeBindableLLM, ai_text


class _FakeLLMHandle:
    """Adapt the old ``replies: list[str]`` fake-LLM surface to the bindable
    model path. Each reply → an ``AIMessage`` (no tool_calls) the tool loop
    returns verbatim. The single model instance persists across the loop's weeks
    so the reply index advances week-to-week (last reply reused if exhausted)."""

    def __init__(self) -> None:
        self.replies: list[str] = []
        self._model: FakeBindableLLM | None = None

    def _build_model(self) -> FakeBindableLLM:
        if self._model is None:
            self._model = FakeBindableLLM([ai_text(r) for r in self.replies])
        return self._model

    @property
    def captured(self) -> list:
        return self._model.captured if self._model is not None else []


@pytest.fixture
def fake_llm(monkeypatch):
    handle = _FakeLLMHandle()
    monkeypatch.setattr(adapter_mod, "get_generator_llm", handle._build_model)
    monkeypatch.setattr(adapter_mod, "today_shanghai", lambda: _AS_OF)
    return handle


@pytest.fixture
def rfk_spy(monkeypatch):
    """Capture the rule_filter_kwargs passed for each week's graph build."""
    calls: list[dict] = []
    real_build = adapter_mod.build_week_specialist_graph

    def _spy(*args, **kwargs):
        calls.append(dict(kwargs.get("rule_filter_kwargs") or {}))
        return real_build(*args, **kwargs)

    monkeypatch.setattr(adapter_mod, "build_week_specialist_graph", _spy)
    return calls


# ---------------------------------------------------------------------------
# N weeks → N plans
# ---------------------------------------------------------------------------


def test_n_weeks_yield_n_plans(db, monkeypatch, fake_llm):
    _seed_calibration(db)
    monkeypatch.setattr(adapter_mod, "Database", lambda **kw: db)

    weeks = _week_descriptors(3)
    fake_llm.replies = [
        json.dumps(_valid_plan_dict(w["week_folder"]), ensure_ascii=False) for w in weeks
    ]

    plans = generate_phase_weeks(_phase(), weeks, _context(), injuries=[])
    assert len(plans) == 3
    for w, p in zip(weeks, plans):
        plan = WeeklyPlan.from_dict(p)  # round-trips
        assert plan.week_folder == w["week_folder"]


# ---------------------------------------------------------------------------
# prev_week_km threading
# ---------------------------------------------------------------------------


def test_prev_week_km_threaded_into_week_two(db, monkeypatch, fake_llm, rfk_spy):
    _seed_calibration(db)
    monkeypatch.setattr(adapter_mod, "Database", lambda **kw: db)

    weeks = _week_descriptors(2)
    # week 1 sums to ~56km; week 2's rule_filter must receive that as prev_week_km
    fake_llm.replies = [
        json.dumps(_valid_plan_dict(w["week_folder"], total_km=56.0), ensure_ascii=False)
        for w in weeks
    ]

    plans = generate_phase_weeks(_phase(), weeks, _context(), injuries=[])
    assert len(plans) == 2

    # week 1: no prior week → prev_week_km None
    assert rfk_spy[0].get("prev_week_km") is None
    # week 2: threaded from week 1's run total (~56km)
    assert rfk_spy[1].get("prev_week_km") is not None
    assert rfk_spy[1]["prev_week_km"] == pytest.approx(56.0, abs=1.0)
    # athlete-relative threshold flows in for every week (250 s/km from seed)
    assert rfk_spy[0]["z45_pace_threshold_s_km"] == pytest.approx(250.0, abs=0.5)


# ---------------------------------------------------------------------------
# prior_week_tail threading
# ---------------------------------------------------------------------------


def test_prior_week_tail_threaded_into_week_two(db, monkeypatch, fake_llm):
    _seed_calibration(db)
    monkeypatch.setattr(adapter_mod, "Database", lambda **kw: db)

    # Capture the invocation state per graph run via the generator's context.
    seen_tails: list[str] = []
    real_generate = adapter_mod.generate_specialist_week

    def _spy_generate(state):
        ctx = state.get("context") or {}
        seen_tails.append(ctx.get("prior_week_tail") or "")
        return real_generate(state)

    monkeypatch.setattr(adapter_mod, "generate_specialist_week", _spy_generate)

    weeks = _week_descriptors(2)
    fake_llm.replies = [
        json.dumps(_valid_plan_dict(w["week_folder"]), ensure_ascii=False) for w in weeks
    ]

    plans = generate_phase_weeks(_phase(), weeks, _context(), injuries=[])
    assert len(plans) == 2
    # week 1 has no prior tail; week 2 carries a non-empty tail derived from w1
    assert seen_tails[0] == ""
    assert seen_tails[1] != ""
    assert "专项长跑" in seen_tails[1] or "有氧" in seen_tails[1]


# ---------------------------------------------------------------------------
# blocked week → 0 results for that week
# ---------------------------------------------------------------------------


def test_blocked_week_excluded_from_results(db, monkeypatch, fake_llm):
    _seed_calibration(db)
    monkeypatch.setattr(adapter_mod, "Database", lambda **kw: db)

    weeks = _week_descriptors(2)
    # week 1 clean; week 2 persistently violates (no rest day) → blocked.
    # The graph retries up to max_iterations, so feed the bad reply enough
    # times; _FakeLLM reuses the last reply, so a single bad final reply works.
    fake_llm.replies = [
        json.dumps(_valid_plan_dict(weeks[0]["week_folder"]), ensure_ascii=False),
        json.dumps(_no_rest_day_plan(weeks[1]["week_folder"]), ensure_ascii=False),
    ]

    plans = generate_phase_weeks(_phase(), weeks, _context(), injuries=[])
    # only the clean week 1 survives
    assert len(plans) == 1
    assert WeeklyPlan.from_dict(plans[0]).week_folder == weeks[0]["week_folder"]
