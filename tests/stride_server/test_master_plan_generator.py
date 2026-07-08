"""Tests for master_plan_generator (T13).

Covers:
1. Valid sentinel JSON → MasterPlan saved + job DONE
2. Fenced ```json block → success (layer 2)
3. Balanced braces only → success (layer 3)
4. Garbage output → job FAILED + raw_output populated
5. LLMUnavailable → job FAILED + error="llm_unavailable"
6. LLMError(retryable=True) → job FAILED + error contains message
7. schema != "weekly-plan/master/v1" → FAILED + error="bad_schema:..."
8. Missing plan.phases → MasterPlan with phases=[]
9. _parse_llm_output unit tests for each layer
"""

from __future__ import annotations

import json
import threading
from datetime import date, datetime, timezone
from typing import Any
from unittest.mock import MagicMock
from uuid import uuid4

import pytest

from stride_server.job_runner import (
    JobStatus,
    JobStage,
    create_job,
    get_job,
    _reset_jobs_for_tests,
)
import stride_server.coach_adapters.master_plan_adapter as adapter_mod
from stride_server.master_plan_generator import (
    _build_master_plan,
    _parse_llm_output,
    _query_history,
    run_generate_job,
)
from stride_core.master_plan import MasterPlan, MasterPlanStatus, MilestoneType

# ---------------------------------------------------------------------------
# Constants / helpers
# ---------------------------------------------------------------------------


def _full_prompt(**kwargs) -> str:
    """system + user prompts concatenated.

    Most content-regression tests only care that the LLM sees a token
    *somewhere* across the two turns, not which turn carries it. The
    split itself (athlete data in user, doctrine in system) is asserted
    separately in :class:`TestPromptRoleSplit`.
    """
    from stride_server.master_plan_generator import build_master_prompts
    system, user = build_master_prompts(**kwargs)
    return system + "\n" + user


USER_ID = "a1b2c3d4-e5f6-4aaa-89ab-000000000001"
GOAL_ID = "goal-0001"

GOAL = {
    "id": GOAL_ID,
    "type": "race",
    "race_date": "2026-11-01",
    "race_distance": "marathon",
    "target_finish_time": "3:30:00",
    "weekly_training_days": 5,
}

PROFILE = {
    "current_weekly_km": 50,
    "years_running": 3,
    "pb_marathon": "3:45:00",
}


def test_athlete_memory_injected_into_user_prompt_only():
    """A4: long-term facts feed planning as soft constraints, in the USER turn."""
    from coach.contracts import AthleteMemory
    from stride_server.master_plan_generator import build_master_prompts

    system, user = build_master_prompts(
        GOAL, PROFILE, "history", {}, "2026-05-09",
        athlete_memories=[
            AthleteMemory(
                id="m1", kind="life_event", content="现迁昆明高原训练，海拔~1900m",
                affects=["pace_target", "training_load"],
            )
        ],
    )
    assert "现迁昆明高原训练" in user
    assert "pace_target" in user
    assert "Known athlete facts" in user
    # Prompt-role discipline: per-athlete data must not pollute the cacheable system.
    assert "现迁昆明高原训练" not in system


def test_no_athlete_memories_no_block():
    from stride_server.master_plan_generator import build_master_prompts

    _, user = build_master_prompts(GOAL, PROFILE, "history", {}, "2026-05-09", athlete_memories=[])
    assert "Known athlete facts" not in user


def test_previous_master_plan_context_injected_into_user_prompt_only():
    from stride_server.master_plan_generator import build_master_prompts

    prev = "上周期 peak 62 km/wk，long run 32-34 km；已完成恢复，30km后腿酸。"
    system, user = build_master_prompts(
        GOAL,
        {**PROFILE, "prev_master_plan_md": prev},
        "history",
        {},
        "2026-05-09",
    )

    assert "Previous master plan context" in user
    assert "32-34km" in user
    assert "completed recovery" in user
    assert "Current cycle position block" in user
    assert "Previous master plan context" not in system

_VALID_PLAN_DICT = {
    "schema": "weekly-plan/master/v1",
    "plan": {
        "start_date": "2026-05-12",
        "end_date": "2026-11-01",
        "training_principles": [
            "渐进增量，每周跑量增幅不超过 10%",
            "以有氧基础为核心",
            "每 4 周安排一次减量恢复",
        ],
        "phases": [
            {
                "name": "基础期",
                "start_date": "2026-05-12",
                "end_date": "2026-07-05",
                "focus": "建立有氧基础",
                "weekly_distance_km_low": 40,
                "weekly_distance_km_high": 55,
                "key_session_types": ["长距离", "中距离", "有氧"],
            },
            {
                "name": "进展期",
                "start_date": "2026-07-06",
                "end_date": "2026-09-06",
                "focus": "提升乳酸阈值与专项耐力",
                "weekly_distance_km_low": 55,
                "weekly_distance_km_high": 70,
                "key_session_types": ["节奏跑", "长距离", "间歇"],
            },
            {
                # Added so the plan satisfies master_rule_filter rules
                # phase_count_min (>= 3 phases) and peak_before_race
                # (last phase ends 7-21 days before race milestone).
                # Race is 2026-11-01, peak ends 2026-10-18 -> 14-day taper.
                "name": "赛前期",
                "start_date": "2026-09-07",
                "end_date": "2026-10-18",
                "focus": "比赛专项 + 减量",
                "weekly_distance_km_low": 45,
                "weekly_distance_km_high": 60,
                "key_session_types": ["马拉松配速", "短间歇", "减量"],
            },
        ],
        "milestones": [
            {
                "type": "long_run",
                "date": "2026-06-07",
                "phase_name": "基础期",
                "target": "28K 轻松跑",
            },
            {
                "type": "test_run",
                "date": "2026-07-05",
                "phase_name": "基础期",
                "target": "10K 测速",
            },
            {
                "type": "race",
                "date": "2026-11-01",
                "phase_name": "进展期",
                "target": "全马目标 3:30",
            },
        ],
    },
}

_VALID_JSON_STR = json.dumps(_VALID_PLAN_DICT, ensure_ascii=False)


def _sentinel_wrap(payload: str) -> str:
    return f"---BEGIN_MASTER_PLAN---\n{payload}\n---END_MASTER_PLAN---"


def _fenced_wrap(payload: str) -> str:
    return f"```json\n{payload}\n```"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def reset_jobs():
    _reset_jobs_for_tests()
    yield
    _reset_jobs_for_tests()


@pytest.fixture
def mock_store():
    """In-memory mock MasterPlanStore."""
    store = MagicMock()
    store.saved_plans: list[MasterPlan] = []

    def _save_plan(plan: MasterPlan) -> None:
        store.saved_plans.append(plan)

    store.save_plan.side_effect = _save_plan
    return store


@pytest.fixture
def patch_store(monkeypatch, mock_store):
    """Monkeypatch get_master_plan_store to return mock_store."""
    import stride_server.master_plan_generator as mod
    import stride_server.coach_adapters.master_plan_adapter as adapter_mod  # noqa: F401 — fixture-scoped seed; tests below reuse the alias
    monkeypatch.setattr(mod, "get_master_plan_store", lambda: mock_store)
    return mock_store


@pytest.fixture
def patch_history(monkeypatch):
    """Patch DB queries to return empty history (avoids needing a real DB)."""
    import stride_server.master_plan_generator as mod

    monkeypatch.setattr(mod, "_query_history", lambda uid: {
        "monthly_km": [],
        "max_weekly_km": 0.0,
        "total_activities": 0,
        "weekly_profile": [],
    })
    monkeypatch.setattr(mod, "_query_fitness_state", lambda uid: {
        "ctl": None,
        "atl": None,
        "tsb": None,
        "rhr": None,
        "summary": "体能数据暂无",
    })
    # load_master_context now calls analyze_continuity with Database(user=...),
    # which for the test USER_ID would open/create a real (empty) DB as a side
    # effect. Stub it on the ADAPTER module (where the name is used) so the
    # flow tests stay hermetic. Patch the binding the code actually calls —
    # the adapter imports analyze_continuity at module load, so patch
    # adapter_mod.analyze_continuity, not the analyzer module's name.
    import stride_server.coach_adapters.master_plan_adapter as adapter_mod
    monkeypatch.setattr(adapter_mod, "analyze_continuity", lambda *a, **k: None)


def _make_fake_llm(response: str):
    """Return a FakeLLMClient class that returns response from chat_sync."""

    class FakeLLMClient:
        def __init__(self) -> None:
            pass

        def chat_sync(self, *args: Any, **kwargs: Any) -> str:
            return response

    return FakeLLMClient


def _run_job_sync(job_id: str, goal: dict = GOAL, profile: dict | None = PROFILE) -> None:
    """Run run_generate_job in the current thread (synchronous for tests)."""
    run_generate_job(job_id, USER_ID, goal, profile)


def test_generate_master_plan_returns_prompt_size_metadata(monkeypatch):
    raw_response = _sentinel_wrap(_VALID_JSON_STR)

    class CapturingLLMClient:
        kwargs_seen: list[dict[str, Any]] = []

        def __init__(self) -> None:
            pass

        def chat_sync(self, *args: Any, **kwargs: Any) -> str:
            CapturingLLMClient.kwargs_seen.append(kwargs)
            return raw_response

    CapturingLLMClient.kwargs_seen = []
    monkeypatch.setattr(adapter_mod, "LLMClient", CapturingLLMClient)

    out = adapter_mod.generate_master_plan(
        {
            "job_id": "",
            "user_id": "",
            "input_payload": {"goal": GOAL, "profile": PROFILE},
            "runtime_options": {"master_max_tokens": 20000},
            "context": {
                "history_summary": "history",
                "pb_seconds": {"fm": 10762},
                "fitness_state": {"summary": "fitness"},
            },
        }
    )

    metadata = out["timing_metadata"]
    assert metadata["generator_system_prompt_chars"] > 0
    assert metadata["generator_user_prompt_chars"] > 0
    assert metadata["generator_max_tokens"] == 20000
    assert metadata["generator_raw_response_chars"] == len(raw_response)
    assert CapturingLLMClient.kwargs_seen == [{"max_tokens": 20000}]


def test_generate_master_plan_passes_context_pb_seconds_to_builder(monkeypatch):
    raw_response = _sentinel_wrap(_VALID_JSON_STR)
    seen: dict[str, Any] = {}

    def fake_build(parsed, user_id, goal, profile=None, generated_by="unknown", pb_seconds=None):
        seen["pb_seconds"] = pb_seconds
        return _build_master_plan(
            parsed,
            user_id,
            goal,
            profile=profile,
            generated_by=generated_by,
            pb_seconds=pb_seconds,
        )

    monkeypatch.setattr(adapter_mod, "LLMClient", _make_fake_llm(raw_response))
    monkeypatch.setattr(adapter_mod, "_build_master_plan", fake_build)

    adapter_mod.generate_master_plan(
        {
            "job_id": "",
            "user_id": USER_ID,
            "input_payload": {"goal": GOAL, "profile": PROFILE},
            "context": {
                "history_summary": "history",
                "fitness_state": {"summary": "fitness"},
                "pb_seconds": {"fm": 10762.0},
            },
        }
    )

    assert seen["pb_seconds"] == {"fm": 10762.0}


def test_master_plan_generation_uses_s1_specific_output_cap():
    """S1 master plans should not inherit the 128k phase-at-once budget.

    The cap still needs to stay above the observed 13-16k raw response range
    so larger fixtures have parse-safe headroom.
    """
    assert adapter_mod.MASTER_PLAN_MAX_TOKENS == 24576


# ---------------------------------------------------------------------------
# _parse_llm_output unit tests
# ---------------------------------------------------------------------------


class TestParseLlmOutput:
    def test_layer1_sentinel(self):
        raw = _sentinel_wrap(_VALID_JSON_STR)
        result = _parse_llm_output(raw)
        assert result is not None
        assert result["schema"] == "weekly-plan/master/v1"

    def test_layer2_fenced_json(self):
        raw = _fenced_wrap(_VALID_JSON_STR)
        result = _parse_llm_output(raw)
        assert result is not None
        assert result["schema"] == "weekly-plan/master/v1"

    def test_layer3_balanced_braces(self):
        # Raw JSON with preamble text
        raw = "Here is the plan: " + _VALID_JSON_STR + " (end)"
        result = _parse_llm_output(raw)
        assert result is not None
        assert result["schema"] == "weekly-plan/master/v1"

    def test_layer3_uses_first_complete_json_object_when_tail_has_extra_brace(self):
        """Phase-at-once generation sometimes returns a valid JSON envelope
        followed by one stray closing brace. The parser should recover the
        first complete object instead of slicing through the last brace and
        turning it into ``Extra data``.
        """
        raw = _VALID_JSON_STR + "}"
        result = _parse_llm_output(raw)
        assert result is not None
        assert result["schema"] == "weekly-plan/master/v1"

    def test_sentinel_takes_priority_over_fenced(self):
        """Sentinel layer is tried first; fenced block is ignored."""
        sentinel_payload = {"schema": "weekly-plan/master/v1", "plan": {"start_date": "2026-01-01", "end_date": "2026-12-31", "phases": [], "milestones": [], "training_principles": []}}
        fenced_payload = {"schema": "wrong-schema", "plan": {}}
        raw = (
            _sentinel_wrap(json.dumps(sentinel_payload))
            + "\n"
            + _fenced_wrap(json.dumps(fenced_payload))
        )
        result = _parse_llm_output(raw)
        assert result is not None
        assert result["schema"] == "weekly-plan/master/v1"

    def test_returns_none_for_garbage(self):
        result = _parse_llm_output("完全无效的文本，没有 JSON")
        assert result is None

    def test_returns_none_for_empty_string(self):
        result = _parse_llm_output("")
        assert result is None

    def test_broken_sentinel_falls_through_to_fenced(self):
        """Broken JSON inside sentinel → try fenced block."""
        broken_sentinel = "---BEGIN_MASTER_PLAN---\n{broken\n---END_MASTER_PLAN---"
        valid_fenced = _fenced_wrap(_VALID_JSON_STR)
        raw = broken_sentinel + "\n" + valid_fenced
        result = _parse_llm_output(raw)
        assert result is not None
        assert result["schema"] == "weekly-plan/master/v1"


# ---------------------------------------------------------------------------
# _build_master_plan unit tests
# ---------------------------------------------------------------------------


