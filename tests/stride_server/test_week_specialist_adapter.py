"""Tests for coach_adapters.week_specialist_adapter (Stage-3a Task 4).

The per-week generator adapter ``generate_specialist_week(state)``:
  * computes ``pace_targets`` + ``volume_targets`` (必传上下文),
  * composes the weekly specialist system prompt,
  * calls the LLM (3-tier parse, one retry on parse failure),
  * validates with ``WeeklyPlan.from_dict``,
  * returns ``{"current_draft": <validated plan dict>}``.

All LLM calls are faked (no network). A calibration snapshot is seeded so the
real ``pace_targets`` / ``volume_targets`` calculators run end-to-end.
"""

from __future__ import annotations

import json
from datetime import date

import pytest

from stride_core.db import Database
from stride_core.plan_spec import WeeklyPlan
from stride_core.running_calibration.sqlite_connector import (
    SQLiteRunningCalibrationRepository,
)
from stride_core.running_calibration.types import (
    CalibrationConfidence,
    RunningCalibrationSnapshot,
)
import stride_server.coach_adapters.week_specialist_adapter as adapter_mod
from stride_server.coach_adapters.week_specialist_adapter import (
    build_specialist_context,
    generate_specialist_week,
)

# threshold speed 4.0 m/s → threshold pace 250 s/km (4:10/km)
_THRESHOLD_SPEED_MPS = 4.0
_AS_OF = date(2026, 6, 1)

USER_ID = "a1b2c3d4-e5f6-4aaa-89ab-000000000099"
WEEK_FOLDER = "2026-06-15_06-21(W3)"


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
    # 3:30:00 marathon
    return {"distance": "fm", "goal_time_s": 3 * 3600 + 30 * 60, "race_date": "2026-11-01"}


def _valid_plan_dict() -> dict:
    """A valid aspirational WeeklyPlan (all spec=null) for the week folder."""
    return {
        "schema": "weekly-plan/v1",
        "week_folder": WEEK_FOLDER,
        "sessions": [
            {
                "schema": "plan-session/v1",
                "date": "2026-06-15",
                "session_index": 0,
                "kind": "run",
                "summary": "z2 easy 12km @ 5:30/km",
                "spec": None,
                "notes_md": "轻松有氧",
                "total_distance_m": 12000,
                "total_duration_s": None,
                "scheduled_workout_id": None,
            },
            {
                "schema": "plan-session/v1",
                "date": "2026-06-18",
                "session_index": 0,
                "kind": "run",
                "summary": "阈值 2k * 4 @ 4:10/km",
                "spec": None,
                "notes_md": "组间 90s",
                "total_distance_m": 14000,
                "total_duration_s": None,
                "scheduled_workout_id": None,
            },
            {
                "schema": "plan-session/v1",
                "date": "2026-06-21",
                "session_index": 0,
                "kind": "run",
                "summary": "专项长跑 30km（后 12km @ MP）",
                "spec": None,
                "notes_md": "MP 段 4:58/km",
                "total_distance_m": 30000,
                "total_duration_s": None,
                "scheduled_workout_id": None,
            },
        ],
        "nutrition": [
            {
                "schema": "plan-nutrition/v1",
                "date": "2026-06-21",
                "kcal_target": 2800,
                "carbs_g": 400,
                "protein_g": 130,
                "fat_g": 70,
                "water_ml": 2800,
                "meals": [
                    {
                        "name": "早餐",
                        "time_hint": "7:00",
                        "kcal": 650,
                        "carbs_g": 100,
                        "protein_g": 25,
                        "fat_g": 12,
                        "items_md": "燕麦 80g + 香蕉 + 鸡蛋 2 个",
                    }
                ],
                "notes_md": "长跑日加碳",
            }
        ],
        "notes_md": "专项期 W3：1 长跑 + 1 阈值 + easy",
    }


def _make_input_payload() -> dict:
    return {
        "phase_type": "build",
        "week_meta": {
            "phase_position": "build week 3/7",
            "week_folder": WEEK_FOLDER,
            "target_weekly_km": 80.0,
        },
        "goal": _fm_goal(),
        "level": 65.0,
        "injuries": [],
    }


