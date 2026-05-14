"""``build_conversation_graph`` — the S1/S2/S3 conversation StateGraph.

Flow (see plan §6.2)::

                ┌───────────┐
        START → │  reason   │  ←──────────┐
                └───┬───────┘             │
            tool_calls? │                 │
                ┌───────┴───────┐         │
                │     no        │  yes    │
                ▼               ▼         │
              END            ┌──────┐     │
                             │tools │     │
                             └──┬───┘     │
                                │         │
                  draft tool? ──┴── read tool? ─┘
                       │
                       ▼
                      END (last_diff set)

Persistence: a ``BaseCheckpointSaver`` (typically our
:class:`AzureTableCheckpointSaver`) is wired via ``compile(checkpointer=...)``
so each thread can resume mid-multi-turn.
"""

from __future__ import annotations

import json
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, SystemMessage, ToolMessage
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph

from coach.runtime.toolkit import Toolkit
from coach.schemas import ConversationState

from .prompts.master_chat import MASTER_CHAT_PROMPT
from .prompts.qa import QA_PROMPT
from .prompts.week_chat import WEEK_CHAT_PROMPT
from .tool_bridge import build_langchain_tools, is_draft_tool


_SCOPE_PROMPTS = {
    "qa": QA_PROMPT,
    "week_chat": WEEK_CHAT_PROMPT,
    "master_chat": MASTER_CHAT_PROMPT,
}


def build_conversation_graph(
    *,
    toolkit: Toolkit,
    llm: BaseChatModel,
    checkpointer: BaseCheckpointSaver | None,
    scope: str,
) -> Any:
    """Construct a compiled langgraph for the given scope.

    Returns the compiled graph (langgraph ``CompiledStateGraph``); call
    ``.invoke({"history": [HumanMessage(...)], "scope": scope, ...},
    config={"configurable": {"thread_id": ...}})``.
    """
    if scope not in _SCOPE_PROMPTS:
        raise ValueError(f"unknown scope {scope!r}")

    tools = build_langchain_tools(toolkit, scope)
    llm_with_tools = llm.bind_tools(tools)
    tool_map: dict[str, Any] = {t.name: t for t in tools}

    system_prompt = _SCOPE_PROMPTS[scope]

    def reason(state: ConversationState) -> dict[str, Any]:
        msgs = [SystemMessage(content=system_prompt), *state.get("history", [])]
        resp = llm_with_tools.invoke(msgs)
        return {"history": [resp], "iteration": state.get("iteration", 0) + 1}

    def tools_node(state: ConversationState) -> dict[str, Any]:
        history = state.get("history", [])
        last = history[-1] if history else None
        tool_calls = getattr(last, "tool_calls", None) or []
        new_messages: list[Any] = []
        last_diff: dict | None = None
        for tc in tool_calls:
            name = tc["name"]
            args = tc.get("args") or {}
            impl = tool_map.get(name)
            if impl is None:
                new_messages.append(
                    ToolMessage(
                        content=json.dumps({"ok": False, "errors": [f"unknown tool {name}"]}),
                        tool_call_id=tc["id"],
                        name=name,
                    )
                )
                continue
            try:
                payload = impl.invoke(args)
            except Exception as exc:  # noqa: BLE001 — tool boundary
                payload = json.dumps({"ok": False, "errors": [f"{type(exc).__name__}: {exc}"]})
            new_messages.append(
                ToolMessage(content=str(payload), tool_call_id=tc["id"], name=name)
            )
            if is_draft_tool(name):
                try:
                    parsed = json.loads(payload) if isinstance(payload, str) else payload
                    if parsed.get("ok") and parsed.get("data") is not None:
                        last_diff = parsed["data"]
                except (json.JSONDecodeError, AttributeError, TypeError):
                    pass

        update: dict[str, Any] = {"history": new_messages}
        if last_diff is not None:
            update["last_diff"] = last_diff
        return update

    def after_reason(state: ConversationState) -> str:
        last = (state.get("history") or [None])[-1]
        tool_calls = getattr(last, "tool_calls", None) if isinstance(last, AIMessage) else None
        if tool_calls:
            return "tools"
        return END

    def after_tools(state: ConversationState) -> str:
        # Draft tool result lands in last_diff; that ends the turn so the user
        # can review the proposed diff (Pattern Y — server stays stateless after
        # this point; the diff travels through the HTTP response).
        if state.get("last_diff") is not None:
            return END
        return "reason"

    graph = StateGraph(ConversationState)
    graph.add_node("reason", reason)
    graph.add_node("tools", tools_node)
    graph.add_edge(START, "reason")
    graph.add_conditional_edges("reason", after_reason, {"tools": "tools", END: END})
    graph.add_conditional_edges("tools", after_tools, {"reason": "reason", END: END})

    return graph.compile(checkpointer=checkpointer)