class TestBuildMasterPlan:
    def test_happy_path(self):
        plan = _build_master_plan(_VALID_PLAN_DICT, USER_ID, GOAL)
        assert plan.user_id == USER_ID
        assert plan.goal.goal_id == GOAL_ID
        assert plan.status == MasterPlanStatus.DRAFT
        assert plan.version == 1
        # generated_by defaults to "unknown" when the caller doesn't supply it;
        # the generator adapter passes the configured model id in production.
        assert plan.generated_by == "unknown"
        # 3 phases: 基础期 + 进展期 + 赛前期 (the 赛前期 added so the fixture
        # satisfies the new master_rule_filter; without it phase_count_min fails).
        assert len(plan.phases) == 3
        assert len(plan.milestones) == 3
        assert len(plan.training_principles) == 3

    def test_milestone_types_parsed(self):
        plan = _build_master_plan(_VALID_PLAN_DICT, USER_ID, GOAL)
        types = {m.type for m in plan.milestones}
        assert MilestoneType.LONG_RUN in types
        assert MilestoneType.TEST_RUN in types
        assert MilestoneType.RACE in types

    def test_phase_milestone_ids_populated(self):
        plan = _build_master_plan(_VALID_PLAN_DICT, USER_ID, GOAL)
        # 基础期 should own 2 milestones (long_run + test_run)
        base_phase = next(p for p in plan.phases if p.name == "基础期")
        assert len(base_phase.milestone_ids) == 2

    def test_wrong_schema_raises(self):
        bad = dict(_VALID_PLAN_DICT)
        bad["schema"] = "wrong/v99"
        with pytest.raises(ValueError, match="unexpected schema"):
            _build_master_plan(bad, USER_ID, GOAL)

    def test_missing_plan_key_raises(self):
        with pytest.raises(ValueError, match="missing or invalid 'plan'"):
            _build_master_plan({"schema": "weekly-plan/master/v1"}, USER_ID, GOAL)

    def test_empty_phases_allowed(self):
        data = {
            "schema": "weekly-plan/master/v1",
            "plan": {
                "start_date": "2026-05-12",
                "end_date": "2026-11-01",
                "phases": [],
                "milestones": [],
                "training_principles": ["原则1"],
            },
        }
        plan = _build_master_plan(data, USER_ID, GOAL)
        assert plan.phases == []
        assert plan.milestones == []

    def test_unknown_milestone_type_defaults_to_long_run(self):
        data = json.loads(_VALID_JSON_STR)
        data["plan"]["milestones"][0]["type"] = "unknown_type_xyz"
        plan = _build_master_plan(data, USER_ID, GOAL)
        assert plan.milestones[0].type == MilestoneType.LONG_RUN

    def test_tune_up_race_milestone_alias_maps_to_test_run(self):
        data = json.loads(_VALID_JSON_STR)
        data["plan"]["milestones"][0]["type"] = "tune_up_race"

        plan = _build_master_plan(data, USER_ID, GOAL)

        assert plan.milestones[0].type == MilestoneType.TEST_RUN

    def test_non_target_race_milestone_maps_to_test_run(self):
        data = json.loads(_VALID_JSON_STR)
        data["plan"]["milestones"][0].update({
            "type": "race",
            "date": "2026-07-05",
            "target": "10K tune-up",
        })

        plan = _build_master_plan(
            data,
            USER_ID,
            {"distance": "10k", "race_date": "2026-09-20"},
        )

        assert plan.milestones[0].type == MilestoneType.TEST_RUN

    def test_target_race_milestone_stays_race(self):
        data = json.loads(_VALID_JSON_STR)
        data["plan"]["milestones"][0].update({
            "type": "race",
            "date": "2026-09-20",
        })

        plan = _build_master_plan(
            data,
            USER_ID,
            {"target_race": {"distance": "10k", "race_date": "2026-09-20"}},
        )

        assert plan.milestones[0].type == MilestoneType.RACE

    def test_builds_embedded_goal_from_training_goal_dict(self):
        goal = {
            "goal_id": GOAL_ID,
            "type": "race",
            "race_name": "Shanghai Marathon",
            "race_date": "2026-11-01",
            "race_distance": "FM",
            "target_finish_time": "3:25:00",
            "timezone": "Asia/Shanghai",
            "location": "Shanghai",
        }
        plan = _build_master_plan(_VALID_PLAN_DICT, USER_ID, goal)

        assert plan.goal.goal_id == GOAL_ID
        assert plan.goal.race_name == "Shanghai Marathon"
        assert plan.goal.distance == "FM"
        assert plan.goal.race_date == "2026-11-01"
        assert plan.goal.target_time == "3:25:00"
        assert plan.goal.timezone == "Asia/Shanghai"
        assert plan.goal.location == "Shanghai"

    def test_goal_location_stays_null_when_not_provided(self):
        goal = {
            "goal_id": GOAL_ID,
            "type": "race",
            "race_name": "Shanghai Marathon",
            "race_date": "2026-11-01",
            "race_distance": "FM",
            "target_finish_time": "3:25:00",
            "timezone": "Asia/Shanghai",
        }

        plan = _build_master_plan(_VALID_PLAN_DICT, USER_ID, goal)

        assert plan.goal.location is None
        assert plan.model_dump(mode="json")["goal"]["location"] is None

    def test_goal_location_ignores_llm_inference(self):
        data = json.loads(_VALID_JSON_STR)
        data["plan"]["goal"] = {
            "goal_id": GOAL_ID,
            "race_name": "Shanghai Marathon",
            "distance": "FM",
            "race_date": "2026-11-01",
            "target_time": "3:25:00",
            "timezone": "Asia/Shanghai",
            "location": "Shanghai",
        }

        plan = _build_master_plan(data, USER_ID, {"goal_id": GOAL_ID})

        assert plan.goal.location is None

    def test_builds_canonical_weeks_from_llm_weeks(self):
        data = json.loads(_VALID_JSON_STR)
        data["plan"]["weeks"] = [
            {
                "week_index": 1,
                "week_start": "2026-05-11",
                "phase_name": "基础期",
                "target_weekly_km_low": 40,
                "target_weekly_km_high": 48,
                "key_sessions": [
                    {
                        "type": "long_run",
                        "distance_km": 20,
                        "intensity": "z2",
                        "purpose": "建立有氧耐力",
                    }
                ],
            }
        ]

        plan = _build_master_plan(data, USER_ID, GOAL)

        assert len(plan.weeks) == 1
        assert plan.weeks[0].week_index == 1
        assert plan.weeks[0].phase_id == plan.phases[0].id
        assert plan.weeks[0].key_sessions[0].type == "long_run"
        assert plan.weekly_key_sessions[0].week_start == "2026-05-11"

    def test_legacy_weekly_key_sessions_maps_to_canonical_weeks(self):
        data = json.loads(_VALID_JSON_STR)
        data["plan"]["weekly_key_sessions"] = [
            {
                "week_index": 1,
                "week_start": "2026-05-11",
                "phase_name": "基础期",
                "target_weekly_km_low": 40,
                "target_weekly_km_high": 48,
                "key_sessions": [{"type": "long_run", "distance_km": 20}],
            }
        ]

        plan = _build_master_plan(data, USER_ID, GOAL)

        assert len(plan.weeks) == 1
        assert plan.weeks[0].target_weekly_km_high == 48
        assert plan.weekly_key_sessions[0].week_index == 1

    def test_finish_only_goal_generates_with_empty_target_time(self):
        # 「仅完赛即可」: a goal with no target_finish_time must NOT raise — the
        # plan targets completion and carries an empty target_time.
        goal = {k: v for k, v in GOAL.items() if k != "target_finish_time"}
        plan = _build_master_plan(_VALID_PLAN_DICT, USER_ID, goal)
        assert plan.goal.target_time == ""

    def test_goal_time_seconds_formats_embedded_target_time(self):
        goal = {k: v for k, v in GOAL.items() if k != "target_finish_time"}
        goal["goal_time_s"] = 10200

        plan = _build_master_plan(_VALID_PLAN_DICT, USER_ID, goal)

        assert plan.goal.target_time == "2:50:00"

    def test_long_run_milestone_date_aligns_to_matching_week_sunday(self):
        data = json.loads(_VALID_JSON_STR)
        data["plan"]["phases"] = [
            {
                "name": "建设期",
                "phase_type": "build",
                "start_date": "2026-07-20",
                "end_date": "2026-08-09",
                "focus": "专项建设",
                "weekly_distance_km_low": 50,
                "weekly_distance_km_high": 60,
                "key_session_types": ["long_run"],
            }
        ]
        data["plan"]["milestones"] = [
            {
                "type": "long_run",
                "date": "2026-07-26",
                "phase_name": "建设期",
                "target": "16km长跑",
                "metric": "long_run_distance_km",
                "target_value": 16,
                "comparator": ">=",
            }
        ]
        data["plan"]["weeks"] = [
            {
                "week_index": 1,
                "week_start": "2026-07-20",
                "phase_name": "建设期",
                "target_weekly_km_low": 50,
                "target_weekly_km_high": 58,
                "key_sessions": [{"type": "long_run", "distance_km": 15}],
            },
            {
                "week_index": 2,
                "week_start": "2026-07-27",
                "phase_name": "建设期",
                "target_weekly_km_low": 52,
                "target_weekly_km_high": 60,
                "key_sessions": [{"type": "long_run", "distance_km": 16}],
            },
        ]

        plan = _build_master_plan(data, USER_ID, GOAL)

        assert plan.milestones[0].date == "2026-08-02"

    def test_long_run_milestone_without_matching_week_is_not_rewritten(self):
        data = json.loads(_VALID_JSON_STR)
        data["plan"]["phases"] = [
            {
                "name": "建设期",
                "phase_type": "build",
                "start_date": "2026-07-20",
                "end_date": "2026-08-09",
                "focus": "专项建设",
                "weekly_distance_km_low": 50,
                "weekly_distance_km_high": 60,
                "key_session_types": ["long_run"],
            }
        ]
        data["plan"]["milestones"] = [
            {
                "type": "long_run",
                "date": "2026-07-26",
                "phase_name": "建设期",
                "target": "20km长跑",
                "metric": "long_run_distance_km",
                "target_value": 20,
                "comparator": ">=",
            }
        ]
        data["plan"]["weeks"] = [
            {
                "week_index": 1,
                "week_start": "2026-07-20",
                "phase_name": "建设期",
                "target_weekly_km_low": 50,
                "target_weekly_km_high": 58,
                "key_sessions": [{"type": "long_run", "distance_km": 15}],
            },
            {
                "week_index": 2,
                "week_start": "2026-07-27",
                "phase_name": "建设期",
                "target_weekly_km_low": 52,
                "target_weekly_km_high": 60,
                "key_sessions": [{"type": "long_run", "distance_km": 16}],
            },
        ]

        plan = _build_master_plan(data, USER_ID, GOAL)

        assert plan.milestones[0].date == "2026-07-26"

    def test_standard_10k_long_run_caps_at_16km_and_updates_milestone(self):
        data = json.loads(_VALID_JSON_STR)
        data["plan"]["phases"] = [
            {
                "name": "10K专项期",
                "phase_type": "build",
                "start_date": "2026-07-20",
                "end_date": "2026-08-09",
                "focus": "10K专项建设",
                "weekly_distance_km_low": 50,
                "weekly_distance_km_high": 60,
                "key_session_types": ["long_run", "interval"],
            }
        ]
        data["plan"]["milestones"] = [
            {
                "type": "long_run",
                "date": "2026-08-09",
                "phase_name": "10K专项期",
                "target": "17km长跑",
                "metric": "long_run_distance_km",
                "target_value": 17,
                "comparator": ">=",
            }
        ]
        data["plan"]["weeks"] = [
            {
                "week_index": 1,
                "week_start": "2026-08-03",
                "phase_name": "10K专项期",
                "target_weekly_km_low": 56,
                "target_weekly_km_high": 60,
                "key_sessions": [{"type": "long_run", "distance_km": 17}],
            },
        ]

        plan = _build_master_plan(data, USER_ID, {"distance": "10k"})

        assert plan.weeks[0].key_sessions[0].distance_km == 16
        assert plan.milestones[0].target_value == 16
        assert plan.milestones[0].target == "16km长跑"

    def test_high_volume_10k_long_run_is_not_capped(self):
        data = json.loads(_VALID_JSON_STR)
        data["plan"]["phases"] = [
            {
                "name": "高跑量10K专项期",
                "phase_type": "build",
                "start_date": "2026-07-20",
                "end_date": "2026-08-09",
                "focus": "高跑量10K专项建设",
                "weekly_distance_km_low": 60,
                "weekly_distance_km_high": 66,
                "key_session_types": ["long_run", "interval"],
            }
        ]
        data["plan"]["milestones"] = [
            {
                "type": "long_run",
                "date": "2026-08-09",
                "phase_name": "高跑量10K专项期",
                "target": "17km长跑",
                "metric": "long_run_distance_km",
                "target_value": 17,
                "comparator": ">=",
            }
        ]
        data["plan"]["weeks"] = [
            {
                "week_index": 1,
                "week_start": "2026-08-03",
                "phase_name": "高跑量10K专项期",
                "target_weekly_km_low": 62,
                "target_weekly_km_high": 66,
                "key_sessions": [{"type": "long_run", "distance_km": 17}],
            },
        ]

        plan = _build_master_plan(data, USER_ID, {"race_distance": "10K"})

        assert plan.weeks[0].key_sessions[0].distance_km == 17
        assert plan.milestones[0].target_value == 17

    def test_standard_5k_long_run_caps_at_12km_and_updates_milestone(self):
        data = json.loads(_VALID_JSON_STR)
        data["plan"]["phases"] = [
            {
                "name": "5K专项期",
                "phase_type": "peak",
                "start_date": "2026-08-03",
                "end_date": "2026-08-23",
                "focus": "5K专项锐化",
                "weekly_distance_km_low": 48,
                "weekly_distance_km_high": 55,
                "key_session_types": ["long_run", "vo2max"],
            }
        ]
        data["plan"]["milestones"] = [
            {
                "type": "long_run",
                "date": "2026-08-16",
                "phase_name": "5K专项期",
                "target": "14km长跑",
                "metric": "long_run_distance_km",
                "target_value": 14,
                "comparator": ">=",
            }
        ]
        data["plan"]["weeks"] = [
            {
                "week_index": 1,
                "week_start": "2026-08-10",
                "phase_name": "5K专项期",
                "target_weekly_km_low": 50,
                "target_weekly_km_high": 55,
                "key_sessions": [{"type": "long_run", "distance_km": 14}],
            },
        ]

        plan = _build_master_plan(data, USER_ID, {"distance": "5k"})

        assert plan.weeks[0].key_sessions[0].distance_km == 12
        assert plan.milestones[0].target_value == 12
        assert plan.milestones[0].target == "12km长跑"

    def test_high_volume_5k_long_run_is_not_capped(self):
        data = json.loads(_VALID_JSON_STR)
        data["plan"]["phases"] = [
            {
                "name": "高跑量5K专项期",
                "phase_type": "peak",
                "start_date": "2026-08-03",
                "end_date": "2026-08-23",
                "focus": "高跑量5K专项锐化",
                "weekly_distance_km_low": 56,
                "weekly_distance_km_high": 60,
                "key_session_types": ["long_run", "vo2max"],
            }
        ]
        data["plan"]["milestones"] = [
            {
                "type": "long_run",
                "date": "2026-08-16",
                "phase_name": "高跑量5K专项期",
                "target": "14km长跑",
                "metric": "long_run_distance_km",
                "target_value": 14,
                "comparator": ">=",
            }
        ]
        data["plan"]["weeks"] = [
            {
                "week_index": 1,
                "week_start": "2026-08-10",
                "phase_name": "高跑量5K专项期",
                "target_weekly_km_low": 56,
                "target_weekly_km_high": 60,
                "key_sessions": [{"type": "long_run", "distance_km": 14}],
            },
        ]

        plan = _build_master_plan(data, USER_ID, {"target_race": {"distance": "5k"}})

        assert plan.weeks[0].key_sessions[0].distance_km == 14
        assert plan.milestones[0].target_value == 14

    def test_post_recovery_load_week_is_not_left_at_recovery_trough(self):
        data = json.loads(_VALID_JSON_STR)
        data["plan"]["phases"] = [
            {
                "name": "峰值期",
                "phase_type": "peak",
                "start_date": "2026-09-07",
                "end_date": "2026-10-04",
                "focus": "峰值专项",
                "weekly_distance_km_low": 80,
                "weekly_distance_km_high": 112,
                "key_session_types": ["long_run", "race_pace"],
            }
        ]
        data["plan"]["weeks"] = [
            {
                "week_index": 1,
                "week_start": "2026-09-07",
                "phase_name": "峰值期",
                "target_weekly_km_low": 104,
                "target_weekly_km_high": 112,
                "key_sessions": [{"type": "long_run", "distance_km": 30}],
            },
            {
                "week_index": 2,
                "week_start": "2026-09-14",
                "phase_name": "峰值期",
                "target_weekly_km_low": 74,
                "target_weekly_km_high": 79,
                "is_recovery_week": True,
                "key_sessions": [],
            },
            {
                "week_index": 3,
                "week_start": "2026-09-21",
                "phase_name": "峰值期",
                "target_weekly_km_low": 78,
                "target_weekly_km_high": 84,
                "key_sessions": [{"type": "long_run", "distance_km": 28}],
            },
        ]

        plan = _build_master_plan(data, USER_ID, GOAL)

        assert plan.weeks[2].target_weekly_km_high == 100.8
        assert plan.weeks[2].target_weekly_km_low == 94.8

    def test_5k_peak_nutrition_avoids_marathon_fueling_language(self):
        data = json.loads(_VALID_JSON_STR)
        data["plan"]["training_principles"] = [
            "基础期营养：热量平衡，蛋白1.4-1.6g/kg。",
            "峰值锐化期营养：5-7g/kg碳水，赛配课前高碳，练胶+钠。",
            "比赛减量期营养：5K不做马拉松式碳载，熟悉餐。",
        ]

        plan = _build_master_plan(data, USER_ID, {"distance": "5k"})

        assert "5-7g/kg" not in "\n".join(plan.training_principles)
        assert "练胶" not in "\n".join(plan.training_principles)
        assert "钠" not in "\n".join(plan.training_principles)
        assert any("熟悉早餐" in item for item in plan.training_principles)

    def test_aggressive_fm_gate_requires_combination_evidence(self):
        data = json.loads(_VALID_JSON_STR)
        data["plan"]["training_principles"] = [
            "PB2:59:22→2:50为5.2%，A需HM≤1:24:30或10K≤38:00+29km含22kmMP过关"
        ]
        data["plan"]["milestones"] = [
            {
                "type": "test_run",
                "date": "2026-08-02",
                "phase_name": "专项建设期",
                "target": "10K≤38:30为B观察；A仍需≤37:00或HM≤1:21:30",
                "metric": "race_time_s_10k",
                "target_value": 2310,
                "comparator": "<=",
            },
            {
                "type": "race",
                "date": "2026-10-18",
                "phase_name": "赛前期",
                "target": "A<2:50需HM≤1:24:30或10K≤38:00+29km含22kmMP全过；B2:52-2:55；C<3h",
                "metric": "race_time_s_fm",
                "target_value": 10200,
                "comparator": "<=",
            }
        ]

        plan = _build_master_plan(
            data,
            USER_ID,
            {"distance": "fm", "goal_time_s": 10200, "race_date": "2026-10-18"},
            {"experience_level": "advanced"},
            pb_seconds={"fm": 10762},
        )

        principles = "\n".join(plan.training_principles)
        support_target = plan.milestones[0].target
        race_target = plan.milestones[1].target
        for text in (principles, race_target):
            assert "A=2:50" in text
            assert "HM<=1:24:30" in text
            assert "10K<=37:45" in text
            assert "29-32km" in text
            assert "22-24kmMP" in text
            assert "MP" in text
            assert "VO2/HR/RPE" in text
            assert "跟腱" in text
            assert "B=2:52-2:55" in text
            assert "10K≤38:00" not in text
            assert "HM≤1:21:30" not in text
            assert "10K>=38:00" in text
            assert "观察/B" in text

        assert "10K≤38:30为B观察" in support_target
        assert "A=2:50按比赛里程碑" in support_target
        assert "HM≤1:21:30" not in support_target

    def test_aggressive_fm_gate_normalizes_stale_distance_wording(self):
        data = json.loads(_VALID_JSON_STR)
        data["plan"]["training_principles"] = [
            "PB2:59:22→2:50为5.2%；A=2:50需HM<=1:24:30/10K<=37:45 + 31-32km含22-24kmMP + VO2/HR/RPE + 跟腱全过。"
        ]
        data["plan"]["milestones"] = [
            {
                "type": "race",
                "date": "2026-10-18",
                "phase_name": "赛前期",
                "target": "A=2:50需HM<=1:24:30/10K<=37:45 + 31-32km含22-24kmMP + VO2/HR/RPE + 跟腱全过；B=2:52-2:55。",
                "metric": "race_time_s_fm",
                "target_value": 10200,
                "comparator": "<=",
            }
        ]

        plan = _build_master_plan(
            data,
            USER_ID,
            {"distance": "fm", "goal_time_s": 10200, "race_date": "2026-10-18"},
            {"experience_level": "advanced"},
            pb_seconds={"fm": 10762},
        )

        rendered = "\n".join(plan.training_principles + [plan.milestones[0].target])
        assert "29-32km" in rendered
        assert "最大合法MP彩排" in rendered
        assert "31-32km" not in rendered

    def test_aggressive_fm_gate_does_not_mask_unrealistic_fm_goal(self):
        data = json.loads(_VALID_JSON_STR)
        data["plan"]["training_principles"] = [
            "PB3:45→2:50过于激进，本周期建议保守。"
        ]

        plan = _build_master_plan(
            data,
            USER_ID,
            {"distance": "fm", "goal_time_s": 10200, "race_date": "2026-10-18"},
            {"experience_level": "advanced"},
            pb_seconds={"fm": 13500},
        )

        assert "A=2:50" not in "\n".join(plan.training_principles)

    def test_aggressive_fm_gate_uses_target_specific_thresholds(self):
        data = json.loads(_VALID_JSON_STR)
        data["plan"]["training_principles"] = [
            "PB2:55:00→2:45为5.7%，A需HM≤1:24:30或10K≤37:45+31km含22kmMP过关"
        ]
        data["plan"]["milestones"] = [
            {
                "type": "race",
                "date": "2026-10-18",
                "phase_name": "赛前期",
                "target": "A<2:45需HM≤1:24:30或10K≤37:45+31km含22kmMP全过；B2:47-2:50；C破PB",
                "metric": "race_time_s_fm",
                "target_value": 9900,
                "comparator": "<=",
            }
        ]

        plan = _build_master_plan(
            data,
            USER_ID,
            {"distance": "fm", "goal_time_s": 9900, "race_date": "2026-10-18"},
            {"experience_level": "advanced"},
            pb_seconds={"fm": 10500},
        )

        rendered = "\n".join(plan.training_principles + [plan.milestones[0].target])
        assert "A=2:45" in rendered
        assert "HM<=1:22:00" in rendered
        assert "10K<=36:30" in rendered
        assert "B=2:47-2:50" in rendered
        assert "A=2:50" not in rendered
        assert "HM<=1:24:30" not in rendered

    def test_aggressive_fm_gate_uses_explicit_pb_seconds_with_nested_goal(self):
        data = json.loads(_VALID_JSON_STR)
        data["plan"]["training_principles"] = [
            "PB2:55:00→2:45为5.7%，A需HM≤1:24:30或10K≤37:45+31km含22kmMP过关"
        ]
        data["plan"]["milestones"] = [
            {
                "type": "race",
                "date": "2026-10-18",
                "phase_name": "赛前期",
                "target": "A<2:45需HM≤1:24:30或10K≤37:45+31km含22kmMP全过；B2:47-2:50；C破PB",
                "metric": "race_time_s_fm",
                "target_value": 9900,
                "comparator": "<=",
            }
        ]

        plan = _build_master_plan(
            data,
            USER_ID,
            {"target_race": {"distance": "fm", "goal_time_s": 9900, "race_date": "2026-10-18"}},
            {"experience_level": "advanced"},
            pb_seconds={"fm": 10500},
        )

        rendered = "\n".join(plan.training_principles + [plan.milestones[0].target])
        assert "A=2:45" in rendered
        assert "HM<=1:22:00" in rendered
        assert "10K<=36:30" in rendered
        assert "HM<=1:24:30" not in rendered

    def test_aggressive_fm_gate_accepts_marathon_distance_alias(self):
        data = json.loads(_VALID_JSON_STR)
        data["plan"]["training_principles"] = [
            "PB2:59:22→2:50为5.2%，A需HM≤1:24:30或10K≤38:00+29km含22kmMP过关"
        ]

        plan = _build_master_plan(
            data,
            USER_ID,
            {"race_distance": "marathon", "goal_time_s": 10200, "race_date": "2026-10-18"},
            pb_seconds={"fm": 10762},
        )

        rendered = "\n".join(plan.training_principles)
        assert "A=2:50" in rendered
        assert "最大合法MP彩排" in rendered

    def test_aggressive_fm_gate_requires_advanced_pb_not_profile_volume(self):
        data = json.loads(_VALID_JSON_STR)
        data["plan"]["training_principles"] = [
            "多年跑者，PB4:00→3:45，A需HM≤1:47或10K≤48+29km过关。"
        ]

        plan = _build_master_plan(
            data,
            USER_ID,
            {"distance": "fm", "goal_time_s": 13500, "race_date": "2026-10-18"},
            {"running_age": "3y_plus", "current_weekly_km": "60_plus"},
            pb_seconds={"fm": 14400},
        )

        assert "最大合法MP彩排" not in "\n".join(plan.training_principles)

    def test_aggressive_fm_supporting_gate_rewrites_stale_target_time_test_run(self):
        data = json.loads(_VALID_JSON_STR)
        data["plan"]["training_principles"] = [
            "PB2:55:00→2:45为5.7%，A需HM≤1:24:30或10K≤37:45+31km含22kmMP过关"
        ]
        data["plan"]["milestones"] = [
            {
                "type": "test_run",
                "date": "2026-08-02",
                "phase_name": "专项建设期",
                "target": "A=2:45仍需HM≤1:24:30或10K≤37:45；10K≤38:30为B观察",
                "metric": "race_time_s_10k",
                "target_value": 2310,
                "comparator": "<=",
            },
            {
                "type": "race",
                "date": "2026-10-18",
                "phase_name": "赛前期",
                "target": "A<2:45需HM≤1:24:30或10K≤37:45+31km含22kmMP全过；B2:47-2:50；C破PB",
                "metric": "race_time_s_fm",
                "target_value": 9900,
                "comparator": "<=",
            },
        ]

        plan = _build_master_plan(
            data,
            USER_ID,
            {"distance": "fm", "goal_time_s": 9900, "race_date": "2026-10-18"},
            {"experience_level": "advanced"},
            pb_seconds={"fm": 10500},
        )

        support_target = plan.milestones[0].target
        assert "A=2:45按比赛里程碑" in support_target
        assert "10K≤38:30为B观察" in support_target
        assert "HM≤1:24:30" not in support_target
        assert "10K≤37:45" not in support_target

    def test_three_day_mp_long_run_week_drops_extra_hard_session(self):
        data = json.loads(_VALID_JSON_STR)
        data["plan"]["phases"] = [
            {
                "name": "马拉松建设期",
                "phase_type": "build",
                "start_date": "2026-07-20",
                "end_date": "2026-08-09",
                "focus": "三跑建设",
                "weekly_distance_km_low": 40,
                "weekly_distance_km_high": 48,
                "key_session_types": ["long_run", "threshold", "strength_key"],
            }
        ]
        data["plan"]["weeks"] = [
            {
                "week_index": 1,
                "week_start": "2026-07-20",
                "phase_name": "马拉松建设期",
                "target_weekly_km_low": 42,
                "target_weekly_km_high": 48,
                "key_sessions": [
                    {"type": "long_run", "distance_km": 24, "purpose": "含8km马配"},
                    {"type": "threshold", "duration_min": 30},
                    {"type": "strength_key", "duration_min": 30},
                ],
            }
        ]

        plan = _build_master_plan(
            data,
            USER_ID,
            GOAL,
            profile={"weekly_run_days_max": 3},
        )

        assert [s.type for s in plan.weeks[0].key_sessions] == [
            "long_run", "strength_key"
        ]

    def test_full_frequency_mp_long_run_week_keeps_extra_hard_session(self):
        data = json.loads(_VALID_JSON_STR)
        data["plan"]["phases"] = [
            {
                "name": "马拉松建设期",
                "phase_type": "build",
                "start_date": "2026-07-20",
                "end_date": "2026-08-09",
                "focus": "全频建设",
                "weekly_distance_km_low": 60,
                "weekly_distance_km_high": 75,
                "key_session_types": ["long_run", "threshold"],
            }
        ]
        data["plan"]["weeks"] = [
            {
                "week_index": 1,
                "week_start": "2026-07-20",
                "phase_name": "马拉松建设期",
                "target_weekly_km_low": 68,
                "target_weekly_km_high": 75,
                "key_sessions": [
                    {"type": "long_run", "distance_km": 24, "purpose": "含8km马配"},
                    {"type": "threshold", "duration_min": 30},
                ],
            }
        ]

        plan = _build_master_plan(
            data,
            USER_ID,
            GOAL,
            profile={"weekly_run_days_max": 5},
        )

        assert [s.type for s in plan.weeks[0].key_sessions] == ["long_run", "threshold"]

    def test_pushback_principle_adds_multi_cycle_path(self):
        data = json.loads(_VALID_JSON_STR)
        data["plan"]["training_principles"] = [
            "历史峰值55km，100km周量违反约10%递增，过劳风险高；本周期峰值60-70km。"
        ]

        plan = _build_master_plan(data, USER_ID, GOAL)

        assert "下周期80km" in plan.training_principles[0]
        assert "再后周期90+km" in plan.training_principles[0]


