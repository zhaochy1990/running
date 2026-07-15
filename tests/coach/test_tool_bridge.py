"""Conversation tool binding surface tests."""

from __future__ import annotations

from coach.graphs.conversation.tool_bridge import tool_names_for_scope


def test_health_series_tool_is_bound_in_all_conversation_scopes() -> None:
    for scope in ("qa", "week_chat", "master_chat"):
        names = tool_names_for_scope(scope)
        assert "get_health_series" in names
        assert "get_health_snapshot" in names
        assert "get_training_summary" in names
