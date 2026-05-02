"""Tests for Step 2 — LLM dual-output (md + JSON) + reverse parser.

The model is mocked end-to-end; we don't hit any real LLM.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

import pytest

from stride_core.db import Database
from stride_core.plan_spec import SessionKind, WeeklyPlan
from stride_server.coach_agent import agent as agent_mod
from stride_server.coach_agent.agent import (
    AgentResult,
    apply_weekly_plan,
    run_agent,
)


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures + helpers
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class FakeChatModel:
    """Minimal stand-in for a LangChain chat model. Captures the messages it
    sees so tests can assert on prompt construction."""

    response: str
    seen_messages: list[Any] | None = None

    def invoke(self, messages):
        self.seen_messages = list(messages)

        class _R:
            def __init__(self, content):
                self.content = content
        return _R(self.response)


def _patch_context(monkeypatch):
    """Stub out the heavy load_coach_context — we don't need real DB I/O for
    these tests, only the prompt + return shape."""
    monkeypatch.setattr(
        agent_mod, "load_coach_context",
        lambda user, **kw: {"sync": {"ok": True}, "stub": "ctx"},
    )
    monkeypatch.setattr(agent_mod, "summarize_context", lambda ctx: {"summary": "stub"})
    monkeypatch.setattr(agent_mod, "get_generated_by", lambda: "test-model")


def _valid_md_plus_json(week_folder: str = "2026-04-20_04-26(W0)") -> str:
    plan = {
        "schema": "weekly-plan/v1",
        "week_folder": week_folder,
        "sessions": [
            {
                "schema": "plan-session/v1",
                "date": "2026-04-22",
                "session_index": 0,
                "kind": "run",
                "summary": "Easy 10K",
                "spec": {
                    "schema": "run-workout/v1",
                    "name": "Easy 10K",
                    "date": "2026-04-22",
                    "note": None,
                    "blocks": [
                        {
                            "repeat": 1,
                            "steps": [
                                {
                                    "step_kind": "work",
                                    "duration": {"kind": "distance_m", "value": 10000},
                                    "target": {"kind": "pace_s_km", "low": 360, "high": 330},
                                    "note": None,
                                }
                            ],
                        }
                    ],
                },
                "notes_md": None,
                "total_distance_m": 10000.0,
                "total_duration_s": 3600.0,
                "scheduled_workout_id": None,
            },
            {
                "schema": "plan-session/v1",
                "date": "2026-04-21",
                "session_index": 0,
                "kind": "rest",
                "summary": "完全休息",
                "spec": None,
                "notes_md": None,
                "total_distance_m": None,
                "total_duration_s": None,
                "scheduled_workout_id": None,
            },
        ],
        "nutrition": [
            {
                "schema": "plan-nutrition/v1",
                "date": "2026-04-22",
                "kcal_target": 2400,
                "carbs_g": 300,
                "protein_g": 140,
                "fat_g": 80,
                "water_ml": 3000,
                "meals": [],
                "notes_md": None,
            }
        ],
        "notes_md": None,
    }
    return (
        "# Week W0\n\n## 周二 2026-04-22\n- Easy 10K\n\n"
        f"```json\n{json.dumps(plan, ensure_ascii=False)}\n```\n"
    )


# ─────────────────────────────────────────────────────────────────────────────
# weekly_plan task: dual-output happy + sad paths
# ─────────────────────────────────────────────────────────────────────────────


class TestWeeklyPlanDualOutput:
    def test_valid_md_plus_json_returns_structured(self, monkeypatch):
        _patch_context(monkeypatch)
        fake = FakeChatModel(response=_valid_md_plus_json())
        result = run_agent(
            "zhaochaoyi", task="weekly_plan", user_message="generate plan",
            folder="2026-04-20_04-26(W0)", chat_model=fake, sync_before=False,
        )
        assert isinstance(result, AgentResult)
        assert result.parse_error is None
        assert result.structured is not None
        assert isinstance(result.structured, WeeklyPlan)
        assert result.structured.week_folder == "2026-04-20_04-26(W0)"
        assert len(result.structured.sessions) == 2
        # Markdown should NOT contain the JSON code block — it was stripped.
        assert "```json" not in result.content
        assert "Week W0" in result.content

    def test_md_only_no_json_block_marks_parse_error(self, monkeypatch):
        _patch_context(monkeypatch)
        fake = FakeChatModel(response="# Week W0\n\n纯 markdown,没有 JSON 块")
        result = run_agent(
            "zhaochaoyi", task="weekly_plan", user_message="x",
            folder="2026-04-20_04-26(W0)", chat_model=fake, sync_before=False,
        )
        assert result.structured is None
        assert result.parse_error is not None
        assert "no JSON" in result.parse_error
        # content_md is still the model's markdown
        assert "纯 markdown" in result.content

    def test_invalid_json_marks_parse_error(self, monkeypatch):
        _patch_context(monkeypatch)
        fake = FakeChatModel(response="# Plan\n\n```json\n{not valid json,,,}\n```\n")
        result = run_agent(
            "zhaochaoyi", task="weekly_plan", user_message="x",
            folder="2026-04-20_04-26(W0)", chat_model=fake, sync_before=False,
        )
        assert result.structured is None
        assert result.parse_error is not None
        assert "invalid JSON" in result.parse_error

    def test_schema_mismatch_marks_parse_error(self, monkeypatch):
        _patch_context(monkeypatch)
        # Missing required `week_folder` key.
        bad = {"schema": "weekly-plan/v1", "sessions": [], "nutrition": []}
        fake = FakeChatModel(
            response=f"# Plan\n\n```json\n{json.dumps(bad)}\n```\n"
        )
        result = run_agent(
            "zhaochaoyi", task="weekly_plan", user_message="x",
            folder="2026-04-20_04-26(W0)", chat_model=fake, sync_before=False,
        )
        assert result.structured is None
        assert result.parse_error is not None
        assert "schema validation failed" in result.parse_error

    def test_weekly_plan_prompt_includes_schema_hint(self, monkeypatch):
        _patch_context(monkeypatch)
        fake = FakeChatModel(response=_valid_md_plus_json())
        run_agent(
            "zhaochaoyi", task="weekly_plan", user_message="x",
            folder="2026-04-20_04-26(W0)", chat_model=fake, sync_before=False,
        )
        # The user message should mention the schema and the run-workout/v1
        # discriminator the LLM is supposed to emit.
        joined = "\n".join(m[1] for m in fake.seen_messages)
        assert "weekly-plan/v1" in joined
        assert "run-workout/v1" in joined
        assert "RepeatGroup" in joined or "repeat" in joined


# ─────────────────────────────────────────────────────────────────────────────
# Nutrition macro consistency check
# ─────────────────────────────────────────────────────────────────────────────


class TestNutritionMacroValidation:
    def _plan_with_meal_kcals(self, meal_kcals, kcal_target=2400):
        meals = [
            {"name": f"M{i}", "time_hint": None, "kcal": k,
             "carbs_g": None, "protein_g": None, "fat_g": None, "items_md": None}
            for i, k in enumerate(meal_kcals)
        ]
        return {
            "schema": "weekly-plan/v1",
            "week_folder": "2026-04-20_04-26(W0)",
            "sessions": [],
            "nutrition": [
                {
                    "schema": "plan-nutrition/v1",
                    "date": "2026-04-22",
                    "kcal_target": kcal_target,
                    "carbs_g": None, "protein_g": None, "fat_g": None,
                    "water_ml": None,
                    "meals": meals,
                    "notes_md": None,
                }
            ],
            "notes_md": None,
        }

    def test_macros_within_10_percent_no_warning(self, monkeypatch):
        _patch_context(monkeypatch)
        # 2400 target, meals sum to 2350 = 2.1% off → no warning
        plan = self._plan_with_meal_kcals([600, 850, 900])
        fake = FakeChatModel(
            response=f"# md\n\n```json\n{json.dumps(plan)}\n```\n"
        )
        result = run_agent(
            "zhaochaoyi", task="weekly_plan", user_message="x",
            folder="2026-04-20_04-26(W0)", chat_model=fake, sync_before=False,
        )
        assert result.structured is not None
        assert result.structured.nutrition[0].notes_md is None

    def test_macros_off_by_more_than_10_percent_appends_warning(self, monkeypatch):
        _patch_context(monkeypatch)
        # 2400 target, meals sum to 1500 = 37% off → warning
        plan = self._plan_with_meal_kcals([400, 500, 600])
        fake = FakeChatModel(
            response=f"# md\n\n```json\n{json.dumps(plan)}\n```\n"
        )
        result = run_agent(
            "zhaochaoyi", task="weekly_plan", user_message="x",
            folder="2026-04-20_04-26(W0)", chat_model=fake, sync_before=False,
        )
        assert result.structured is not None
        notes = result.structured.nutrition[0].notes_md
        assert notes is not None
        assert "[parse_warning]" in notes
        assert "1500" in notes
        assert "2400" in notes
        # The row is NOT dropped — structured plan still valid.
        assert result.parse_error is None


# ─────────────────────────────────────────────────────────────────────────────
# parse_plan task (reverse parser)
# ─────────────────────────────────────────────────────────────────────────────


class TestParsePlanTask:
    def test_parse_plan_returns_structured(self, monkeypatch):
        # parse_plan does not load context — no need to patch it, but the
        # generated_by stub keeps the result deterministic.
        monkeypatch.setattr(agent_mod, "get_generated_by", lambda: "test-model")
        plan = {
            "schema": "weekly-plan/v1",
            "week_folder": "2026-04-20_04-26(W0)",
            "sessions": [
                {
                    "schema": "plan-session/v1",
                    "date": "2026-04-21", "session_index": 0,
                    "kind": "rest", "summary": "rest",
                    "spec": None, "notes_md": None,
                    "total_distance_m": None, "total_duration_s": None,
                    "scheduled_workout_id": None,
                }
            ],
            "nutrition": [],
            "notes_md": None,
        }
        # parse_plan's prompt asks JSON-only output, but the parser tolerates
        # extra surrounding text via the same fenced-block regex.
        fake = FakeChatModel(response=f"```json\n{json.dumps(plan)}\n```\n")
        result = run_agent(
            "zhaochaoyi", task="parse_plan", user_message="ignored",
            folder="2026-04-20_04-26(W0)", md_text="# some markdown",
            chat_model=fake, sync_before=False,
        )
        assert result.structured is not None
        assert result.structured.week_folder == "2026-04-20_04-26(W0)"
        assert result.parse_error is None
        # Context-related fields are empty for parse_plan.
        assert result.content == ""
        assert result.context_summary == {}

    def test_parse_plan_invalid_json_falls_back(self, monkeypatch):
        monkeypatch.setattr(agent_mod, "get_generated_by", lambda: "test-model")
        fake = FakeChatModel(response="```json\n{garbage}\n```")
        result = run_agent(
            "zhaochaoyi", task="parse_plan", user_message="x",
            folder="2026-04-20_04-26(W0)", md_text="# md",
            chat_model=fake, sync_before=False,
        )
        assert result.structured is None
        assert result.parse_error is not None

    def test_parse_plan_requires_md_and_folder(self, monkeypatch):
        monkeypatch.setattr(agent_mod, "get_generated_by", lambda: "test-model")
        with pytest.raises(ValueError, match="md_text"):
            run_agent("u", task="parse_plan", user_message="x",
                      folder="2026-04-20_04-26(W0)", md_text=None,
                      chat_model=FakeChatModel(response=""), sync_before=False)
        with pytest.raises(ValueError, match="folder"):
            run_agent("u", task="parse_plan", user_message="x",
                      folder=None, md_text="# md",
                      chat_model=FakeChatModel(response=""), sync_before=False)


# ─────────────────────────────────────────────────────────────────────────────
# apply_weekly_plan persistence
# ─────────────────────────────────────────────────────────────────────────────


class TestApplyWeeklyPlan:
    @pytest.fixture(autouse=True)
    def _patch_database_user_path(self, tmp_path, monkeypatch):
        """Redirect Database(user=...) to a tmp dir so we don't write to the
        real per-user folders in data/."""
        import stride_core.db as db_mod
        monkeypatch.setattr(db_mod, "USER_DATA_DIR", tmp_path)
        # apply_weekly_plan also calls get_generated_by()
        monkeypatch.setattr(agent_mod, "get_generated_by", lambda: "test-model")

    def test_apply_with_structured_writes_all_layers(self, tmp_path):
        wp = WeeklyPlan.from_dict(json.loads(_valid_md_plus_json().split("```json", 1)[1].split("```", 1)[0]))
        row = apply_weekly_plan(
            "zhaochaoyi", "2026-04-20_04-26(W0)", "# Plan markdown",
            structured=wp, generated_by="claude-opus-4-7",
        )
        assert row["week"] == "2026-04-20_04-26(W0)"
        assert row["generated_by"] == "claude-opus-4-7"
        # Confirm the structured layer landed.
        db = Database(user="zhaochaoyi")
        try:
            sessions = db.get_planned_sessions(week_folder="2026-04-20_04-26(W0)")
            nutrition = db.get_planned_nutrition(week_folder="2026-04-20_04-26(W0)")
            assert len(sessions) == 2
            assert len(nutrition) == 1
            wp_row = dict(db._conn.execute(
                "SELECT structured_status, parsed_from_md_hash FROM weekly_plan WHERE week=?",
                ("2026-04-20_04-26(W0)",),
            ).fetchone())
            assert wp_row["structured_status"] == "fresh"
            expected_hash = hashlib.sha256(b"# Plan markdown").hexdigest()
            assert wp_row["parsed_from_md_hash"] == expected_hash
        finally:
            db.close()

    def test_apply_without_structured_marks_parse_failed(self):
        row = apply_weekly_plan(
            "zhaochaoyi", "2026-04-20_04-26(W0)", "# Plan only",
            structured=None,
        )
        assert row["week"] == "2026-04-20_04-26(W0)"
        db = Database(user="zhaochaoyi")
        try:
            wp_row = dict(db._conn.execute(
                "SELECT structured_status FROM weekly_plan WHERE week=?",
                ("2026-04-20_04-26(W0)",),
            ).fetchone())
            assert wp_row["structured_status"] == "parse_failed"
            # No structured rows inserted.
            assert db.get_planned_sessions(week_folder="2026-04-20_04-26(W0)") == []
            assert db.get_planned_nutrition(week_folder="2026-04-20_04-26(W0)") == []
        finally:
            db.close()

    def test_apply_backfilled_source_records_status(self):
        wp = WeeklyPlan.from_dict(
            json.loads(_valid_md_plus_json().split("```json", 1)[1].split("```", 1)[0])
        )
        apply_weekly_plan(
            "zhaochaoyi", "2026-04-20_04-26(W0)", "# md",
            structured=wp, structured_source="backfilled",
        )
        db = Database(user="zhaochaoyi")
        try:
            wp_row = dict(db._conn.execute(
                "SELECT structured_status FROM weekly_plan WHERE week=?",
                ("2026-04-20_04-26(W0)",),
            ).fetchone())
            assert wp_row["structured_status"] == "backfilled"
        finally:
            db.close()

    def test_apply_replaces_prior_structured_rows(self):
        """A second apply with new structured content should not leave stale
        rows from the first call hanging around."""
        wp_v1 = WeeklyPlan.from_dict(
            json.loads(_valid_md_plus_json().split("```json", 1)[1].split("```", 1)[0])
        )
        apply_weekly_plan(
            "zhaochaoyi", "2026-04-20_04-26(W0)", "# md v1", structured=wp_v1,
        )
        # New plan with only one rest session (no run, no nutrition rows)
        plan_v2 = {
            "schema": "weekly-plan/v1",
            "week_folder": "2026-04-20_04-26(W0)",
            "sessions": [
                {
                    "schema": "plan-session/v1",
                    "date": "2026-04-22", "session_index": 0,
                    "kind": "rest", "summary": "完全休息",
                    "spec": None, "notes_md": None,
                    "total_distance_m": None, "total_duration_s": None,
                    "scheduled_workout_id": None,
                }
            ],
            "nutrition": [],
            "notes_md": None,
        }
        wp_v2 = WeeklyPlan.from_dict(plan_v2)
        apply_weekly_plan(
            "zhaochaoyi", "2026-04-20_04-26(W0)", "# md v2", structured=wp_v2,
        )
        db = Database(user="zhaochaoyi")
        try:
            sessions = db.get_planned_sessions(week_folder="2026-04-20_04-26(W0)")
            nutrition = db.get_planned_nutrition(week_folder="2026-04-20_04-26(W0)")
            assert len(sessions) == 1
            assert sessions[0]["kind"] == "rest"
            assert len(nutrition) == 0
        finally:
            db.close()


# ─────────────────────────────────────────────────────────────────────────────
# Backwards compat: existing chat / plan_adjustment paths unchanged
# ─────────────────────────────────────────────────────────────────────────────


class TestBackwardsCompat:
    def test_chat_task_returns_plain_content(self, monkeypatch):
        _patch_context(monkeypatch)
        fake = FakeChatModel(response="just a plain answer")
        result = run_agent(
            "u", task="chat", user_message="how am I?",
            chat_model=fake, sync_before=False,
        )
        assert result.content == "just a plain answer"
        assert result.structured is None
        assert result.parse_error is None

    def test_plan_adjustment_does_not_strip_or_parse_json(self, monkeypatch):
        _patch_context(monkeypatch)
        # Even if the model emits a json block here, plan_adjustment leaves it
        # in content_md and does not attempt structured parsing.
        fake = FakeChatModel(response="# adj\n\n```json\n{}\n```\n")
        result = run_agent(
            "u", task="plan_adjustment", user_message="lower load",
            folder="2026-04-20_04-26(W0)", chat_model=fake, sync_before=False,
        )
        assert "```json" in result.content
        assert result.structured is None
        assert result.parse_error is None

    def test_content_md_property_alias(self, monkeypatch):
        _patch_context(monkeypatch)
        fake = FakeChatModel(response="hi")
        result = run_agent(
            "u", task="chat", user_message="x",
            chat_model=fake, sync_before=False,
        )
        assert result.content_md == result.content == "hi"