class TestBuildMapsNewFields:
    def test_phase_type_and_structured_milestone_mapped(self):
        from stride_server.master_plan_generator import _build_master_plan
        from stride_core.master_plan import PhaseType
        data = {
            "schema": "weekly-plan/master/v1",
            "plan": {
                "start_date": "2026-06-11", "end_date": "2026-10-18",
                "training_principles": ["p"],
                "phases": [{"name": "基础期", "phase_type": "base",
                            "start_date": "2026-06-11", "end_date": "2026-07-12",
                            "focus": "f", "weekly_distance_km_low": 50,
                            "weekly_distance_km_high": 64, "key_session_types": ["长距离"]}],
                "milestones": [{"type": "test_run", "date": "2026-08-09",
                                "phase_name": "基础期", "target": "5k sub-19",
                                "metric": "race_time_s_5k", "target_value": 1140,
                                "comparator": "<="}],
            },
        }
        plan = _build_master_plan(data, "u", GOAL)
        assert plan.phases[0].phase_type == PhaseType.BASE
        assert plan.milestones[0].metric == "race_time_s_5k"
        assert plan.milestones[0].target_value == 1140.0
        assert plan.milestones[0].comparator == "<="

    def test_phase_editorial_fields_mapped(self):
        # screen-3 per-phase narrative: rhythm / key_workouts /
        # monitoring_triggers / coach_note flow LLM JSON -> Phase.
        from stride_server.master_plan_generator import _build_master_plan
        data = {
            "schema": "weekly-plan/master/v1",
            "plan": {
                "start_date": "2026-06-11", "end_date": "2026-10-18",
                "training_principles": ["p"],
                "phases": [{
                    "name": "基础期", "phase_type": "base",
                    "start_date": "2026-06-11", "end_date": "2026-07-12",
                    "focus": "f", "weekly_distance_km_low": 50,
                    "weekly_distance_km_high": 64, "key_session_types": ["长距离"],
                    "rhythm": "每周 5-6 课", "key_workouts": "短间歇为主",
                    "monitoring_triggers": ["RHR +7 减量", ""],
                    "coach_note": "前 4 周宁可慢",
                }],
                "milestones": [],
            },
        }
        ph = _build_master_plan(data, "u", GOAL).phases[0]
        assert ph.rhythm == "每周 5-6 课"
        assert ph.key_workouts == "短间歇为主"
        assert ph.monitoring_triggers == ["RHR +7 减量"]  # empty entry dropped
        assert ph.coach_note == "前 4 周宁可慢"

    def test_phase_editorial_fields_default_empty_when_absent(self):
        # Backward-compat: plans that omit the editorial fields stay valid.
        from stride_server.master_plan_generator import _build_master_plan
        data = {
            "schema": "weekly-plan/master/v1",
            "plan": {
                "start_date": "2026-06-11", "end_date": "2026-10-18",
                "training_principles": ["p"],
                "phases": [{"name": "基础期", "phase_type": "base",
                            "start_date": "2026-06-11", "end_date": "2026-07-12",
                            "focus": "f", "weekly_distance_km_low": 50,
                            "weekly_distance_km_high": 64, "key_session_types": ["长距离"]}],
                "milestones": [],
            },
        }
        ph = _build_master_plan(data, "u", GOAL).phases[0]
        assert ph.rhythm == "" and ph.key_workouts == "" and ph.coach_note == ""
        assert ph.monitoring_triggers == []

    def test_performance_and_body_comp_milestones_roundtrip(self):
        """End-to-end structured path (Stage-3a P3): a phase carrying BOTH a
        performance milestone (race_time_s_5k) AND a body_composition milestone
        (body_fat_pct) must survive into the MasterPlan with the correct
        MilestoneType / metric / target_value / comparator, each attached to the
        right phase."""
        from stride_server.master_plan_generator import _build_master_plan
        data = {
            "schema": "weekly-plan/master/v1",
            "plan": {
                "start_date": "2026-06-11", "end_date": "2026-10-18",
                "training_principles": ["p"],
                "phases": [
                    {"name": "基础期", "phase_type": "base",
                     "start_date": "2026-06-11", "end_date": "2026-07-26",
                     "focus": "f", "weekly_distance_km_low": 50,
                     "weekly_distance_km_high": 64, "key_session_types": ["长距离"]},
                    {"name": "速度周期", "phase_type": "speed",
                     "start_date": "2026-07-27", "end_date": "2026-09-06",
                     "focus": "f", "weekly_distance_km_low": 50,
                     "weekly_distance_km_high": 60, "key_session_types": ["间歇"]},
                ],
                "milestones": [
                    {"type": "body_composition", "date": "2026-07-26",
                     "phase_name": "基础期", "target": "基础期末体脂 ≤ 12%",
                     "metric": "body_fat_pct", "target_value": 12.0,
                     "comparator": "<="},
                    {"type": "test_run", "date": "2026-09-06",
                     "phase_name": "速度周期", "target": "5k sub-19",
                     "metric": "race_time_s_5k", "target_value": 1140,
                     "comparator": "<="},
                ],
            },
        }
        plan = _build_master_plan(data, "u", GOAL)
        by_metric = {m.metric: m for m in plan.milestones}

        bc = by_metric["body_fat_pct"]
        assert bc.type == MilestoneType.BODY_COMPOSITION
        assert bc.target_value == 12.0
        assert bc.comparator == "<="

        perf = by_metric["race_time_s_5k"]
        assert perf.type == MilestoneType.TEST_RUN
        assert perf.target_value == 1140.0
        assert perf.comparator == "<="

        # Each milestone is attached to the correct phase's milestone_ids.
        base_phase = next(p for p in plan.phases if p.name == "基础期")
        speed_phase = next(p for p in plan.phases if p.name == "速度周期")
        assert bc.id in base_phase.milestone_ids
        assert perf.id in speed_phase.milestone_ids

    def test_missing_new_fields_still_builds(self):
        from stride_server.master_plan_generator import _build_master_plan
        data = {"schema": "weekly-plan/master/v1", "plan": {
            "start_date": "2026-06-11", "end_date": "2026-10-18",
            "training_principles": ["p"],
            "phases": [{"name": "基础期", "start_date": "2026-06-11", "end_date": "2026-07-12",
                        "focus": "f", "weekly_distance_km_low": 50, "weekly_distance_km_high": 64,
                        "key_session_types": ["长距离"]}],
            "milestones": [{"type": "long_run", "date": "2026-06-28", "phase_name": "基础期",
                            "target": "22km"}]}}
        plan = _build_master_plan(data, "u", GOAL)
        assert plan.phases[0].phase_type is None
        assert plan.milestones[0].metric is None

    def test_unknown_phase_type_defaults_none(self):
        from stride_server.master_plan_generator import _build_master_plan
        data = {"schema": "weekly-plan/master/v1", "plan": {
            "start_date": "2026-06-11", "end_date": "2026-10-18", "training_principles": ["p"],
            "phases": [{"name": "x", "phase_type": "bogus_type",
                        "start_date": "2026-06-11", "end_date": "2026-07-12", "focus": "f",
                        "weekly_distance_km_low": 50, "weekly_distance_km_high": 64,
                        "key_session_types": []}],
            "milestones": []}}
        plan = _build_master_plan(data, "u", GOAL)
        assert plan.phases[0].phase_type is None


