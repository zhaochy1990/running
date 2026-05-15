"""Focused tests for AssistantPart + assistant_parts_from_message.

The Responses-API content shape is the messy one — these tests pin the
per-block-type mapping so future regressions surface here, not at the
HTTP boundary."""

from __future__ import annotations

from langchain_core.messages import AIMessage

from coach.schemas.conversation import (
    AssistantPart,
    assistant_parts_from_message,
)


# ---------------------------------------------------------------------------
# chat-completions degradation: content is a plain string
# ---------------------------------------------------------------------------


def test_chat_completions_str_content_single_text_part():
    parts = assistant_parts_from_message(AIMessage(content="你状态不错。"))
    assert len(parts) == 1
    p = parts[0]
    assert p.kind == "text"
    assert p.text == "你状态不错。"
    assert p.phase is None
    assert p.annotations == []
    assert p.id is None


def test_empty_str_content_returns_no_parts():
    assert assistant_parts_from_message(AIMessage(content="")) == []
    assert assistant_parts_from_message(AIMessage(content="   \n")) == []


# ---------------------------------------------------------------------------
# Responses API: typed content blocks
# ---------------------------------------------------------------------------


def test_responses_text_block_preserves_phase_and_annotations():
    msg = AIMessage(content=[
        {
            "type": "text",
            "text": "你最近 TSB -38, 偏疲劳。",
            "phase": "final_answer",
            "annotations": [{"type": "url_citation", "url": "https://example/"}],
            "id": "msg_001",
        }
    ])
    [p] = assistant_parts_from_message(msg)
    assert p.kind == "text"
    assert p.phase == "final_answer"
    assert p.text == "你最近 TSB -38, 偏疲劳。"
    assert p.id == "msg_001"
    assert p.annotations[0]["url"] == "https://example/"


def test_responses_commentary_phase_preserved():
    msg = AIMessage(content=[
        {"type": "text", "text": "让我先查一下数据。", "phase": "commentary", "id": "msg_x"}
    ])
    [p] = assistant_parts_from_message(msg)
    assert p.phase == "commentary"


def test_responses_text_block_without_phase_returns_phase_none():
    """When the upstream block has no phase field (e.g. older model output),
    AssistantPart.phase is None, not 'final_answer' (no fabricated values)."""
    msg = AIMessage(content=[{"type": "text", "text": "hi", "id": "msg_x"}])
    [p] = assistant_parts_from_message(msg)
    assert p.phase is None


def test_responses_refusal_block():
    msg = AIMessage(content=[
        {"type": "refusal", "refusal": "Cannot help with that.", "id": "msg_x"}
    ])
    [p] = assistant_parts_from_message(msg)
    assert p.kind == "refusal"
    assert p.text == "Cannot help with that."


def test_responses_reasoning_block_joins_summary_text():
    msg = AIMessage(content=[
        {
            "type": "reasoning",
            "id": "rs_001",
            "summary": [
                {"type": "summary_text", "text": "用户问疲劳。"},
                {"type": "summary_text", "text": "需要先取数据。"},
            ],
        }
    ])
    [p] = assistant_parts_from_message(msg)
    assert p.kind == "reasoning"
    assert p.id == "rs_001"
    assert p.text == "用户问疲劳。\n\n需要先取数据。"


def test_responses_reasoning_block_falls_back_to_content_text():
    """When include=reasoning.content is set, OpenAI populates content[].text
    instead of (or in addition to) summary[].text. The helper falls back to
    content[] only when summary[] is empty."""
    msg = AIMessage(content=[
        {
            "type": "reasoning",
            "id": "rs_002",
            "summary": [],
            "content": [{"type": "reasoning_text", "text": "raw step-by-step thinking"}],
        }
    ])
    [p] = assistant_parts_from_message(msg)
    assert p.text == "raw step-by-step thinking"


def test_responses_function_call_becomes_tool_meta():
    msg = AIMessage(content=[
        {
            "type": "function_call",
            "id": "call_001",
            "call_id": "call_001",
            "name": "get_health_snapshot",
            "arguments": "{}",
        }
    ])
    [p] = assistant_parts_from_message(msg)
    assert p.kind == "tool_meta"
    assert "get_health_snapshot" in p.text


def test_responses_builtin_tool_calls_become_tool_meta():
    cases = [
        ("file_search_call", "搜索文件"),
        ("web_search_call", "搜索网络"),
        ("code_interpreter_call", "运行代码"),
        ("image_generation_call", "生成图像"),
        ("computer_call", "使用计算机"),
    ]
    for block_type, expected_label in cases:
        msg = AIMessage(content=[{"type": block_type, "id": f"call_{block_type}"}])
        [p] = assistant_parts_from_message(msg)
        assert p.kind == "tool_meta"
        assert p.text == expected_label, f"{block_type} → {p.text!r}"


def test_responses_hidden_block_types_are_skipped():
    """compaction events + tool-output echoes should NOT clutter the UI."""
    for hidden_type in (
        "compaction",
        "function_call_output_item",
        "custom_tool_call_output_item",
        "computer_call_output_item",
        "function_shell_tool_call_output",
        "local_shell_call_output",
        "mcp_list_tools",
        "mcp_approval_request",
    ):
        msg = AIMessage(content=[{"type": hidden_type, "id": "x"}])
        assert assistant_parts_from_message(msg) == [], f"{hidden_type} leaked"


def test_responses_unknown_tool_type_surfaces_with_raw_label():
    """An unrecognised tool-like type still surfaces (so we notice during
    integration with a new model), just with a generic '工具: <type>' label."""
    msg = AIMessage(content=[{"type": "future_unseen_tool_call", "id": "x"}])
    [p] = assistant_parts_from_message(msg)
    assert p.kind == "tool_meta"
    assert "future_unseen_tool_call" in p.text


def test_responses_full_multi_block_response_preserves_order():
    """End-to-end: reasoning → commentary → tool → final, in that order."""
    msg = AIMessage(content=[
        {"type": "reasoning", "id": "rs", "summary": [{"type": "summary_text", "text": "think"}]},
        {"type": "text", "text": "Let me check.", "phase": "commentary", "id": "msg_1"},
        {"type": "function_call", "id": "call", "name": "x", "arguments": "{}"},
        {"type": "text", "text": "Done.", "phase": "final_answer", "id": "msg_2"},
    ])
    parts = assistant_parts_from_message(msg)
    assert [p.kind for p in parts] == ["reasoning", "text", "tool_meta", "text"]
    assert parts[1].phase == "commentary"
    assert parts[3].phase == "final_answer"


def test_empty_text_blocks_dropped():
    """A text block with empty text shouldn't produce an empty AssistantPart."""
    msg = AIMessage(content=[
        {"type": "text", "text": "", "phase": "final_answer", "id": "msg_x"}
    ])
    assert assistant_parts_from_message(msg) == []


def test_assistant_part_pydantic_round_trips():
    """Round-trip via model_dump for HTTP serialisation."""
    p = AssistantPart(kind="text", text="hi", phase="final_answer", id="msg_1")
    dumped = p.model_dump()
    assert dumped["kind"] == "text"
    assert dumped["phase"] == "final_answer"
    assert dumped["annotations"] == []
    rt = AssistantPart.model_validate(dumped)
    assert rt == p
