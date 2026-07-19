"""Orchestrator graph state + session helpers (§5.1, §5.4).

``OrchestratorState`` is the LangGraph state for the coach orchestrator. Session
memory (the message ``history``) is persisted by the checkpointer keyed on the
``{user}:coach:{session_id}`` thread; ``active_target`` is promoted across turns
for anaphora resolution (§5.4). Turn-scoped working memory (resolver output, call
plan, dispatched results) is computed inside the pipeline node and not persisted.
"""

from __future__ import annotations

from collections import deque
from operator import add
from typing import Annotated, Any, TypedDict

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage
from langgraph.graph.message import add_messages

from coach.contracts import Turn

# Default conversation window: ~16 turns covers a full propose→confirm→follow-up
# cycle (§5.2). Older turns fall to the rolling summary (S2+).
DEFAULT_WINDOW_TURNS = 16


class OrchestratorState(TypedDict, total=False):
    """LangGraph state for the coach orchestrator brain."""

    user_id: str
    session_id: str
    history: Annotated[list[BaseMessage], add_messages]
    active_target: dict[str, Any] | None  # serialised TargetRef, promoted across turns
    turn_response: dict[str, Any] | None   # serialised TurnResponse (this turn's output)
    injected_memories: list[str]           # ids of long-term memories injected this turn (§5.4)
    client_turn_id: str | None             # idempotency key for this turn (§ backend contract)
    request_target: dict[str, Any] | None  # target the client sent THIS turn (fingerprint input)
    turn_receipts: list[dict[str, Any]]    # bounded replay ledger, persisted across turns
    assistant_message: dict[str, Any] | None  # stable-identity assistant message for this turn
    events: Annotated[list[dict[str, Any]], add]  # trusted system receipts (applied/abandoned)


def coach_thread_id(user_id: str, session_id: str) -> str:
    """Session-threaded checkpointer key (§5.1): ``{user}:coach:{session_id}``."""
    if not session_id:
        raise ValueError("coach thread_id requires a session_id")
    return f"{user_id}:coach:{session_id}"


def last_human_text(history: list[BaseMessage]) -> str:
    """The most recent user utterance in the history (the current turn input)."""
    for message in reversed(history):
        if isinstance(message, HumanMessage):
            return str(message.content)
    return ""


def history_to_window(
    history: list[BaseMessage], *, limit: int = DEFAULT_WINDOW_TURNS
) -> list[Turn]:
    """Project message history into the filtered ``Turn`` window for specialists.

    Lossy by design (§3.2): only user/assistant text, never tool calls or
    reasoning blocks. Keeps the last ``limit`` turns in O(limit) space (the full
    session history can be long).
    """
    turns: deque[Turn] = deque(maxlen=limit)
    for message in history:
        if isinstance(message, HumanMessage):
            turns.append(Turn(role="user", content=str(message.content)))
        elif isinstance(message, AIMessage):
            text = _ai_text(message)
            if text:
                turns.append(Turn(role="assistant", content=text))
    return list(turns)


def _ai_text(message: AIMessage) -> str:
    """Best-effort plain text out of an AIMessage (str or Responses block list)."""
    content = message.content
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type") in ("text", "output_text"):
                parts.append(str(block.get("text") or ""))
        return "\n".join(p for p in parts if p).strip()
    return str(content).strip()