# ---------------------------------------------------------------------------
# Integration: run_generate_job
# ---------------------------------------------------------------------------


class TestRunGenerateJob:
    def test_valid_sentinel_json_produces_done_job(self, monkeypatch, patch_store, patch_history):
        """Layer 1: sentinel-anchored JSON → job DONE + plan saved."""
        raw_response = _sentinel_wrap(_VALID_JSON_STR)
        import stride_server.master_plan_generator as mod
        monkeypatch.setattr(adapter_mod, "LLMClient", _make_fake_llm(raw_response))

        job_id = create_job(USER_ID)
        _run_job_sync(job_id)

        job = get_job(job_id)
        assert job is not None
        assert job.status == JobStatus.DONE
        assert job.progress == 100
        assert job.result_plan_id is not None
        assert job.error is None

        assert len(patch_store.saved_plans) == 1
        saved = patch_store.saved_plans[0]
        assert saved.user_id == USER_ID
        assert saved.status == MasterPlanStatus.DRAFT
        assert saved.plan_id == job.result_plan_id

    def test_fenced_json_produces_done_job(self, monkeypatch, patch_store, patch_history):
        """Layer 2: fenced ```json block → job DONE."""
        raw_response = _fenced_wrap(_VALID_JSON_STR)
        import stride_server.master_plan_generator as mod
        monkeypatch.setattr(adapter_mod, "LLMClient", _make_fake_llm(raw_response))

        job_id = create_job(USER_ID)
        _run_job_sync(job_id)

        job = get_job(job_id)
        assert job.status == JobStatus.DONE

    def test_balanced_braces_produces_done_job(self, monkeypatch, patch_store, patch_history):
        """Layer 3: bare JSON (with preamble noise) → job DONE."""
        raw_response = "教练说：" + _VALID_JSON_STR
        import stride_server.master_plan_generator as mod
        monkeypatch.setattr(adapter_mod, "LLMClient", _make_fake_llm(raw_response))

        job_id = create_job(USER_ID)
        _run_job_sync(job_id)

        job = get_job(job_id)
        assert job.status == JobStatus.DONE

    def test_garbage_response_fails_with_parse_failed(self, monkeypatch, patch_store, patch_history):
        """Unparseable output (both attempts) → job FAILED + error='parse_failed'.

        Adapter does one retry on parse_failed (see master_plan_adapter for
        rationale — gpt-5.5 occasionally truncates). The fake client returns
        the same garbage for both calls, so both parses fail.
        """
        raw_response = "这是完全无法解析的输出！没有 JSON 也没有格式。"
        import stride_server.master_plan_generator as mod
        monkeypatch.setattr(adapter_mod, "LLMClient", _make_fake_llm(raw_response))

        job_id = create_job(USER_ID)
        _run_job_sync(job_id)

        job = get_job(job_id)
        assert job.status == JobStatus.FAILED
        assert job.error == "parse_failed"
        assert job.raw_output is not None
        assert len(job.raw_output) > 0
        assert len(patch_store.saved_plans) == 0

    def test_parse_failed_first_attempt_recovers_on_retry(
        self, monkeypatch, patch_store, patch_history
    ):
        """First LLM call returns garbage; retry returns valid JSON → job DONE.

        Pinpoints the adapter's 1-shot retry on parse_failed. Without retry
        we'd hit job.status=FAILED here, so this test guards against
        accidentally removing the resilience.
        """
        valid_response = _sentinel_wrap(_VALID_JSON_STR)
        garbage = "完全无法解析的输出，没有 JSON。"

        class FlakyLLMClient:
            calls = 0
            kwargs_seen: list[dict[str, Any]] = []

            def __init__(self) -> None:
                pass

            def chat_sync(self, *args: Any, **kwargs: Any) -> str:
                FlakyLLMClient.calls += 1
                FlakyLLMClient.kwargs_seen.append(kwargs)
                return garbage if FlakyLLMClient.calls == 1 else valid_response

        FlakyLLMClient.calls = 0  # reset per-test
        FlakyLLMClient.kwargs_seen = []
        monkeypatch.setattr(adapter_mod, "LLMClient", FlakyLLMClient)

        job_id = create_job(USER_ID)
        _run_job_sync(job_id)

        job = get_job(job_id)
        assert job.status == JobStatus.DONE, f"unexpected error: {job.error!r}"
        assert FlakyLLMClient.calls == 2, "retry should fire exactly once"
        assert FlakyLLMClient.kwargs_seen == [
            {"max_tokens": adapter_mod.MASTER_PLAN_MAX_TOKENS},
            {"max_tokens": adapter_mod.MASTER_PLAN_MAX_TOKENS},
        ]
        assert len(patch_store.saved_plans) == 1

    def test_llm_unavailable_fails_job(self, monkeypatch, patch_store, patch_history):
        """LLMUnavailable at construction → job FAILED + error='llm_unavailable'."""
        from stride_server.llm_client import LLMUnavailable

        class UnavailableLLMClient:
            def __init__(self) -> None:
                raise LLMUnavailable("AZURE_OPENAI_ENDPOINT not set")

        import stride_server.master_plan_generator as mod
        monkeypatch.setattr(adapter_mod, "LLMClient", UnavailableLLMClient)

        job_id = create_job(USER_ID)
        _run_job_sync(job_id)

        job = get_job(job_id)
        assert job.status == JobStatus.FAILED
        assert job.error == "llm_unavailable"

    def test_llm_error_retryable_fails_job(self, monkeypatch, patch_store, patch_history):
        """LLMError(retryable=True) → job FAILED + error contains llm_error."""
        from stride_server.llm_client import LLMError

        class RateLimitedLLMClient:
            def __init__(self) -> None:
                pass

            def chat_sync(self, *args: Any, **kwargs: Any) -> str:
                raise LLMError("rate limit exceeded", retryable=True)

        import stride_server.master_plan_generator as mod
        monkeypatch.setattr(adapter_mod, "LLMClient", RateLimitedLLMClient)

        job_id = create_job(USER_ID)
        _run_job_sync(job_id)

        job = get_job(job_id)
        assert job.status == JobStatus.FAILED
        assert job.error is not None
        assert "llm_error" in job.error
        assert "rate limit" in job.error

    def test_wrong_schema_fails_job(self, monkeypatch, patch_store, patch_history):
        """schema != 'weekly-plan/master/v1' → FAILED + error starts with 'bad_schema'."""
        bad_dict = dict(_VALID_PLAN_DICT)
        bad_dict["schema"] = "some-other/v2"
        raw_response = _sentinel_wrap(json.dumps(bad_dict))
        import stride_server.master_plan_generator as mod
        monkeypatch.setattr(adapter_mod, "LLMClient", _make_fake_llm(raw_response))

        job_id = create_job(USER_ID)
        _run_job_sync(job_id)

        job = get_job(job_id)
        assert job.status == JobStatus.FAILED
        assert job.error is not None
        assert job.error.startswith("bad_schema")
        assert len(patch_store.saved_plans) == 0

    def test_missing_phases_produces_plan_with_empty_phases(self, monkeypatch, patch_store, patch_history):
        """LLM omits phases list → plan saved with phases=[] (not a hard failure)."""
        data = {
            "schema": "weekly-plan/master/v1",
            "plan": {
                "start_date": "2026-05-12",
                "end_date": "2026-11-01",
                "training_principles": ["原则1"],
                # phases deliberately omitted — master_rule_filter
                # `phase_count_min` (>= 3) now blocks this before persist.
                "milestones": [],
            },
        }
        raw_response = _sentinel_wrap(json.dumps(data))
        import stride_server.master_plan_generator as mod  # noqa: F401
        monkeypatch.setattr(adapter_mod, "LLMClient", _make_fake_llm(raw_response))

        job_id = create_job(USER_ID)
        _run_job_sync(job_id)

        # Post-refactor: phase-less plans are blocked by master_rule_filter,
        # not silently persisted. Generator pipeline routes the verdict=block
        # outcome to `rule_filter_failed` so the failure is loud, not silent.
        job = get_job(job_id)
        assert job.status == JobStatus.FAILED
        assert job.error is not None
        assert job.error.startswith("rule_filter_failed")
        assert "phase_count_min" in job.error
        assert len(patch_store.saved_plans) == 0

    def test_job_stages_progress_through_all_stages(self, monkeypatch, patch_store, patch_history):
        """Verify that job progresses through all 4 stages in order."""
        raw_response = _sentinel_wrap(_VALID_JSON_STR)
        import stride_server.master_plan_generator as mod
        monkeypatch.setattr(adapter_mod, "LLMClient", _make_fake_llm(raw_response))

        stage_log: list[tuple[JobStage | None, int]] = []
        original_update_job = mod.update_job

        def spy_update_job(job_id: str, **kwargs: Any) -> None:
            original_update_job(job_id, **kwargs)
            stage = kwargs.get("stage")
            progress = kwargs.get("progress")
            if stage is not None or progress is not None:
                job = get_job(job_id)
                if job:
                    stage_log.append((job.stage, job.progress))

        monkeypatch.setattr(mod, "update_job", spy_update_job)
        # READING_HISTORY / EVALUATING / PLANNING_PHASES stage updates fire
        # from inside master_plan_adapter, which imported `update_job` from
        # `..job_runner` at module-load time. Patching only `mod.update_job`
        # misses those calls. Patch the adapter's binding too.
        monkeypatch.setattr(adapter_mod, "update_job", spy_update_job)

        job_id = create_job(USER_ID)
        _run_job_sync(job_id)

        stages_seen = [s for s, _ in stage_log if s is not None]
        assert JobStage.READING_HISTORY in stages_seen
        assert JobStage.EVALUATING in stages_seen
        assert JobStage.PLANNING_PHASES in stages_seen
        assert JobStage.OUTPUTTING in stages_seen

    def test_no_profile_still_succeeds(self, monkeypatch, patch_store, patch_history):
        """profile=None (user skipped C2) → still generates a plan."""
        raw_response = _sentinel_wrap(_VALID_JSON_STR)
        import stride_server.master_plan_generator as mod
        monkeypatch.setattr(adapter_mod, "LLMClient", _make_fake_llm(raw_response))

        job_id = create_job(USER_ID)
        run_generate_job(job_id, USER_ID, GOAL, None)  # profile=None

        job = get_job(job_id)
        assert job.status == JobStatus.DONE

    def test_unhandled_exception_in_job_fails_gracefully(self, monkeypatch, patch_store, patch_history):
        """Unexpected exception in _run_generate_job_inner → job FAILED, no crash."""
        import stride_server.master_plan_generator as mod

        def _exploding_history(_uid: str) -> dict:
            raise RuntimeError("unexpected database crash!")

        monkeypatch.setattr(mod, "_query_history", _exploding_history)
        # master_plan_adapter.load_master_context imports `_query_history`
        # at module-load time (`from ..master_plan_generator import _query_history`),
        # so patching `mod._query_history` alone doesn't rebind the adapter's
        # local name. Patch both so the exception actually fires during
        # generation rather than letting the adapter call the real DB
        # (which would then hit a real LLM further downstream).
        monkeypatch.setattr(adapter_mod, "_query_history", _exploding_history)

        job_id = create_job(USER_ID)
        # Must not raise
        run_generate_job(job_id, USER_ID, GOAL, PROFILE)

        job = get_job(job_id)
        assert job.status == JobStatus.FAILED
        assert "unexpected database crash" in (job.error or "")