def _make_state(
    payload: dict | None = None,
    *,
    context: dict | None = None,
    iteration: int = 0,
    rule_violations: list[dict] | None = None,
) -> dict:
    return {
        "job_id": "",
        "user_id": USER_ID,
        "plan_type": "week",
        "input_payload": payload if payload is not None else _make_input_payload(),
        "context": context or {},
        "iteration": iteration,
        "rule_violations": rule_violations or [],
    }


from tests.stride_server._fake_bindable_llm import FakeBindableLLM, ai_text


class _FakeLLMHandle:
    """Adapts the old ``replies: list[str]`` fake-LLM surface to the new
    bindable-model path. Each string reply becomes an ``AIMessage`` whose
    content is the canned plan JSON; the tool loop (no tool_calls) returns it
    verbatim. ``captured`` mirrors the old ``[(system, messages), ...]`` shape
    so existing assertions keep working — but ``messages`` are now langchain
    BaseMessages, not OpenAI dicts.
    """

    def __init__(self) -> None:
        self.replies: list[str] = []
        self._model: FakeBindableLLM | None = None

    def _build_model(self) -> FakeBindableLLM:
        # Defer until first get_generator_llm() so replies set in the test body
        # are captured. The singleton is rebuilt each call (the adapter calls
        # get_generator_llm per pass) but shares one captured/idx via closure.
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
    # Pin a deterministic "today" so pace_targets snapshot lookups are stable.
    monkeypatch.setattr(adapter_mod, "today_shanghai", lambda: _AS_OF)
    return handle


# ---------------------------------------------------------------------------
# build_specialist_context helper
# ---------------------------------------------------------------------------


def test_build_specialist_context_returns_pace_and_volume(db: Database):
    _seed_calibration(db)
    from stride_core.master_plan import PhaseType
    from coach.graphs.generation.weekly_prompt import WeekMeta

    wm = WeekMeta(phase_position="build week 3/7", week_folder=WEEK_FOLDER, target_weekly_km=80.0)
    pt, vt = build_specialist_context(
        db, goal=_fm_goal(), phase_type=PhaseType.BUILD, week_meta=wm, level=65.0, as_of=_AS_OF
    )
    # threshold pace = 1000 / 4.0 = 250
    assert pt.threshold_pace_s_km == pytest.approx(250.0, abs=0.5)
    # volume budget honours the week target
    assert vt.weekly_km == pytest.approx(80.0, abs=0.5)
    assert vt.long_run_km / vt.weekly_km <= 0.35 + 1e-9


# ---------------------------------------------------------------------------
# valid → parses
# ---------------------------------------------------------------------------


def test_valid_llm_output_returns_current_draft(db, monkeypatch, fake_llm):
    _seed_calibration(db)
    monkeypatch.setattr(adapter_mod, "Database", lambda **kw: db)
    fake_llm.replies = [json.dumps(_valid_plan_dict(), ensure_ascii=False)]

    out = generate_specialist_week(_make_state())
    assert "current_draft" in out
    draft = out["current_draft"]
    # The returned draft must round-trip through WeeklyPlan.from_dict
    plan = WeeklyPlan.from_dict(draft)
    assert plan.week_folder == WEEK_FOLDER
    assert len(plan.sessions) == 3
    # aspirational — all specs null
    assert all(s.spec is None for s in plan.sessions)


# ---------------------------------------------------------------------------
# garbage → parse_failed
# ---------------------------------------------------------------------------


def test_garbage_raises_parse_failed(db, monkeypatch, fake_llm):
    _seed_calibration(db)
    monkeypatch.setattr(adapter_mod, "Database", lambda **kw: db)
    # Garbage on both the first call and the retry.
    fake_llm.replies = ["这是完全无法解析的输出，没有 JSON。"]

    with pytest.raises(ValueError) as exc:
        generate_specialist_week(_make_state())
    assert str(exc.value).startswith("parse_failed")


