"""Conversation state schema — see plan §6.1.

``ConversationState`` is the TypedDict consumed by ``langgraph.StateGraph``.
``history`` uses ``Annotated[..., add_messages]`` so each node can return a
list of new BaseMessages and langgraph will merge them via its reducer.

``Message`` is the public API shape returned by
``GET /api/users/me/coach/threads/{thread_id}/messages``; the adapter layer
translates langchain ``BaseMessage`` ↔ ``Message`` at the HTTP boundary.
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


class Message(BaseModel):
    """Public chat message representation for the HTTP API."""

    role: Role
    content: str
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