# ---------------------------------------------------------------------------
# Prod input alias normalisation (codex round-2 P1 #1) — verifies that
# _normalize_for_prompt maps TrainingGoal field names to the canonical
# names the prompt + L1 rules read.
# ---------------------------------------------------------------------------


class TestNormalizeForPrompt:
    def test_race_distance_uppercase_mapped_to_canonical_lowercase(self):
        from stride_server.master_plan_generator import _normalize_for_prompt
        goal = {"race_distance": "FM"}
        norm_goal, _ = _normalize_for_prompt(goal, None)
        assert norm_goal["distance"] == "fm"

    def test_race_distance_trail_maps_to_ultra(self):
        from stride_server.master_plan_generator import _normalize_for_prompt
        goal = {"race_distance": "trail"}
        norm_goal, _ = _normalize_for_prompt(goal, None)
        assert norm_goal["distance"] == "ultra"

    def test_explicit_distance_not_clobbered(self):
        """Eval fixtures pass `distance` directly — must not be overwritten."""
        from stride_server.master_plan_generator import _normalize_for_prompt
        goal = {"distance": "hm", "race_distance": "FM"}
        norm_goal, _ = _normalize_for_prompt(goal, None)
        assert norm_goal["distance"] == "hm"

    def test_weekly_training_days_mapped_from_profile(self):
        from stride_server.master_plan_generator import _normalize_for_prompt
        _, norm_profile = _normalize_for_prompt({}, {"weekly_training_days": 5})
        assert norm_profile["weekly_run_days_max"] == 5

    def test_weekly_training_days_falls_back_to_goal(self):
        """TrainingGoal.weekly_training_days lives on the goal dict — also OK."""
        from stride_server.master_plan_generator import _normalize_for_prompt
        _, norm_profile = _normalize_for_prompt(
            {"weekly_training_days": 4}, {"some_other_field": "x"}
        )
        assert norm_profile["weekly_run_days_max"] == 4

    def test_explicit_weekly_run_days_max_not_clobbered(self):
        from stride_server.master_plan_generator import _normalize_for_prompt
        _, norm_profile = _normalize_for_prompt(
            {}, {"weekly_run_days_max": 3, "weekly_training_days": 6}
        )
        assert norm_profile["weekly_run_days_max"] == 3

    def test_inputs_not_mutated(self):
        from stride_server.master_plan_generator import _normalize_for_prompt
        goal = {"race_distance": "FM"}
        profile = {"weekly_training_days": 5}
        goal_before = dict(goal)
        profile_before = dict(profile)
        _normalize_for_prompt(goal, profile)
        assert goal == goal_before
        assert profile == profile_before

    def test_profile_none_with_goal_weekly_training_days_synthesises_profile(self):
        """When profile=None but goal carries weekly_training_days, the
        normaliser MUST synthesise a profile dict so the rfk extraction
        downstream picks it up. Without this, prod requests without an
        attached running_profile silently lose the frequency cap."""
        from stride_server.master_plan_generator import _normalize_for_prompt
        goal = {"weekly_training_days": 3}
        _, norm_profile = _normalize_for_prompt(goal, None)
        assert norm_profile is not None
        assert norm_profile["weekly_run_days_max"] == 3

    def test_profile_none_and_no_goal_field_returns_none(self):
        """No data anywhere → norm_profile stays None (don't fabricate)."""
        from stride_server.master_plan_generator import _normalize_for_prompt
        _, norm_profile = _normalize_for_prompt({}, None)
        assert norm_profile is None


# ---------------------------------------------------------------------------
# Prompt regression test (codex round-2 P2 #1) — pins the schema example +
# HARD blocks so silent prompt drift fails fast.
# ---------------------------------------------------------------------------


class TestPromptRegression:
    def _build(self) -> str:
        return _full_prompt(
            goal={"distance": "fm", "race_date": "2026-10-19", "goal_time_s": 12000},
            profile={"prs": {"fm_s": 13200}, "weekly_run_days_max": 5},
            history_summary="(test summary)",
            fitness_state={"summary": "(test fitness)"},
            today="2026-05-19",
        )

    def test_prompt_includes_canonical_weeks_schema(self):
        """LLM must see canonical `goal` and `weeks` fields in the example block."""
        prompt = self._build()
        assert '"goal"' in prompt
        assert '"target_time"' in prompt
        assert '"weeks"' in prompt
        assert '"weekly_key_sessions"' not in prompt
        # Must call out the canonical session-type tokens
        for t in ("long_run", "threshold", "race_pace"):
            assert t in prompt
        # Per-week structure
        for f in ("week_index", "week_start", "target_weekly_km_high",
                  "is_recovery_week", "is_taper_week"):
            assert f in prompt

    def test_prompt_requests_compact_canonical_week_output(self):
        prompt = self._build()
        assert "minified JSON" in prompt
        assert "canonical `weeks`" in prompt
        assert "compatibility aliases" in prompt
        assert "omit optional `intensity`" in prompt
        assert "omit optional `purpose`" in prompt
        assert "routine long_run/threshold/tempo/interval/vo2max/hill/strength" in prompt
        assert "keep it for MP/HMP/RP, A/B gate, injury" in prompt
        assert "altitude/heat, travel/holiday, fueling, recovery, or user-request meaning" in prompt
        assert "training_principles" in prompt
        assert "≤10" in prompt
        assert '"weekly_key_sessions"' not in prompt

    def test_prompt_preserves_non_droppable_requested_items(self):
        prompt = self._build()
        assert "Non-droppable requested items" in prompt
        assert "A/B/C" in prompt
        assert "weight/body-composition target" in prompt
        assert "hydration/electrolytes" in prompt
        assert "ferritin/iron-status" in prompt
        assert "ferritin or hemoglobin" in prompt
        assert "秋季后再筹备马拉松" in prompt
        assert "recover 1-2 weeks after the current race" in prompt
        assert "both a transition principle and the taper/race `coach_note`" in prompt

    def test_prompt_requires_strict_aggressive_a_goal_gates(self):
        prompt = self._build()
        assert "A gate" in prompt
        assert "Aggressive FM A gates are strict and target-specific" in prompt
        assert "target-specific" in prompt
        assert "22-24km" in prompt
        assert "not 28km" in prompt
        assert "multi-cycle" in prompt
        assert "observation/B only" in prompt
        assert "Slightly slower HM/10K marks are observation/B only" in prompt
        assert "30-32km MP rehearsal" in prompt
        assert "historical_peak * 1.10 + 2km" in prompt
        assert "historical_peak + 7km" in prompt
        assert "<=80-82km" in prompt
        assert "not `84-85km` or `92km`" in prompt
        assert "28-29km" in prompt
        assert "C=PB/no-regression finish" in prompt
        assert "HM <=1:18:00" in prompt
        assert "mid-cycle `test_run` A-gate milestone" in prompt
        assert "10K<=36:00" in prompt
        assert "next load max 70/71; not 72" in prompt
        assert "label it observation/B only" in prompt
        assert "Do not loosen the A gate to HM 1:18:30" in prompt
        assert "28 -> max 30" in prompt
        assert "peak `42km` needs first taper `<=31km`" in prompt
        assert "default peak phase `end_date` is about `race_date − 14 days`" in prompt
        assert "21 days only with an explicit freshness/travel/injury reason" in prompt
        assert "Even if `season_window.end_date` is race day" in prompt
        assert "base maintenance" in prompt
        assert "post-race repair nutrition principle" in prompt
        assert "72kg -> 68kg" in prompt
        assert "small deficit on easy/rest days" in prompt
        assert "no deficit" in prompt
        assert "protein 1.6-1.8 g/kg/day" in prompt
        assert "overrides Base" in prompt
        assert "calcium + vitamin D" in prompt
        assert "no 1.4-1.6" in prompt
        assert "do not merge build+peak into one `建设/峰值` nutrition line" in prompt
        assert "Race taper for HM" in prompt
        assert "do not use marathon-style 3-day 8-10 g/kg/day carb-loading" in prompt
        assert "10K tune-up around `<=39:00` is only a B/observation gate" in prompt
        assert "10K<=37:00" in prompt
        assert "observation/B+" in prompt
        assert "<=38:00" in prompt
        assert "target-equivalent HM/10K" in prompt or "目标等价HM/10K" in prompt
        assert "29-32km/22-24kmMP" in prompt
        assert "max legal 29-32km/22-24kmMP" in prompt
        assert "HM is only an observation gate" in prompt
        assert "Never summarize as just `HM+31km过关`" in prompt
        assert "2/14-2/16" in prompt
        assert "avoiding oily/high-fat/high-sugar banquet foods" in prompt
        assert "避开油腻/高脂/高糖宴席和新食物" in prompt
        assert "do not reduce the holiday note to only carrying gels" in prompt
        assert "本周期60-70km，下周期80km，再后周期90+km" in prompt
        assert "Tune-up/test weeks count as load" in prompt
        assert "74 -> recovery -> 89" in prompt
        assert "20-30% cut" in prompt
        assert "not 70-80% of phase lower bound" in prompt
        assert "phase's lower weekly-volume bound" not in prompt
        assert "previous load week before recovery" in prompt
        assert "75 -> 56-60 recovery -> 75-82" in prompt
        assert "recovery/taper do not reset budget" in prompt
        assert "75 -> 56-60" in prompt
        assert "not 82/89" in prompt
        assert "about 30-35km" in prompt
        assert "not <30 unless current load forces it" in prompt
        assert "single 28km max rehearsal week may reach `64-65km`" in prompt
        assert "do not create both a 64km and a 65km high week" in prompt
        assert "all other load weeks stay <=63km" in prompt
        assert "avoid unfamiliar steep routes" in prompt
        assert "no last-minute volume catch-up" in prompt
        assert "65-72km" in prompt
        assert "not 60-64 unless current-load/injury" in prompt
        assert "2/9-2/15" in prompt
        assert "no `long_run` key session" in prompt
        assert "short Z2 + short MP/strides" in prompt
        assert "gear+fuel packing" in prompt
        assert "shoes, race kit, gels/sodium, familiar breakfast" in prompt
        assert "only one" in prompt
        assert "28km / 72km" in prompt
        assert "avoid `26km`" in prompt
        assert "Stale race data still keeps FM >=28km" in prompt
        assert "`20-26km`" in prompt
        assert "set the milestone date to that Sunday" in prompt
        assert "Do not put big checkpoints on recovery weeks" in prompt
        assert "copy that week's exact `long_run.distance_km`" in prompt
        assert "week_start=2026-09-14" in prompt
        assert "never 2026-09-13" in prompt
        assert "no 86-92/32km unless explicit recent 85-90km history" in prompt
        assert "no `86-92km` peak or `32km` unless explicit recent 85-90km history" in prompt
        assert "never output `30/85`" in prompt
        assert "share-safe `29km / 84-85km` or `30km / >=86km`" in prompt
        assert "never `30/85` or `32/92`" in prompt
        assert "do not stop at `25km`" in prompt

    def test_prompt_includes_distance_specificity_block(self):
        """Distance specificity HARD block calls out FM / HM / 10K / 5K."""
        prompt = self._build()
        assert "Distance specificity" in prompt
        assert "FM (full marathon)" in prompt
        assert "HM (half marathon)" in prompt
        assert "10K" in prompt
        assert "5K" in prompt
        assert "default to <=55km for a normal sub-18 5K block" in prompt
        assert "default to `68-70km`" in prompt
        assert "avoid 71-75km" in prompt
        assert "Do not create a 4-week 5K peak" in prompt
        assert "never start taper the previous Monday (14d)" in prompt
        assert "17-18km only for explicit high-volume 10K" in prompt
        assert "Do not create a 4-week 10K peak phase" in prompt
        assert "Do not label a 4-week block as `peak`" in prompt
        assert "race weeks may contain only one `race`" in prompt
        assert "mention strides/activation only in `focus`" in prompt

    def test_master_system_prompt_stays_compact_after_distance_rules(self):
        from coach.skills import render_skill

        system = render_skill("master_plan_planner", {})

        assert len(system) < 34500
        assert "Distance specificity" in system
        assert "default to <=55km for a normal sub-18 5K block" in system
        assert "default to `68-70km`" in system
        assert "avoid 71-75km" in system

    def test_prompt_includes_ramp_integer_boundary_sentinels(self):
        prompt = self._build()

        assert "`64 -> 72`" in prompt
        assert "`64 -> max 70/71`" in prompt
        assert "(not 72)" in prompt
        assert "`70 -> 80`" in prompt
        assert "`70 -> max 77/78`" in prompt
        assert "(not 80)" in prompt
        assert "`72 -> 82`" in prompt
        assert "`72 -> max 79/80`" in prompt
        assert "(not 82)" in prompt
        assert "`80 -> 90`" in prompt
        assert "`80 -> max 88/89`" in prompt
        assert "(not 90)" in prompt

    def test_prompt_includes_long_run_share_integer_sentinels(self):
        prompt = self._build()

        assert "`22km` >=63" in prompt
        assert "never output `22/62`" in prompt

    def test_prompt_includes_frequency_limited_fm_peak_guidance(self):
        prompt = self._build()
        assert "Frequency-limited ceiling" in prompt
        assert "`profile.weekly_run_days_max <= 3`" in prompt
        assert "45-48km" in prompt
        assert "not a flat `40-42km` peak" in prompt
        assert "one protected max rehearsal" in prompt
        assert "26-28km / 45-48km" in prompt
        assert "exactly `28km / 48km`" in prompt
        assert "not 26/27" in prompt
        assert "many consecutive weeks where long-run share exceeds 50%" in prompt
        assert "5-6 run days plus at least one true rest/mobility day" in prompt
        assert "`零剂量<=2` alone is not enough" in prompt

    def test_prompt_includes_recent_s1_regression_sentinels(self):
        prompt = self._build()
        assert "normal sub-40/sub-39:30 defaults <=60km" in prompt
        assert "not 62-64" in prompt
        assert "training_principles` must explicitly ban deep squat" in prompt
        assert "lunge/弓步" in prompt
        assert "high box jump" in prompt
        assert "plyometrics/jump drills" in prompt
        assert "3:17 -> 3:10 is about 3.6%" in prompt
        assert "not 1.8%" in prompt
        assert "use `strength_key` only for rehab/test/phase anchors" in prompt
        assert "do not list routine maintenance strength every week" in prompt

    def test_prompt_includes_goal_realism_block(self):
        """Goal realism HARD block preserved across Batch B + D."""
        prompt = self._build()
        assert "Goal realism" in prompt or "目标现实性" in prompt

    def test_prompt_serialises_canonical_goal_keys(self):
        """`distance` (lowercase) — not `race_distance` — should appear in
        the serialised goal block. Catches a regression where the prompt
        consumes the raw prod field name."""
        prompt = self._build()
        # the JSON block in the prompt should carry our canonical keys
        assert '"distance":"fm"' in prompt
        assert '"goal_time_s":12000' in prompt