# ---------------------------------------------------------------------------
# bad_schema → bad_schema
# ---------------------------------------------------------------------------


def test_bad_schema_raises_bad_schema(db, monkeypatch, fake_llm):
    _seed_calibration(db)
    monkeypatch.setattr(adapter_mod, "Database", lambda **kw: db)
    # Parses as JSON but isn't a valid WeeklyPlan (missing week_folder/sessions
    # and a session with an invalid date).
    bad = {"schema": "weekly-plan/v1", "sessions": [{"kind": "run"}]}
    fake_llm.replies = [json.dumps(bad)]

    with pytest.raises(ValueError) as exc:
        generate_specialist_week(_make_state())
    assert str(exc.value).startswith("bad_schema")


# ---------------------------------------------------------------------------
# pace/volume present in the composed prompt
# ---------------------------------------------------------------------------


def test_prompt_carries_pace_and_volume(db, monkeypatch, fake_llm):
    _seed_calibration(db)
    monkeypatch.setattr(adapter_mod, "Database", lambda **kw: db)
    fake_llm.replies = [json.dumps(_valid_plan_dict(), ensure_ascii=False)]

    generate_specialist_week(_make_state())
    system_prompt = fake_llm.captured[0][0]
    # pace table markers (from PaceTargets.render)
    assert "阈值" in system_prompt
    assert "VO2max" in system_prompt
    # volume budget markers (from VolumeTargets.render)
    assert "周量" in system_prompt
    assert "质量预算" in system_prompt
    # the build specialist guidance got composed in
    assert "专项期" in system_prompt
    # the week folder framing got injected
    assert WEEK_FOLDER in system_prompt


# ---------------------------------------------------------------------------
# parse retry recovers
# ---------------------------------------------------------------------------


def test_parse_failed_first_attempt_recovers_on_retry(db, monkeypatch, fake_llm):
    _seed_calibration(db)
    monkeypatch.setattr(adapter_mod, "Database", lambda **kw: db)
    fake_llm.replies = [
        "无法解析",
        json.dumps(_valid_plan_dict(), ensure_ascii=False),
    ]

    out = generate_specialist_week(_make_state())
    assert "current_draft" in out
    assert len(fake_llm.captured) == 2  # retried exactly once


# ---------------------------------------------------------------------------
# rule-violation feedback postscript on retry iterations
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# missing calibration → pace_targets ValueError propagates un-prefixed
# ---------------------------------------------------------------------------


def test_missing_calibration_propagates_pace_targets_error(db, monkeypatch, fake_llm):
    """No seeded calibration snapshot → pace_targets raises ValueError whose
    message references ``pace_targets``, and it must surface *un-prefixed* —
    NOT re-wrapped as ``bad_schema`` / ``parse_failed``. This locks the
    documented precondition contract for Task 5/6: a missing-calibration
    precondition is a distinct, propagated error, not a swallowed one.
    """
    # Deliberately do NOT call _seed_calibration(db) — the snapshot is absent.
    monkeypatch.setattr(adapter_mod, "Database", lambda **kw: db)
    # A valid LLM reply is irrelevant: the error fires before any LLM use.
    fake_llm.replies = [json.dumps(_valid_plan_dict(), ensure_ascii=False)]

    with pytest.raises(ValueError, match="pace_targets") as exc:
        generate_specialist_week(_make_state())
    msg = str(exc.value)
    # Distinct error — not swallowed and not re-prefixed by the generator.
    assert not msg.startswith("bad_schema")
    assert not msg.startswith("parse_failed")
    # The LLM was never reached (precondition failed first).
    assert fake_llm.captured == []


# ---------------------------------------------------------------------------
# unknown phase_type → bad_schema (via _coerce_phase_type)
# ---------------------------------------------------------------------------


