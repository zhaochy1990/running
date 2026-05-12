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
from stride_server.master_plan_generator import (
    _build_master_plan,
    _parse_llm_output,
    run_generate_job,
)
from stride_core.master_plan import MasterPlan, MasterPlanStatus, MilestoneType

# ---------------------------------------------------------------------------
# Constants / helpers
# ---------------------------------------------------------------------------

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
        "best_5k_s": None,
        "best_10k_s": None,
        "best_hm_s": None,
        "best_fm_s": None,
    })
    monkeypatch.setattr(mod, "_query_fitness_state", lambda uid: {
        "ctl": None,
        "atl": None,
        "tsb": None,
        "fatigue": None,
        "rhr": None,
        "training_load_state": None,
        "summary": "体能数据暂无",
    })


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
        plan = _build_master_plan(_VALID_PLAN_DICT, USER_ID, GOAL_ID)
        assert plan.user_id == USER_ID
        assert plan.goal_id == GOAL_ID
        assert plan.status == MasterPlanStatus.DRAFT
        assert plan.version == 1
        assert plan.generated_by == "gpt-4.1"
        assert len(plan.phases) == 2
        assert len(plan.milestones) == 3
        assert len(plan.training_principles) == 3

    def test_milestone_types_parsed(self):
        plan = _build_master_plan(_VALID_PLAN_DICT, USER_ID, GOAL_ID)
        types = {m.type for m in plan.milestones}
        assert MilestoneType.LONG_RUN in types
        assert MilestoneType.TEST_RUN in types
        assert MilestoneType.RACE in types

    def test_phase_milestone_ids_populated(self):
        plan = _build_master_plan(_VALID_PLAN_DICT, USER_ID, GOAL_ID)
        # 基础期 should own 2 milestones (long_run + test_run)
        base_phase = next(p for p in plan.phases if p.name == "基础期")
        assert len(base_phase.milestone_ids) == 2

    def test_wrong_schema_raises(self):
        bad = dict(_VALID_PLAN_DICT)
        bad["schema"] = "wrong/v99"
        with pytest.raises(ValueError, match="unexpected schema"):
            _build_master_plan(bad, USER_ID, GOAL_ID)

    def test_missing_plan_key_raises(self):
        with pytest.raises(ValueError, match="missing or invalid 'plan'"):
            _build_master_plan({"schema": "weekly-plan/master/v1"}, USER_ID, GOAL_ID)

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
        plan = _build_master_plan(data, USER_ID, GOAL_ID)
        assert plan.phases == []
        assert plan.milestones == []

    def test_unknown_milestone_type_defaults_to_long_run(self):
        data = json.loads(_VALID_JSON_STR)
        data["plan"]["milestones"][0]["type"] = "unknown_type_xyz"
        plan = _build_master_plan(data, USER_ID, GOAL_ID)
        assert plan.milestones[0].type == MilestoneType.LONG_RUN


# ---------------------------------------------------------------------------
# Integration: run_generate_job
# ---------------------------------------------------------------------------


class TestRunGenerateJob:
    def test_valid_sentinel_json_produces_done_job(self, monkeypatch, patch_store, patch_history):
        """Layer 1: sentinel-anchored JSON → job DONE + plan saved."""
        raw_response = _sentinel_wrap(_VALID_JSON_STR)
        import stride_server.master_plan_generator as mod
        monkeypatch.setattr(mod, "LLMClient", _make_fake_llm(raw_response))

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
        monkeypatch.setattr(mod, "LLMClient", _make_fake_llm(raw_response))

        job_id = create_job(USER_ID)
        _run_job_sync(job_id)

        job = get_job(job_id)
        assert job.status == JobStatus.DONE

    def test_balanced_braces_produces_done_job(self, monkeypatch, patch_store, patch_history):
        """Layer 3: bare JSON (with preamble noise) → job DONE."""
        raw_response = "教练说：" + _VALID_JSON_STR
        import stride_server.master_plan_generator as mod
        monkeypatch.setattr(mod, "LLMClient", _make_fake_llm(raw_response))

        job_id = create_job(USER_ID)
        _run_job_sync(job_id)

        job = get_job(job_id)
        assert job.status == JobStatus.DONE

    def test_garbage_response_fails_with_parse_failed(self, monkeypatch, patch_store, patch_history):
        """Unparseable output → job FAILED + error='parse_failed' + raw_output set."""
        raw_response = "这是完全无法解析的输出！没有 JSON 也没有格式。"
        import stride_server.master_plan_generator as mod
        monkeypatch.setattr(mod, "LLMClient", _make_fake_llm(raw_response))

        job_id = create_job(USER_ID)
        _run_job_sync(job_id)

        job = get_job(job_id)
        assert job.status == JobStatus.FAILED
        assert job.error == "parse_failed"
        assert job.raw_output is not None
        assert len(job.raw_output) > 0
        assert len(patch_store.saved_plans) == 0

    def test_llm_unavailable_fails_job(self, monkeypatch, patch_store, patch_history):
        """LLMUnavailable at construction → job FAILED + error='llm_unavailable'."""
        from stride_server.llm_client import LLMUnavailable

        class UnavailableLLMClient:
            def __init__(self) -> None:
                raise LLMUnavailable("AZURE_OPENAI_ENDPOINT not set")

        import stride_server.master_plan_generator as mod
        monkeypatch.setattr(mod, "LLMClient", UnavailableLLMClient)

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
        monkeypatch.setattr(mod, "LLMClient", RateLimitedLLMClient)

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
        monkeypatch.setattr(mod, "LLMClient", _make_fake_llm(raw_response))

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
                # phases deliberately omitted
                "milestones": [],
            },
        }
        raw_response = _sentinel_wrap(json.dumps(data))
        import stride_server.master_plan_generator as mod
        monkeypatch.setattr(mod, "LLMClient", _make_fake_llm(raw_response))

        job_id = create_job(USER_ID)
        _run_job_sync(job_id)

        job = get_job(job_id)
        assert job.status == JobStatus.DONE
        assert len(patch_store.saved_plans) == 1
        saved = patch_store.saved_plans[0]
        assert saved.phases == []

    def test_job_stages_progress_through_all_stages(self, monkeypatch, patch_store, patch_history):
        """Verify that job progresses through all 4 stages in order."""
        raw_response = _sentinel_wrap(_VALID_JSON_STR)
        import stride_server.master_plan_generator as mod
        monkeypatch.setattr(mod, "LLMClient", _make_fake_llm(raw_response))

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
        monkeypatch.setattr(mod, "LLMClient", _make_fake_llm(raw_response))

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

        job_id = create_job(USER_ID)
        # Must not raise
        run_generate_job(job_id, USER_ID, GOAL, PROFILE)

        job = get_job(job_id)
        assert job.status == JobStatus.FAILED
        assert "unexpected database crash" in (job.error or "")
