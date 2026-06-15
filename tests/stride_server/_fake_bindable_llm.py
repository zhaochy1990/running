"""Reusable fake bindable chat model for the Stage-3a Task-8 adapter tests.

The per-week specialist generator now drives the LLM through a langchain
tool-calling loop bound to ``get_generator_llm()`` (instead of the old
``LLMClient().chat_sync`` text path). These tests inject a fake whose:

  * ``.bind_tools(tools)`` records the bound tools and returns a responder,
  * ``.invoke(messages)`` returns the next scripted ``AIMessage`` (either a plan
    JSON as content, or a tool_call that the loop will execute then re-invoke),
  * captures every system prompt + the message list it saw, so tests can assert
    the composed prompt and that tool results flowed back.

A single fake instance is shared between ``bind_tools`` and ``invoke`` so a test
can both inspect ``bound_tools`` and script ``invoke`` responses.
"""

from __future__ import annotations

from typing import Any, Callable

from langchain_core.messages import AIMessage, SystemMessage


class FakeBindableLLM:
    """A minimal stand-in for the generator ``BaseChatModel``.

    ``response_fn`` is called with the message list for each ``invoke`` and must
    return an ``AIMessage``. The default reads from ``replies`` (one AIMessage
    per call, last reused). ``bind_tools`` returns ``self`` so the same object
    serves as ``llm_with_tools`` — its ``.invoke`` is what the loop drives.
    """

    def __init__(
        self,
        replies: list[AIMessage] | None = None,
        *,
        response_fn: Callable[[list[Any]], AIMessage] | None = None,
    ) -> None:
        self.replies = list(replies or [])
        self._response_fn = response_fn
        self._idx = 0
        self.bound_tools: list[Any] = []
        # Captures: (system_prompt, messages) per invoke that begins a pass.
        self.captured: list[tuple[str, list[Any]]] = []
        self.invocations: list[list[Any]] = []

    def bind_tools(self, tools: Any, **_kw: Any) -> "FakeBindableLLM":
        self.bound_tools = list(tools)
        return self

    def invoke(self, messages: list[Any]) -> AIMessage:
        self.invocations.append(list(messages))
        sys_text = ""
        for m in messages:
            if isinstance(m, SystemMessage):
                sys_text = m.content if isinstance(m.content, str) else str(m.content)
                break
        self.captured.append((sys_text, list(messages)))
        if self._response_fn is not None:
            return self._response_fn(messages)
        if not self.replies:
            return AIMessage(content="")
        i = min(self._idx, len(self.replies) - 1)
        self._idx += 1
        return self.replies[i]


def ai_text(content: str) -> AIMessage:
    """An assistant message with no tool calls (loop returns its text)."""
    return AIMessage(content=content)


def ai_tool_call(name: str, args: dict, *, tc_id: str = "call_1") -> AIMessage:
    """An assistant message requesting one tool call (loop executes it)."""
    return AIMessage(
        content="",
        tool_calls=[{"name": name, "args": args, "id": tc_id, "type": "tool_call"}],
    )
