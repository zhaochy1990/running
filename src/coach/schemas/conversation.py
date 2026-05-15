"""Conversation state schema — see plan §6.1.

``ConversationState`` is the TypedDict consumed by ``langgraph.StateGraph``.
``history`` uses ``Annotated[..., add_messages]`` so each node can return a
list of new BaseMessages and langgraph will merge them via its reducer.

``Message`` is the public API shape returned by
``GET /api/users/me/coach/threads/{thread_id}/messages``; the adapter layer
translates langchain ``BaseMessage`` ↔ ``Message`` at the HTTP boundary.

``AssistantPart`` + :func:`assistant_parts_from_message` is the canonical
way to turn an ``AIMessage`` into UI-renderable parts that handle both
``chat-completions`` (``content: str``) and ``Responses API``
(``content: list[dict]`` per OpenAI's ``ResponseOutputItem`` union).
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, TypedDict

from langchain_core.messages import BaseMessage
from langgraph.graph.message import add_messages
from pydantic import BaseModel, Field


Scope = Literal["master_chat", "week_chat", "qa"]
Role = Literal["system", "user", "assistant", "tool"]


class ToolCall(BaseModel):
    """One tool invocation emitted by the assistant turn."""

    id: str
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# AssistantPart — structured renderable parts for an assistant message
# ---------------------------------------------------------------------------


PartKind = Literal["text", "reasoning", "refusal", "tool_meta"]
TextPhase = Literal["commentary", "final_answer"]


class AssistantPart(BaseModel):
    """One renderable piece of an assistant turn.

    Mapping rules from the Responses-API content block ``type`` (see
    ``openai.types.responses.response_output_item.ResponseOutputItem`` and
    ``langchain_openai`` ``base.py`` `_construct_lc_result_from_responses_api`
    around line 4614):

    | Source block ``type``                              | ``AssistantPart.kind`` |
    |----------------------------------------------------|------------------------|
    | ``text`` (langchain rename of ``output_text``)     | ``text``               |
    | ``refusal``                                        | ``refusal``            |
    | ``reasoning``                                      | ``reasoning``          |
    | ``function_call`` / ``custom_tool_call``           | ``tool_meta``          |
    | ``file_search_call`` / ``web_search_call`` /       | ``tool_meta``          |
    | ``code_interpreter_call`` / ``mcp_call`` etc.      |                        |
    | ``compaction``                                     | *(hidden)*             |
    """

    kind: PartKind
    text: str
    # Only meaningful when ``kind=text``; reflects the source message's
    # ``phase`` field (``commentary`` = mid-turn narrative while tools run,
    # ``final_answer`` = the user-facing answer). ``None`` for chat-completions
    # output or non-text blocks.
    phase: TextPhase | None = None
    # Citations / file refs / url refs attached to the block (Responses API).
    annotations: list[dict] = Field(default_factory=list)
    # Original OpenAI block id (``msg_...`` / ``rs_...`` / ``call_...``).
    # Debug / audit only; clients shouldn't render this directly.
    id: str | None = None


class Message(BaseModel):
    """Public chat message representation for the HTTP API.

    For assistant turns, ``content`` is left empty and ``parts`` carries the
    structured renderable pieces. For user / tool turns, ``content`` is the
    raw text and ``parts`` stays empty.
    """

    role: Role
    content: str = ""
    parts: list[AssistantPart] = Field(default_factory=list)
    name: str | None = None
    tool_calls: list[ToolCall] = Field(default_factory=list)
    tool_call_id: str | None = None
    created_at: str | None = None


class ConversationState(TypedDict, total=False):
    """LangGraph state for the conversation graph (S1/S2/S3).

    Fields are ``total=False`` so individual nodes can return partial dicts
    that langgraph merges into the running state.
    """

    thread_id: str
    scope: Scope
    user_id: str
    folder: str | None
    plan_id: str | None
    history: Annotated[list[BaseMessage], add_messages]
    constraints: list[str]
    last_diff: dict | None
    iteration: int


# ---------------------------------------------------------------------------
# AssistantPart helper
# ---------------------------------------------------------------------------


_TOOL_META_LABELS: dict[str, str] = {
    "file_search_call": "搜索文件",
    "web_search_call": "搜索网络",
    "code_interpreter_call": "运行代码",
    "image_generation_call": "生成图像",
    "computer_call": "使用计算机",
    "tool_search_call": "搜索工具",
    "local_shell_call": "执行命令",
    "apply_patch_tool_call": "应用补丁",
    "function_shell_tool_call": "Shell 命令",
}
# ``output_item`` types echo prior tool results back into context; the model
# didn't *do* anything new — surfacing them as tool_meta would clutter the UI.
_TOOL_META_HIDDEN: set[str] = {
    "compaction",
    "function_call_output",
    "function_call_output_item",
    "custom_tool_call_output_item",
    "computer_call_output_item",
    "file_search_call_output",
    "function_shell_tool_call_output",
    "local_shell_call_output",
    "apply_patch_tool_call_output",
    "tool_search_output",
    "mcp_list_tools",
    "mcp_approval_request",
    "mcp_approval_response",
}


def _tool_meta_label(block_type: str, block: dict) -> str | None:
    """Short human-readable label for a tool-related content block.

    ``None`` means "hide this block from the UI" (output-item echoes,
    compaction events, etc.).
    """
    if block_type in _TOOL_META_HIDDEN:
        return None
    if block_type in ("function_call", "custom_tool_call"):
        name = block.get("name") or "(unnamed)"
        return f"调用 {name}"
    if block_type == "mcp_call":
        server = block.get("server_label") or ""
        tool = block.get("name") or ""
        return f"MCP: {server} / {tool}".strip(" /:")
    if block_type in _TOOL_META_LABELS:
        return _TOOL_META_LABELS[block_type]
    # Unknown but tool-call-like: surface the raw type so we notice during dev.
    return f"工具: {block_type}"


def _reasoning_text(block: dict) -> str:
    """Join the user-facing summary text out of a reasoning block.

    Prefers ``summary[].text`` (always present in the API spec); falls back to
    ``content[].text`` (only populated when ``include=reasoning.content`` was
    requested).
    """
    parts: list[str] = []
    for s in block.get("summary") or []:
        if isinstance(s, dict) and s.get("text"):
            parts.append(str(s["text"]))
    if not parts:
        for c in block.get("content") or []:
            if isinstance(c, dict) and c.get("text"):
                parts.append(str(c["text"]))
    return "\n\n".join(parts).strip()


def assistant_parts_from_message(message: BaseMessage) -> list[AssistantPart]:
    """Translate the LAST assistant message in a langgraph state into
    UI-renderable parts.

    Handles three shapes:

    1. ``chat-completions`` — ``content`` is a plain ``str`` → single text part.
    2. ``Responses API`` — ``content`` is a ``list[dict]`` of typed blocks
       per the Responses spec (text / refusal / reasoning / tool calls).
    3. Anything else / empty — returns ``[]``.
    """
    content = getattr(message, "content", "")

    if isinstance(content, str):
        text = content.strip()
        if not text:
            return []
        return [AssistantPart(kind="text", text=content)]

    if not isinstance(content, list):
        return [AssistantPart(kind="text", text=str(content))]

    parts: list[AssistantPart] = []
    for block in content:
        if isinstance(block, str):
            if block.strip():
                parts.append(AssistantPart(kind="text", text=block))
            continue
        if not isinstance(block, dict):
            continue

        bt = block.get("type")
        bid = block.get("id")

        if bt in ("text", "output_text"):
            txt = block.get("text") or ""
            if not txt:
                continue
            phase = block.get("phase")
            parts.append(
                AssistantPart(
                    kind="text",
                    text=str(txt),
                    phase=phase if phase in ("commentary", "final_answer") else None,
                    annotations=list(block.get("annotations") or []),
                    id=bid,
                )
            )
        elif bt == "refusal":
            parts.append(
                AssistantPart(
                    kind="refusal",
                    text=str(block.get("refusal") or ""),
                    id=bid,
                )
            )
        elif bt == "reasoning":
            txt = _reasoning_text(block)
            if txt:
                parts.append(AssistantPart(kind="reasoning", text=txt, id=bid))
        else:
            if not isinstance(bt, str):
                continue
            label = _tool_meta_label(bt, block)
            if label:
                parts.append(AssistantPart(kind="tool_meta", text=label, id=bid))

    return parts