# ---------------------------------------------------------------------------
# Continuity signals injected into the system prompt (Task 5)
# ---------------------------------------------------------------------------


class TestPromptIncludesContinuity:
    def test_system_prompt_mentions_continuity_and_injuries(self):
        from coach.schemas import ContinuitySignals
        sig = ContinuitySignals(macro_cycle="summer", current_chronic_load=64.1,
                                post_race_recovery_status="recovered", injuries=["achilles"])
        prompt = _full_prompt(
            goal={"race_distance": "FM", "race_date": "2026-10-18"},
            profile=None, history_summary="hist", fitness_state={"summary": "CTL 64"},
            today="2026-06-10", continuity=sig,
        )
        assert "achilles" in prompt
        assert "summer" in prompt or "夏训" in prompt
        assert "recovered" in prompt or "已恢复" in prompt

    def test_partial_signals_no_raw_none_tokens(self):
        from coach.schemas import ContinuitySignals
        prompt = _full_prompt(
            goal={"race_distance": "FM", "race_date": "2026-10-18"},
            profile=None, history_summary="h", fitness_state={"summary": "s"},
            today="2026-06-10", continuity=ContinuitySignals(),
        )
        assert "None 天" not in prompt
        assert "None km" not in prompt
        assert "form 区: None" not in prompt


class TestPromptIncludesCurrentPhase:
    def test_entry_phase_block_present_and_authoritative(self):
        from coach.schemas import CurrentPhaseContext
        from stride_core.master_plan import PhaseType
        cp = CurrentPhaseContext(
            source="inferred",
            current_phase_type=PhaseType.SPEED,
            recommended_entry_phase=PhaseType.SPEED,
            completed_aerobic_weeks=8,
            confidence="high",
            rationale="基础已满 (8 周) + 近期质量课 → 进入 speed",
        )
        prompt = _full_prompt(
            goal={"race_distance": "FM", "race_date": "2026-10-18"},
            profile=None, history_summary="h", fitness_state={"summary": "s"},
            today="2026-06-16", current_phase=cp,
        )
        assert "Recommended start phase: speed" in prompt
        # Season-continuity: completed leading phases are now KEPT as
        # is_completed phases (not dropped), with continuous week numbering.
        assert "is_completed" in prompt
        assert "周期延续性" in prompt
        assert "8" in prompt  # completed aerobic weeks surfaced

    def test_no_block_when_entry_phase_unknown(self):
        from coach.schemas import CurrentPhaseContext
        prompt = _full_prompt(
            goal={"race_distance": "FM", "race_date": "2026-10-18"},
            profile=None, history_summary="h", fitness_state={"summary": "s"},
            today="2026-06-16", current_phase=CurrentPhaseContext(source="unknown"),
        )
        assert "Recommended start phase" not in prompt

    def test_explicit_season_start_disables_completed_lead_in_authorization(self):
        from coach.schemas import CurrentPhaseContext
        from stride_core.master_plan import PhaseType

        cp = CurrentPhaseContext(
            source="inferred",
            current_phase_type=PhaseType.BUILD,
            recommended_entry_phase=PhaseType.BUILD,
            completed_aerobic_weeks=12,
            confidence="high",
            rationale="season replay starts from a fixed May window",
        )

        prompt = _full_prompt(
            goal={
                "race_distance": "FM",
                "race_date": "2026-10-18",
                "season_start": "2026-05-04",
                "as_of_date": "2026-05-04",
            },
            profile=None,
            history_summary="h",
            fitness_state={"summary": "s"},
            today="2026-07-07",
            current_phase=cp,
        )

        assert "Recommended start phase: build" in prompt
        assert "Do NOT emit completed lead-in phases" in prompt
        assert "Keep completed lead-in phases" not in prompt
        assert "is_completed: true" not in prompt
        assert "`weeks[0].week_start` MUST equal `2026-05-04`" in prompt


class TestMacroCycleGuidance:
    def _prompt(self, mc):
        from coach.schemas import ContinuitySignals
        return _full_prompt(
            goal={"race_distance": "FM", "race_date": "2026-10-18"}, profile=None,
            history_summary="h", fitness_state={"summary": "s"}, today="2026-06-11",
            continuity=ContinuitySignals(macro_cycle=mc),
        )

    def test_summer_guidance(self):
        p = self._prompt("summer")
        assert "Summer-block periodization guidance" in p and "speed" in p.lower()

    def test_winter_guidance(self):
        p = self._prompt("winter")
        assert "Winter-block periodization guidance" in p and "aerobic" in p.lower()

    def test_unknown_no_macro_block(self):
        p = self._prompt("unknown")
        assert "Summer-block periodization guidance" not in p
        assert "Winter-block periodization guidance" not in p


# ---------------------------------------------------------------------------
# Prompt role discipline (refactor invariant): athlete data + per-call values
# live in the USER turn; the doctrine (persona + schema + rules) is the SYSTEM
# turn and carries no per-call value, so it is a stable, cacheable prefix.
# ---------------------------------------------------------------------------


class TestPromptRoleSplit:
    def _split(self):
        from coach.schemas import ContinuitySignals
        from stride_server.master_plan_generator import build_master_prompts
        return build_master_prompts(
            goal={"distance": "fm", "race_date": "2026-10-19", "goal_time_s": 12000},
            profile={"prs": {"fm_s": 13200}, "weekly_run_days_max": 5},
            history_summary="HIST_MARKER_42km",
            fitness_state={"summary": "FITNESS_MARKER CTL 60"},
            today="2026-05-19",
            continuity=ContinuitySignals(macro_cycle="summer", injuries=["achilles"]),
        )

    def test_system_is_static_doctrine_only(self):
        """System carries the rules/schema but NONE of this call's athlete data
        or computed dates — that is what makes it a byte-stable cache prefix."""
        system, _user = self._split()
        # doctrine present
        assert '"weeks"' in system
        assert "Distance specificity" in system
        # per-call / per-athlete data absent
        assert "HIST_MARKER_42km" not in system
        assert "FITNESS_MARKER" not in system
        assert "achilles" not in system
        assert "2026-10-19" not in system  # race_date
        assert '"goal_time_s"' not in system
        # no unrendered runtime placeholders leaked into the static prefix
        assert "${" not in system

    def test_system_is_call_invariant(self):
        """Two different athletes/goals must yield the identical system prompt."""
        from stride_server.master_plan_generator import build_master_prompts
        s1, _ = build_master_prompts(
            goal={"distance": "fm", "race_date": "2026-10-19"}, profile=None,
            history_summary="a", fitness_state={"summary": "x"}, today="2026-05-19",
        )
        s2, _ = build_master_prompts(
            goal={"distance": "hm", "race_date": "2027-03-01"}, profile={"prs": {"hm_s": 5400}},
            history_summary="totally different", fitness_state={"summary": "y"},
            today="2026-09-01",
        )
        assert s1 == s2

    def test_user_carries_athlete_data_and_dates(self):
        _system, user = self._split()
        assert "HIST_MARKER_42km" in user
        assert "FITNESS_MARKER" in user
        assert "achilles" in user
        assert "2026-10-19" in user  # race_date surfaced to the user turn
        # plan_start = upcoming Monday after 2026-05-19 (a Tuesday) → 2026-05-25
        assert "2026-05-25" in user

    def test_goal_season_start_freezes_plan_start_for_eval_replay(self):
        """S1 eval fixtures carry an explicit season_start. That start date,
        not the wall-clock today, must anchor plan_start so frozen fixtures stay
        reproducible and do not skip early base weeks as time passes."""
        from stride_server.master_plan_generator import build_master_prompts

        _system, user = build_master_prompts(
            goal={
                "distance": "fm",
                "race_date": "2026-10-18",
                "goal_time_s": 10200,
                "season_start": "2026-05-19",
            },
            profile={"prs": {"fm_s": 10762}, "weekly_run_days_max": 6},
            history_summary="hist",
            fitness_state={"summary": "fitness"},
            today="2026-06-30",
        )
        assert "Plan start Monday" in user
        assert "`plan.start_date` MUST equal `2026-05-25` verbatim" in user
        assert "`weeks[0].week_start` MUST equal `2026-05-25`" in user
        assert "do not skip early weeks" in user
        assert "2026-05-25" in user
        assert "2026-07-06" not in user

    def test_goal_as_of_date_freezes_today_for_eval_replay(self):
        """Frozen fixtures should not describe early fixture weeks as already
        completed just because the wall clock advanced."""
        from stride_server.master_plan_generator import build_master_prompts

        _system, user = build_master_prompts(
            goal={
                "distance": "fm",
                "race_date": "2026-10-18",
                "season_start": "2026-05-19",
                "as_of_date": "2026-05-19",
            },
            profile=None,
            history_summary="hist",
            fitness_state={"summary": "fitness"},
            today="2026-06-30",
        )
        assert "Today's date: 2026-05-19" in user
        assert "Today's date: 2026-06-30" not in user


# ---------------------------------------------------------------------------
# Per-phase quantifiable milestones grounded in baselines (Stage-3a P3)
# ---------------------------------------------------------------------------


