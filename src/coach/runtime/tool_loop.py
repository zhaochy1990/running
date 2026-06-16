"""Generic langchain tool-calling loop — coach CORE (Stage-3a Task 8 Part A).

``run_tool_loop`` drives a tool-bound chat model to a final text answer:

  1. ``resp = llm_with_tools.invoke(messages)`` and append the ``AIMessage``.
  2. If ``resp.tool_calls`` is empty → return the response's text (done).
  3. Otherwise run each requested tool via ``tool_map[name].invoke(args)``,
     append one ``ToolMessage`` per call (carrying the JSON result + the
     ``tool_call_id`` langchain needs to correlate it), then re-invoke.
  4. Cap the number of tool rounds at ``max_tool_iters``. When the cap is hit
     the loop does ONE final ``invoke`` (the model still sees the accumulated
     tool results) and returns its text — so the caller always gets a final
     answer rather than a half-finished tool-call message. We do NOT strip the
     tool binding for that final call (the loop only holds ``llm_with_tools``);
     in practice a model that has already been told it exhausted its tool budget
     via the accumulated context produces a final answer, and even if it asks
     for another tool we return its text rather than executing it.

This mirrors the reason/tools_node bodies in
``coach.graphs.conversation.graph`` but with NO conversation state — just a flat
message list + a ``{name: StructuredTool}`` map — so it is framework-agnostic
and reusable by both the per-week specialist generator and (later) the
conversation graph.

Pure langchain + stdlib. ``coach.*`` core boundary: only ``langchain_core``
(messages) is imported, which the conversation core already does.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, ToolMessage

from .messages import extract_text

logger = logging.getLogger(__name__)


def _tool_calls_of(message: Any) -> list[dict]:
    """Return the (possibly empty) list of tool calls on an AIMessage."""
    return list(getattr(message, "tool_calls", None) or [])


def run_tool_loop(
    llm_with_tools: Any,
    messages: list[BaseMessage],
    tool_map: dict[str, Any],
    *,
    max_tool_iters: int = 4,
) -> str:
    """Run the tool-calling loop and return the model's final text.

    Args:
        llm_with_tools: a langchain ``Runnable`` (typically ``model.bind_tools(...)``)
            whose ``.invoke(messages)`` returns an ``AIMessage``. When no tools
            are wired this may be the bare model — the loop then behaves like a
            single ``invoke`` (no tool round ever fires).
        messages: the running message list — usually ``[SystemMessage, HumanMessage]``
            to start. Mutated in place (the AIMessage + any ToolMessages are
            appended) so the accumulated context is preserved across rounds.
        tool_map: ``{tool_name: structured_tool}`` where each value exposes
            ``.invoke(args) -> str`` (a langchain ``StructuredTool``). An unknown
            tool name produces an error ``ToolMessage`` rather than a crash.
        max_tool_iters: maximum number of tool-execution rounds. After the cap a
            single final ``invoke`` is performed and its text returned.

    Returns:
        The final assistant text (flattened via ``extract_text`` so Responses-API
        ``list[dict]`` content is handled the same way the rest of the codebase
        does).
    """
    work: list[BaseMessage] = messages  # append in place

    for _ in range(max_tool_iters):
        resp = llm_with_tools.invoke(work)
        work.append(resp)

        tool_calls = _tool_calls_of(resp)
        if not tool_calls:
            return extract_text(getattr(resp, "content", resp))

        for tc in tool_calls:
            name = tc.get("name")
            args = tc.get("args") or {}
            tc_id = tc.get("id")
            impl = tool_map.get(name)
            if impl is None:
                payload = json.dumps(
                    {"ok": False, "errors": [f"unknown tool {name}"]},
                    ensure_ascii=False,
                )
            else:
                try:
                    payload = impl.invoke(args)
                except Exception as exc:  # noqa: BLE001 — tool boundary
                    logger.warning("tool %s raised in tool_loop: %s", name, exc)
                    payload = json.dumps(
                        {"ok": False, "errors": [f"{type(exc).__name__}: {exc}"]},
                        ensure_ascii=False,
                    )
            work.append(
                ToolMessage(content=str(payload), tool_call_id=tc_id, name=name)
            )

    # Cap reached: one final invoke so the model produces an answer from the
    # accumulated tool results. Any further tool_calls are ignored — we return
    # the text rather than executing more tools.
    logger.info(
        "run_tool_loop: max_tool_iters=%d reached; forcing a final answer",
        max_tool_iters,
    )
    final = llm_with_tools.invoke(work)
    work.append(final)
    return extract_text(getattr(final, "content", final))