def test_unknown_phase_type_raises_bad_schema(db, monkeypatch, fake_llm):
    """A bogus ``phase_type`` is rejected by ``_coerce_phase_type`` with a
    ``bad_schema``-prefixed ValueError, before the DB is opened or the LLM is
    called. Calibration is seeded to prove the failure is the phase coercion
    (not a missing-snapshot side effect).
    """
    _seed_calibration(db)
    monkeypatch.setattr(adapter_mod, "Database", lambda **kw: db)
    fake_llm.replies = [json.dumps(_valid_plan_dict(), ensure_ascii=False)]

    payload = _make_input_payload()
    payload["phase_type"] = "nonsense"

    with pytest.raises(ValueError, match="bad_schema") as exc:
        generate_specialist_week(_make_state(payload))
    assert str(exc.value).startswith("bad_schema")
    # Coercion happens before any LLM call.
    assert fake_llm.captured == []


def test_rule_violation_feedback_postscript(db, monkeypatch, fake_llm):
    _seed_calibration(db)
    monkeypatch.setattr(adapter_mod, "Database", lambda **kw: db)
    fake_llm.replies = [json.dumps(_valid_plan_dict(), ensure_ascii=False)]

    state = _make_state(
        iteration=1,
        rule_violations=[
            {"rule": "long_run_share_max", "message": "长跑占周量 > 35%"},
        ],
    )
    generate_specialist_week(state)
    # the corrective postscript should appear in the user (Human) message
    user_messages = fake_llm.captured[0][1]
    user_text = " ".join(
        (m.content if isinstance(m.content, str) else str(m.content))
        for m in user_messages
    )
    assert "long_run_share_max" in user_text


# ---------------------------------------------------------------------------
# tool-calling actually fires: a base-phase specialist calls strength_library,
# the wrapper is invoked, its result flows back, and the final plan still parses
# ---------------------------------------------------------------------------


def _base_payload() -> dict:
    """A base-phase payload — base declares ('strength_library','recent_training')."""
    p = _make_input_payload()
    p["phase_type"] = "base"
    p["week_meta"]["phase_position"] = "base week 1/4"
    p["injuries"] = ["knee"]
    return p


def test_strength_library_tool_is_invoked_in_generation(db, monkeypatch):
    """A base specialist that asks for strength_library triggers the wrapper;
    its ToolResult flows back as a ToolMessage and the final plan still parses.
    This proves strength_library now *executes in the generation path* (injury
    filtering finally runs) — the headline payoff of Task 8.
    """
    from tests.stride_server._fake_bindable_llm import (
        FakeBindableLLM,
        ai_text,
        ai_tool_call,
    )

    _seed_calibration(db)
    monkeypatch.setattr(adapter_mod, "Database", lambda **kw: db)
    monkeypatch.setattr(adapter_mod, "today_shanghai", lambda: _AS_OF)

    plan_json = json.dumps(_valid_plan_dict(), ensure_ascii=False)
    # Round 1: ask for strength_library (glute_med). Round 2: emit the plan.
    model = FakeBindableLLM(
        [
            ai_tool_call("strength_library", {"targets": ["glute_med"]}, tc_id="c1"),
            ai_text(plan_json),
        ]
    )
    monkeypatch.setattr(adapter_mod, "get_generator_llm", lambda: model)

    out = generate_specialist_week(_make_state(_base_payload()))
    assert "current_draft" in out
    WeeklyPlan.from_dict(out["current_draft"])  # round-trips

    # The tool was actually bound (base declares strength_library + recent_training).
    bound_names = {getattr(t, "name", None) for t in model.bound_tools}
    assert "strength_library" in bound_names
    assert "recent_training" in bound_names

    # Round 2's messages must carry the ToolMessage with the strength_library
    # result — i.e. the wrapper executed and its data flowed back to the model.
    from langchain_core.messages import ToolMessage

    second_round = model.invocations[1]
    tool_msgs = [m for m in second_round if isinstance(m, ToolMessage)]
    assert len(tool_msgs) == 1
    assert tool_msgs[0].tool_call_id == "c1"
    # The bound injuries=['knee'] filtered out the squat move (single leg squats);
    # clamshell (a non-squat glute_med move) survived — proving injury filtering
    # ran inside the generation path.
    assert "clamshell" in tool_msgs[0].content
    assert "single leg squats" not in tool_msgs[0].content