class TestPromptPerPhaseMilestones:
    _BODY_COMP = {
        "scan_date": "2026-06-01", "weight_kg": 68.0, "body_fat_pct": 15.0,
        "smm_kg": 31.0, "fat_mass_kg": 10.2, "bmr_kcal": 1550, "bmi": 22.1,
    }
    _BODY_COMP_SUMMARY = "最新体测（2026-06-01）— 体重 68.0kg，体脂 15.0%，骨骼肌 31.0kg，BMI 22.1"

    def _build(self, *, body_composition=None, body_composition_summary=None):
        return _full_prompt(
            goal={"distance": "fm", "race_date": "2026-10-19", "goal_time_s": 12000},
            profile={"prs": {"fm_s": 13200, "best_5k_s": 1200}, "weekly_run_days_max": 5},
            history_summary="最好成绩：5k 20:00；FM 3:40",
            fitness_state={"summary": "CTL 60"},
            today="2026-05-19",
            body_composition=body_composition,
            body_composition_summary=body_composition_summary,
        )

    def test_body_comp_block_injected_when_present(self):
        prompt = self._build(
            body_composition=self._BODY_COMP,
            body_composition_summary=self._BODY_COMP_SUMMARY,
        )
        # Labeled baseline block present (distinct header, not the instruction text)
        assert "Body-composition baseline" in prompt
        # Concrete baseline numbers reach the prompt
        assert "68.0" in prompt
        assert "15.0" in prompt

    def test_body_comp_milestone_type_and_metrics_in_schema(self):
        prompt = self._build(
            body_composition=self._BODY_COMP,
            body_composition_summary=self._BODY_COMP_SUMMARY,
        )
        # New milestone type added to the schema enum
        assert "body_composition" in prompt
        # Body-comp metrics advertised to the LLM
        assert "weight_kg" in prompt
        assert "body_fat_pct" in prompt

    def test_per_phase_quantifiable_milestone_instruction(self):
        prompt = self._build(
            body_composition=self._BODY_COMP,
            body_composition_summary=self._BODY_COMP_SUMMARY,
        )
        # Stable anchor for the per-phase quantifiable-milestone instruction
        assert "Per-phase quantifiable milestone" in prompt
        # Improvement-rate guidance: speed phase 5k upper bound
        assert "race_time_s_5k" in prompt
        assert "5-8%" in prompt or "5–8%" in prompt
        # Performance milestone anchored to the actual-PB baseline line
        assert "actual personal best (PB)" in prompt

    def test_body_comp_block_omitted_when_none(self):
        prompt = self._build(body_composition=None, body_composition_summary=None)
        # No body-comp baseline block / numbers (header + baseline figures absent)
        assert "Body-composition baseline" not in prompt
        assert "68.0" not in prompt
        # But performance per-phase milestone instruction still present
        assert "Per-phase quantifiable milestone" in prompt
        assert "race_time_s_5k" in prompt

    def test_body_comp_fallback_used_when_summary_none(self):
        # Generator called directly (no pre-built adapter summary): the
        # _format_body_comp_fallback branch must still produce the baseline block.
        prompt = self._build(
            body_composition=self._BODY_COMP,
            body_composition_summary=None,
        )
        # Labeled baseline block present
        assert "Body-composition baseline" in prompt
        # Fallback formatter emitted its own summary line ("最新体测（...）")
        assert "最新体测" in prompt
        # Concrete weight number from _BODY_COMP reaches the prompt via the fallback
        assert "68.0" in prompt


# ---------------------------------------------------------------------------
# Real-DB regression tests for _query_history
# Locks the already-applied fix for:
#   1. sport_type filter uses RUN_SPORT_SQL_LIST (not the wrong literal "= 1")
#   2. distance_m is km-valued for magnitude < 500, meters for >= 500 —
#      normalised via CASE WHEN distance_m < 500 THEN distance_m ELSE distance_m / 1000.0 END
# ---------------------------------------------------------------------------


class TestQueryHistoryRealDB:
    def _seed(self, tmp_path):
        from stride_storage.sqlite.database import Database

        db = Database(db_path=tmp_path / "coros.db")
        c = db._conn
        # Running: COROS sport_type 100, distance in km (21.1 km)
        c.execute(
            "INSERT INTO activities (label_id, sport_type, date, distance_m, duration_s) "
            "VALUES ('a1', 100, '2026-05-01T08:00:00+00:00', 21.1, 5400)"
        )
        # Running: Garmin sport_type 8001, distance in km (10.0 km)
        c.execute(
            "INSERT INTO activities (label_id, sport_type, date, distance_m, duration_s) "
            "VALUES ('a2', 8001, '2026-05-08T08:00:00+00:00', 10.0, 2550)"
        )
        # Running: COROS sport_type 101, legacy meters row (15000 m → 15 km)
        c.execute(
            "INSERT INTO activities (label_id, sport_type, date, distance_m, duration_s) "
            "VALUES ('a3', 101, '2026-05-15T08:00:00+00:00', 15000, 4000)"
        )
        # Non-running: strength (sport_type 4) — must be excluded
        c.execute(
            "INSERT INTO activities (label_id, sport_type, date, distance_m, duration_s) "
            "VALUES ('a4', 4, '2026-05-16T08:00:00+00:00', 0, 1800)"
        )
        c.commit()
        return db

    def test_counts_running_across_sport_codes_excludes_strength(self, tmp_path, monkeypatch):
        """total_activities counts sport_type 100, 8001, 101 — excludes sport_type 4."""
        db = self._seed(tmp_path)
        monkeypatch.setattr("stride_storage.sqlite.database.Database", lambda **kw: db)
        result = _query_history("anyuser")
        assert result["total_activities"] == 3

    def test_distance_normalized_to_km(self, tmp_path, monkeypatch):
        """Monthly km for 2026-05: 21.1 + 10.0 + 15000→15.0 = 46.1 km;
        hours from duration_s: (5400 + 2550 + 4000) / 3600 = 3.32 h
        (strength row excluded)."""
        db = self._seed(tmp_path)
        monkeypatch.setattr("stride_storage.sqlite.database.Database", lambda **kw: db)
        result = _query_history("anyuser")
        may = next(m for m in result["monthly_km"] if m["month"] == "2026-05")
        assert abs(may["km"] - 46.1) < 0.2
        assert abs(may["hours"] - 3.32) < 0.05

    def test_query_history_does_not_load_or_self_heal_pbs(self, tmp_path, monkeypatch):
        """_query_history only loads training history. PB loading belongs to
        load_master_context/load_personal_bests so the PB source is explicit."""
        from stride_core.pb_records import fetch_personal_bests

        db = self._seed(tmp_path)
        monkeypatch.setattr("stride_storage.sqlite.database.Database", lambda **kw: db)
        assert fetch_personal_bests(db) == {}  # nothing persisted yet

        result = _query_history("anyuser")
        assert "best_10k_s" not in result
        assert "best_hm_s" not in result

        # _query_history must not trigger load_personal_bests self-heal.
        assert fetch_personal_bests(db) == {}


# ---------------------------------------------------------------------------
# _query_weekly_profile — 16-week cross-source weekly athlete profile
# ---------------------------------------------------------------------------


class TestWeeklyProfile:
    """Cross-source week alignment, Shanghai boundary, snapshot-vs-sum, and
    run-type classification for the 16-week weekly profile.

    The four source tables store ``date`` differently; all must collapse to the
    SAME Monday ``week_start`` for a given Shanghai calendar week.
    """

    def _db(self, tmp_path):
        from stride_storage.sqlite.database import Database
        return Database(db_path=tmp_path / "coros.db")

    def _add_run(self, c, label, date_iso, *, km, dur_s, avg_hr=None,
                 train_kind=None, name=None, sport_type=100):
        c.execute(
            "INSERT INTO activities (label_id, sport_type, date, distance_m, "
            "duration_s, avg_hr, train_kind, name) VALUES (?,?,?,?,?,?,?,?)",
            (label, sport_type, date_iso, km, dur_s, avg_hr, train_kind, name),
        )

    def _profile(self, db, **kw):
        from stride_server.master_plan_generator import _query_weekly_profile
        return _query_weekly_profile(db._conn, **kw)

    def test_cross_source_week_alignment(self, tmp_path):
        """An activity (UTC ISO), dtl (YYYY-MM-DD), health (YYYYMMDD), and hrv
        (YYYY-MM-DD) all in the same Shanghai week merge into ONE entry keyed by
        that week's Monday, with every metric populated."""
        db = self._db(tmp_path)
        c = db._conn
        # 2026-06-17 is a Wednesday → Monday of week = 2026-06-15.
        # Activity at 08:00 UTC on the 17th = 16:00 CST 17th → still 06-17.
        self._add_run(c, "a1", "2026-06-17T08:00:00+00:00", km=10.0, dur_s=3000,
                      avg_hr=150)
        c.execute("INSERT INTO daily_training_load (date, algorithm_version, "
                  "training_dose, acute_load, chronic_load, form) "
                  "VALUES ('2026-06-17', 1, 70, 65.0, 60.0, -5.0)")
        c.execute("INSERT INTO daily_health (date, rhr) VALUES ('20260617', 48)")
        c.execute("INSERT INTO daily_hrv (date, last_night_avg) "
                  "VALUES ('2026-06-17', 35)")
        c.commit()

        prof = self._profile(db)
        assert len(prof) == 1
        w = prof[0]
        assert w["week_start"] == "2026-06-15"  # Monday
        assert abs(w["distance_km"] - 10.0) < 1e-6
        assert abs(w["hours"] - (3000 / 3600.0)) < 1e-6
        assert abs(w["avg_hr"] - 150) < 1e-6
        assert w["ctl"] == 60.0
        assert w["atl"] == 65.0
        assert w["form"] == -5.0
        assert w["dose"] == 70
        assert w["rhr"] == 48
        assert w["hrv"] == 35
        assert w["n_runs"] == 1

    def test_shanghai_boundary_pushes_to_next_week(self, tmp_path):
        """A run finishing 23:30 UTC Sunday = 07:30 CST Monday → lands in the
        NEXT Shanghai week, not the UTC one."""
        db = self._db(tmp_path)
        c = db._conn
        # 2026-06-14 is a Sunday. 23:30 UTC → 2026-06-15 07:30 CST (Monday).
        self._add_run(c, "a1", "2026-06-14T23:30:00+00:00", km=8.0, dur_s=2400)
        c.commit()
        prof = self._profile(db)
        assert len(prof) == 1
        # Shanghai date is Monday 06-15 → its own week Monday is 06-15,
        # NOT the UTC-Sunday week (Monday 06-08).
        assert prof[0]["week_start"] == "2026-06-15"

    def test_ctl_atl_form_end_of_week_snapshot_dose_sum(self, tmp_path):
        """ctl/atl/form = value on the LATEST day in the week; dose = sum."""
        db = self._db(tmp_path)
        c = db._conn
        # Week of 2026-06-15 (Mon) .. 2026-06-21 (Sun).
        rows = [
            ("2026-06-15", 50, 40.0, 55.0, 15.0),
            ("2026-06-17", 60, 48.0, 56.0, 8.0),
            ("2026-06-20", 80, 70.0, 58.0, -12.0),  # latest day → snapshot
        ]
        for d, dose, atl, ctl, form in rows:
            c.execute("INSERT INTO daily_training_load (date, algorithm_version, "
                      "training_dose, acute_load, chronic_load, form) "
                      "VALUES (?, 1, ?, ?, ?, ?)", (d, dose, atl, ctl, form))
        c.commit()
        w = self._profile(db)[0]
        assert w["week_start"] == "2026-06-15"
        assert w["ctl"] == 58.0   # latest day snapshot, NOT summed
        assert w["atl"] == 70.0
        assert w["form"] == -12.0
        assert w["dose"] == 50 + 60 + 80  # additive

    def test_n_long_and_pace_and_hr_weighting(self, tmp_path):
        """n_long counts runs >= 20km (incl. legacy meters heuristic).
        avg_pace = total_s/total_km; avg_hr is duration-weighted."""
        db = self._db(tmp_path)
        c = db._conn
        # Same week (Mon 2026-06-15). Run1: 21.1km/5400s, HR 140.
        # Run2: legacy 15000m → 15km/4000s, HR 160. Run3: 5km/1500s, no HR.
        self._add_run(c, "a1", "2026-06-15T08:00:00+00:00", km=21.1, dur_s=5400,
                      avg_hr=140)
        self._add_run(c, "a2", "2026-06-16T08:00:00+00:00", km=15000, dur_s=4000,
                      avg_hr=160)
        self._add_run(c, "a3", "2026-06-17T08:00:00+00:00", km=5.0, dur_s=1500)
        c.commit()
        w = self._profile(db)[0]
        assert w["n_runs"] == 3
        assert w["n_long"] == 1  # only the 21.1km run >= 20
        total_km = 21.1 + 15.0 + 5.0
        total_s = 5400 + 4000 + 1500
        assert abs(w["avg_pace_s_km"] - total_s / total_km) < 1e-6
        # duration-weighted over the two runs WITH hr only.
        exp_hr = (140 * 5400 + 160 * 4000) / (5400 + 4000)
        assert abs(w["avg_hr"] - exp_hr) < 1e-6

    def test_n_speed_train_kind_and_pace_fallback(self, tmp_path):
        """Speed = explicit hard train_kind; for NULL train_kind, fall back to
        pace (run avg speed >= threshold). ``base`` is NOT speed."""
        db = self._db(tmp_path)
        c = db._conn
        # threshold_speed_mps = 4.0 m/s (= 250 s/km).
        # interval → speed. base → NOT speed. NULL + fast (5.0 m/s) → speed.
        # NULL + slow (3.0 m/s) → not speed.
        self._add_run(c, "i1", "2026-06-15T08:00:00+00:00", km=10.0, dur_s=2500,
                      train_kind="interval")
        self._add_run(c, "b1", "2026-06-16T08:00:00+00:00", km=10.0, dur_s=2500,
                      train_kind="base")
        # 10km in 2000s → 5.0 m/s ≥ 4.0 → speed (NULL train_kind)
        self._add_run(c, "f1", "2026-06-17T08:00:00+00:00", km=10.0, dur_s=2000)
        # 10km in 3334s → 3.0 m/s < 4.0 → not speed
        self._add_run(c, "s1", "2026-06-18T08:00:00+00:00", km=10.0, dur_s=3334)
        c.commit()
        w = self._profile(db, threshold_speed_mps=4.0)[0]
        assert w["n_runs"] == 4
        assert w["n_speed"] == 2  # interval + fast-NULL

        # Fallback disabled when threshold is None → only the explicit one.
        w2 = self._profile(db, threshold_speed_mps=None)[0]
        assert w2["n_speed"] == 1  # only 'interval'

    def test_race_name_heuristic(self, tmp_path):
        db = self._db(tmp_path)
        c = db._conn
        self._add_run(c, "r1", "2026-06-15T08:00:00+00:00", km=42.2, dur_s=12000,
                      name="上海马拉松")
        self._add_run(c, "r2", "2026-06-16T08:00:00+00:00", km=10.0, dur_s=2500,
                      name="Morning easy run")
        c.commit()
        w = self._profile(db)[0]
        assert w["n_race"] == 1

    def test_trims_to_most_recent_16_weeks(self, tmp_path):
        """More than 16 weeks present → only the 16 most recent, oldest-first."""
        db = self._db(tmp_path)
        c = db._conn
        # 20 distinct weeks, one run each (Mondays 2026-01-05 .. spaced 7d).
        from datetime import date as _date, timedelta as _td
        start = _date(2026, 1, 5)  # a Monday
        for i in range(20):
            d = start + _td(days=7 * i)
            iso = f"{d.isoformat()}T08:00:00+00:00"
            self._add_run(c, f"w{i}", iso, km=10.0, dur_s=3000)
        c.commit()
        prof = self._profile(db, weeks=16)
        assert len(prof) == 16
        # oldest-first; first kept = week index 4 (20 - 16).
        weeks_kept = [w["week_start"] for w in prof]
        assert weeks_kept == sorted(weeks_kept)
        assert weeks_kept[0] == (start + _td(days=7 * 4)).isoformat()
        assert weeks_kept[-1] == (start + _td(days=7 * 19)).isoformat()


# ---------------------------------------------------------------------------
# _query_fitness_state — reads STRIDE daily_training_load, not COROS ati/cti
# ---------------------------------------------------------------------------


