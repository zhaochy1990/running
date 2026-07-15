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
import logging
import time
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph

from coach.runtime.toolkit import Toolkit
from coach.schemas import ConversationState

from .prompts.master_chat import MASTER_CHAT_PROMPT
from .prompts.qa import QA_PROMPT
from .prompts.week_chat import WEEK_CHAT_PROMPT
from .tool_bridge import (
    MASTER_ASSESSMENT_TOOL_NAME,
    MASTER_DRAFT_TOOL_NAMES,
    READ_TOOL_NAMES,
    build_langchain_tools,
    is_draft_tool,
)

logger = logging.getLogger(__name__)

_MASTER_ASSESSMENT_REQUIRED_READS = frozenset(
    {
        "get_master_plan_current",
        "get_health_snapshot",
        "get_pmc_series",
        "estimate_master_plan_load",
    }
)


def _current_user_request(state: ConversationState) -> str:
    for message in reversed(state.get("history") or []):
        if isinstance(message, HumanMessage):
            content = message.content
            return content.strip() if isinstance(content, str) else str(content).strip()
    return ""


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
        started = time.perf_counter()
        resp = llm_with_tools.invoke(msgs)
        iteration = state.get("iteration", 0) + 1
        logger.debug(
            "qa reason | iteration=%d elapsed=%.0fms messages=%d tool_calls=%s",
            iteration,
            (time.perf_counter() - started) * 1000.0,
            len(msgs),
            [call.get("name") for call in (getattr(resp, "tool_calls", None) or [])],
        )
        return {"history": [resp], "iteration": iteration}

    def tools_node(state: ConversationState) -> dict[str, Any]:
        history = state.get("history", [])
        last = history[-1] if history else None
        tool_calls = getattr(last, "tool_calls", None) or []
        new_messages: list[Any] = []
        last_diff: dict | None = None
        current_request = _current_user_request(state)
        same_request = state.get("master_adjustment_request") == current_request
        consulted_before = (
            set(state.get("consulted_tools") or []) if same_request else set()
        )
        consulted_after = set(consulted_before)
        assessment_before = (
            state.get("master_adjustment_assessment") if same_request else None
        )
        assessment_after = assessment_before
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
            if scope == "master_chat" and name == MASTER_ASSESSMENT_TOOL_NAME:
                missing = sorted(_MASTER_ASSESSMENT_REQUIRED_READS - consulted_before)
                request_mismatch = str(args.get("adjustment_request") or "").strip() != current_request
                if missing or request_mismatch:
                    errors = []
                    if missing:
                        errors.append(
                            "assessment_requires_prior_read_results: " + ", ".join(missing)
                        )
                    if request_mismatch:
                        errors.append("assessment_request_does_not_match_current_user_request")
                    payload = json.dumps(
                        {"ok": False, "errors": errors},
                        ensure_ascii=False,
                    )
                    new_messages.append(
                        ToolMessage(
                            content=payload,
                            tool_call_id=tc["id"],
                            name=name,
                        )
                    )
                    continue
            if scope == "master_chat" and name in MASTER_DRAFT_TOOL_NAMES:
                verdict = (assessment_before or {}).get("verdict")
                assessed_request = (assessment_before or {}).get("adjustment_request")
                if verdict != "reasonable" or assessed_request != current_request:
                    payload = json.dumps(
                        {
                            "ok": False,
                            "errors": [
                                "proposal_requires_prior_reasonable_assessment"
                            ],
                        },
                        ensure_ascii=False,
                    )
                    new_messages.append(
                        ToolMessage(
                            content=payload,
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
            parsed_payload: Any = None
            try:
                parsed_payload = json.loads(payload) if isinstance(payload, str) else payload
            except (json.JSONDecodeError, TypeError):
                pass
            if (
                name in READ_TOOL_NAMES
                and isinstance(parsed_payload, dict)
                and parsed_payload.get("ok")
            ):
                consulted_after.add(name)
            if name == MASTER_ASSESSMENT_TOOL_NAME:
                try:
                    data = parsed_payload.get("data")
                    if parsed_payload.get("ok") and isinstance(data, dict):
                        assessment_after = data
                except AttributeError:
                    pass
            if is_draft_tool(name):
                try:
                    if parsed_payload.get("ok") and parsed_payload.get("data") is not None:
                        last_diff = parsed_payload["data"]
                except AttributeError:
                    pass

        update: dict[str, Any] = {
            "history": new_messages,
            "consulted_tools": sorted(consulted_after),
            "master_adjustment_request": current_request,
            "master_adjustment_assessment": assessment_after,
        }
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
