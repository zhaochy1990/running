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
        assert plan.goal.goal_id == GOAL_ID
        assert plan.status == MasterPlanStatus.DRAFT
        assert plan.version == 1
        assert plan.generated_by == "gpt-4.1"
        # 3 phases: 基础期 + 进展期 + 赛前期 (the 赛前期 added so the fixture
        # satisfies the new master_rule_filter; without it phase_count_min fails).
        assert len(plan.phases) == 3
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
        assert plan.goal_id == GOAL_ID
        assert plan.goal.race_name == "Shanghai Marathon"
        assert plan.goal.distance == "FM"
        assert plan.goal.race_date == "2026-11-01"
        assert plan.goal.target_time == "3:25:00"
        assert plan.goal.timezone == "Asia/Shanghai"
        assert plan.goal.location == "Shanghai"

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

    def test_goal_target_time_required_for_generated_plan(self):
        goal = {k: v for k, v in GOAL.items() if k != "target_finish_time"}
        with pytest.raises(ValueError, match="target_time"):
            _build_master_plan(_VALID_PLAN_DICT, USER_ID, goal)


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

            def __init__(self) -> None:
                pass

            def chat_sync(self, *args: Any, **kwargs: Any) -> str:
                FlakyLLMClient.calls += 1
                return garbage if FlakyLLMClient.calls == 1 else valid_response

        FlakyLLMClient.calls = 0  # reset per-test
        monkeypatch.setattr(adapter_mod, "LLMClient", FlakyLLMClient)

        job_id = create_job(USER_ID)
        _run_job_sync(job_id)

        job = get_job(job_id)
        assert job.status == JobStatus.DONE, f"unexpected error: {job.error!r}"
        assert FlakyLLMClient.calls == 2, "retry should fire exactly once"
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
        from stride_server.master_plan_generator import _build_system_prompt
        return _build_system_prompt(
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

    def test_prompt_includes_distance_specificity_block(self):
        """Distance specificity HARD block calls out FM / HM / 10K / 5K."""
        prompt = self._build()
        assert "Distance specificity" in prompt
        assert "FM (full marathon)" in prompt
        assert "HM (half marathon)" in prompt
        assert "10K" in prompt
        assert "5K" in prompt

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
        assert "\"distance\": \"fm\"" in prompt
        assert "\"goal_time_s\": 12000" in prompt