class TestQueryFitnessStateStride:
    def test_reads_stride_load_not_coros(self, tmp_path, monkeypatch):
        from stride_storage.sqlite.database import Database
        db = Database(db_path=tmp_path / "coros.db")
        c = db._conn
        c.execute("INSERT INTO daily_health (date, ati, cti, fatigue, rhr) "
                  "VALUES ('20260610', 136, 120, 50, 48)")
        c.execute("INSERT INTO daily_hrv (date, last_night_avg, provider) "
                  "VALUES ('2026-06-10', 42, 'garmin')")
        c.execute("INSERT INTO daily_training_load (date, algorithm_version, training_dose, "
                  "acute_load, chronic_load, form) VALUES ('2026-06-10', 1, 70, 69.9, 64.1, -5.8)")
        c.commit()
        monkeypatch.setattr("stride_storage.sqlite.database.Database", lambda **kw: db)
        from stride_server import master_plan_generator as mod
        monkeypatch.setattr(mod, "_ensure_training_load_current", lambda db, as_of=None: None)
        state = mod._query_fitness_state("anyuser")
        assert state["ctl"] == 64.1      # chronic_load, NOT cti=120
        assert state["atl"] == 69.9      # acute_load, NOT ati=136
        assert state["rhr"] == 48        # no calibration -> fallback to raw daily_health
        assert state["hrv"] == 42        # latest preferred daily_hrv row
        assert state["hrv_date"] == "2026-06-10"
        assert "fatigue" not in state
        assert "training_load_state" not in state
        assert "64" in state["summary"]
        assert "HRV 42ms" in state["summary"]

    def test_prefers_calibration_rhr_baseline_over_raw(self, tmp_path, monkeypatch):
        from stride_storage.sqlite.database import Database
        from stride_storage.sqlite.calibration_connector import (
            SQLiteRunningCalibrationRepository,
        )
        db = Database(db_path=tmp_path / "coros.db")
        c = db._conn
        # raw last-measured rhr = 52, but the smoothed calibration baseline = 45.
        c.execute("INSERT INTO daily_health (date, ati, cti, fatigue, rhr) "
                  "VALUES ('20260610', 136, 120, 50, 52)")
        c.execute("INSERT INTO daily_training_load (date, algorithm_version, training_dose, "
                  "acute_load, chronic_load, form) VALUES ('2026-06-10', 1, 70, 69.9, 64.1, -5.8)")
        SQLiteRunningCalibrationRepository(db)  # bootstrap calibration tables
        c.execute(
            "INSERT INTO running_calibration_snapshot "
            "(as_of_date, algorithm_version, threshold_hr, threshold_speed_mps, "
            " threshold_hr_confidence, threshold_speed_confidence, rhr_baseline, "
            " observed_max_hr, hrmax_estimate, hrmax_confidence) "
            "VALUES ('2026-06-10', 1, 175.0, 4.65, 'medium', 'medium', 45.0, 188.0, 188.0, 'medium')"
        )
        c.commit()
        monkeypatch.setattr("stride_storage.sqlite.database.Database", lambda **kw: db)
        from stride_server import master_plan_generator as mod
        monkeypatch.setattr(mod, "_ensure_training_load_current", lambda db, as_of=None: None)
        state = mod._query_fitness_state("anyuser")
        assert state["rhr"] == 45.0      # calibration baseline preferred over raw 52


# ---------------------------------------------------------------------------
# load_master_context double baseline (Stage-3a P2)
# Performance baseline (real PBs via load_master_context/load_personal_bests) +
# body-composition baseline (body_composition_scan, added here). COROS
# race_predictions are deliberately NOT surfaced into the context. Graceful
# degrade when there's no body-comp scan.
# ---------------------------------------------------------------------------


class TestLoadMasterContextDoubleBaseline:
    def _seed_db(self, tmp_path, *, with_body_comp: bool):
        from stride_storage.sqlite.database import Database

        db = Database(db_path=tmp_path / "coros.db")
        c = db._conn
        # Seed COROS race_predictions to prove they are NOT surfaced into the
        # context: load_master_context anchors milestones to real PBs from
        # personal_bests, so these prediction rows must never leak into history.
        for race_type, dur in (
            ("5K", 1200.0),       # 20:00
            ("10K", 2520.0),      # 42:00
            ("Half Marathon", 5700.0),  # 1:35:00
            ("Marathon", 12000.0),      # 3:20:00
        ):
            c.execute(
                "INSERT INTO race_predictions (race_type, duration_s, avg_pace) "
                "VALUES (?, ?, NULL)",
                (race_type, dur),
            )
        for distance, pb_time_sec in (("10K", 2550.0), ("FM", 10762.0)):
            entry = {
                "distance": distance,
                "pb_time_sec": pb_time_sec,
                "achieved_at": "2026-05-08",
                "source": "activity",
            }
            c.execute(
                "INSERT INTO personal_bests "
                "(distance, pb_time_sec, achieved_at, source, entry_json) "
                "VALUES (?, ?, ?, ?, ?)",
                (distance, pb_time_sec, entry["achieved_at"], entry["source"], json.dumps(entry)),
            )
        if with_body_comp:
            c.execute(
                "INSERT INTO body_composition_scan "
                "(scan_date, weight_kg, body_fat_pct, smm_kg, fat_mass_kg, "
                " visceral_fat_level, bmr_kcal) "
                "VALUES ('2026-06-01', 70.0, 14.0, 33.0, 9.8, 6, 1600)"
            )
            # Older scan — latest_body_composition_scan must pick 2026-06-01.
            c.execute(
                "INSERT INTO body_composition_scan "
                "(scan_date, weight_kg, body_fat_pct, smm_kg, fat_mass_kg, "
                " visceral_fat_level, bmr_kcal) "
                "VALUES ('2026-01-01', 75.0, 18.0, 31.0, 13.5, 8, 1550)"
            )
        c.commit()
        return db

    def _patch_db_and_load(self, db, monkeypatch, *, profile):
        # All three readers (history, fitness, body-comp) open Database(user=...);
        # route every one at the single seeded handle.
        monkeypatch.setattr("stride_storage.sqlite.database.Database", lambda **kw: db)
        from stride_server import master_plan_generator as mod
        monkeypatch.setattr(mod, "_ensure_training_load_current", lambda db, as_of=None: None)
        # Keep continuity hermetic — not the subject under test here.
        monkeypatch.setattr(adapter_mod, "analyze_continuity", lambda *a, **k: None)
        state = {
            "user_id": USER_ID,
            "job_id": "",
            "input_payload": {"goal": GOAL, "profile": profile},
        }
        return adapter_mod.load_master_context(state)

    def test_both_baselines_present(self, tmp_path, monkeypatch):
        """Seeded body_composition_scan → context carries a body_composition
        block with weight/body_fat/smm + BMI (height from profile). Seeded COROS
        race_predictions must NOT leak into history — the planner anchors to real
        PBs only."""
        db = self._seed_db(tmp_path, with_body_comp=True)
        ctx = self._patch_db_and_load(
            db, monkeypatch, profile={"height_cm": 175.0}
        )

        # The graph context exposes only the rendered history summary. COROS
        # race_predictions are NOT surfaced; real PBs come from personal_bests,
        # not prediction rows.
        assert "history" not in ctx
        assert ctx["pb_seconds"] == {"10k": 2550.0, "fm": 10762.0}
        assert "Actual personal bests" in ctx["history_summary"]
        assert "10K: 42:30" in ctx["history_summary"]
        assert "FM: 2:59:22" in ctx["history_summary"]
        assert "3:20:00" not in ctx["history_summary"]

        # Body-composition baseline — latest scan (2026-06-01, not the older one).
        bc = ctx["body_composition"]
        assert bc is not None
        assert bc["scan_date"] == "2026-06-01"
        assert bc["weight_kg"] == 70.0
        assert bc["body_fat_pct"] == 14.0
        assert bc["smm_kg"] == 33.0
        # BMI = 70 / 1.75^2 = 22.86
        assert bc["bmi"] is not None
        assert abs(bc["bmi"] - 22.86) < 0.05

        # Human-visible prose line carries body-comp too.
        assert "body_composition_summary" in ctx
        assert "70" in ctx["body_composition_summary"]

    def test_bmi_none_when_no_height(self, tmp_path, monkeypatch):
        """No height in profile → body-comp block still present (weight/fat/smm)
        but bmi is None (don't fabricate a height)."""
        db = self._seed_db(tmp_path, with_body_comp=True)
        ctx = self._patch_db_and_load(db, monkeypatch, profile=None)

        bc = ctx["body_composition"]
        assert bc is not None
        assert bc["weight_kg"] == 70.0
        assert bc["bmi"] is None

    def test_graceful_degrade_no_body_comp(self, tmp_path, monkeypatch):
        """No body_composition_scan → load_master_context succeeds, body_composition
        is None, and the rendered history remains PB-only (predictions never
        surfaced)."""
        db = self._seed_db(tmp_path, with_body_comp=False)
        ctx = self._patch_db_and_load(
            db, monkeypatch, profile={"height_cm": 175.0}
        )

        # Degrades, never raises.
        assert ctx["body_composition"] is None
        # History summary present but carries no fitness-prediction baseline.
        assert "history" not in ctx
        assert ctx["pb_seconds"] == {"10k": 2550.0, "fm": 10762.0}
        assert "FM: 2:59:22" in ctx["history_summary"]
        assert "3:20:00" not in ctx["history_summary"]

    def test_bmi_math(self):
        """BMI helper on a known weight+height: 60kg @ 1.70m → 20.76."""
        from stride_server.coach_adapters.master_plan_adapter import _compute_bmi

        assert _compute_bmi(60.0, 170.0) == pytest.approx(20.76, abs=0.01)
        assert _compute_bmi(70.0, None) is None
        assert _compute_bmi(None, 175.0) is None
        assert _compute_bmi(70.0, 0) is None

    def test_goal_as_of_date_anchors_context_queries(self, monkeypatch):
        """Replay generation must use the frozen as_of_date for DB-derived
        context, not today's wall clock. Otherwise a May replay can leak July
        fitness/history into the prompt while only the visible date is frozen.
        """
        from datetime import date as date_cls

        seen: dict[str, object] = {}

        class _Db:
            pass

        def _history(uid, *, as_of=None):
            seen["history_as_of"] = as_of
            return {"total_activities": 0, "weekly_profile": []}

        def _fitness(uid, *, as_of=None):
            seen["fitness_as_of"] = as_of
            return {"summary": "fitness"}

        monkeypatch.setattr(adapter_mod, "_query_history", _history)
        monkeypatch.setattr(adapter_mod, "_query_fitness_state", _fitness)
        monkeypatch.setattr(adapter_mod, "_load_pb_seconds", lambda db: {})

        def _body(db, profile, *, as_of=None):
            seen["body_as_of"] = as_of
            return None

        monkeypatch.setattr(adapter_mod, "_load_body_composition", _body)
        monkeypatch.setattr(adapter_mod, "_format_body_composition_summary", lambda bc: "body")
        monkeypatch.setattr("stride_storage.sqlite.database.Database", lambda **kw: _Db())

        def _continuity(db, *, goal, profile, as_of):
            seen["continuity_as_of"] = as_of
            return None

        def _phase(db, *, user_id, goal, profile, as_of, continuity, cross_validate_with_llm):
            seen["phase_as_of"] = as_of
            return None

        monkeypatch.setattr(adapter_mod, "analyze_continuity", _continuity)
        monkeypatch.setattr(adapter_mod, "detect_current_phase", _phase)

        adapter_mod.load_master_context(
            {
                "user_id": USER_ID,
                "job_id": "",
                "input_payload": {
                    "goal": {**GOAL, "as_of_date": "2026-05-19"},
                    "profile": PROFILE,
                },
            }
        )

        frozen = date_cls(2026, 5, 19)
        assert seen["history_as_of"] == frozen
        assert seen["fitness_as_of"] == frozen
        assert seen["continuity_as_of"] == frozen
        assert seen["phase_as_of"] == frozen
        assert seen["body_as_of"] == frozen


# ---------------------------------------------------------------------------
# _format_history_summary — now renders the 16-week weekly profile block
# (the former monthly-volume / "Last 6 months" block was replaced).
# ---------------------------------------------------------------------------


class TestFormatHistorySummary:
    @staticmethod
    def _history(weekly_profile):
        return {
            "total_activities": 100,
            "max_weekly_km": 80.0,
            "monthly_km": [{"month": "2026-05", "km": 100.0, "hours": 10.0}],
            "weekly_profile": weekly_profile,
            "best_5k_s": 1170, "best_10k_s": 2405, "best_hm_s": None, "best_fm_s": None,
        }

    @staticmethod
    def _week(week_start, **over):
        base = {
            "week_start": week_start, "distance_km": 42.1, "hours": 3.8,
            "avg_pace_s_km": 321.0, "avg_hr": 148.0, "ctl": 58.0, "atl": 64.0,
            "training_load_ratio": 1.1034, "form": -6.0, "dose": 412.0,
            "rhr": 49.0, "hrv": 31.0,
            "n_runs": 5, "n_long": 1, "n_speed": 1, "n_race": 0,
        }
        base.update(over)
        return base

    def _summary(self, history):
        from stride_server import master_plan_generator as mod
        return mod._format_history_summary(history)

    def test_renders_weekly_block_not_monthly(self):
        out = self._summary(self._history([self._week("2026-02-23")]))
        # New compact 16-week block present; old monthly line gone.
        assert "16-week weekly profile (most recent last; n/a=no data)" in out
        assert "Last 6 months" not in out
        assert "Average monthly volume" not in out
        assert "W|km|h|pace|HR|CTL/ATL|ratio|form|dose|RHR/HRV|runs/L/S/R" in out
        assert "2026-W09|42.1|3.8|5:21/km|148|58/64|1.10|-6|412|49/31|5/1/1/0" in out
        assert "Totals (1wk):" in out
        # PB anchor line still rendered.
        assert "Actual personal bests (PB" in out

    def test_tolerates_none_metrics(self):
        wk = self._week(
            "2026-02-23", avg_pace_s_km=None, avg_hr=None, ctl=None, atl=None,
            training_load_ratio=None, form=None, dose=0.0, rhr=None, hrv=None,
            n_long=0, n_speed=0,
        )
        out = self._summary(self._history([wk]))
        # Missing metrics render as explicit n/a — no crash, no "None" leaked.
        assert "None" not in out
        assert "n/a" in out
        # dose 0.0 → "0" (a real zero, not missing); n_runs still shown.
        assert "2026-W09|42.1|3.8|n/a|n/a|n/a/n/a|n/a|n/a|0|n/a/n/a|5/0/0/0" in out

    def test_empty_profile_message(self):
        out = self._summary(self._history([]))
        assert "no recent weekly data" in out
        assert "Actual personal bests (PB" in out
