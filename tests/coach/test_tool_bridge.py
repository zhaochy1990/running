"""Conversation tool binding surface tests."""

from __future__ import annotations

from coach.graphs.conversation.tool_bridge import (
    _TOOL_DESCRIPTIONS,
    _build_args_schema,
    tool_names_for_scope,
)
from stride_server.coach_adapters.tool_impls.read_impls import GetWeekPlanImpl


def test_health_series_tool_is_bound_in_all_conversation_scopes() -> None:
    for scope in ("qa", "week_chat", "master_chat"):
        names = tool_names_for_scope(scope)
        assert "get_health_series" in names
        assert "get_health_snapshot" in names
        assert "get_training_summary" in names


def test_coach_prompt_and_tools_enforce_vendor_metric_boundary() -> None:
    health_series = _TOOL_DESCRIPTIONS["get_health_series"]
    for metric in ("training_dose", "acute_load", "chronic_load", "form", "load_ratio"):
        assert metric in health_series
    for vendor_metric in ("fatigue,", "ati/cti", "training_load_ratio", "hrv_status"):
        assert vendor_metric not in health_series

    recent = _TOOL_DESCRIPTIONS["get_recent_activities"]
    assert "stride_training_load" in recent
    assert "never falls back" in recent
    snapshot = _TOOL_DESCRIPTIONS["get_health_snapshot"]
    assert "provenance" in snapshot
    assert "stride_training_load" in snapshot


def test_get_week_plan_is_a_no_argument_current_week_lookup() -> None:
    description = _TOOL_DESCRIPTIONS["get_week_plan"]
    schema = _build_args_schema("get_week_plan", GetWeekPlanImpl("user-1"))

    assert "folder" not in schema.model_fields
    assert "Takes no arguments" in description
    assert "WeeklyPlanStore" in description
    assert "当前周还没有训练计划，你要创建本周的训练计划吗？" in description
