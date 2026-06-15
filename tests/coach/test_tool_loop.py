"""Tests for the generic ``run_tool_loop`` (coach CORE, Stage-3a Task 8 Part A).

``run_tool_loop(llm_with_tools, messages, tool_map, *, max_tool_iters=4)`` drives
a langchain tool-calling conversation:

  * invoke the (tool-bound) model,
  * if the AIMessage carries ``tool_calls``, run each via ``tool_map[name].invoke``,
    feed the JSON result back as a ``ToolMessage``, and re-invoke,
  * stop and return the model's text once it stops asking for tools (or the
    iteration cap is hit).

No network, no DB — the LLM and tools are pure in-memory fakes here, exactly the
contract the adapter layer will satisfy with a real bindable model + StructuredTools.
"""

from __future__ import annotations

from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from coach.runtime.tool_loop import run_tool_loop


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class _ScriptedLLM:
    """A fake ``llm_with_tools`` whose ``.invoke(messages)`` returns the next
    scripted AIMessage. Records every message-list it was invoked with."""

    def __init__(self, responses: list[AIMessage]) -> None:
        self._responses = list(responses)
        self.invocations: list[list[Any]] = []
        # A separate "no tools" responder for the final-invoke-without-tools path.
        self.final_response: AIMessage | None = None
        self.bind_tools_called_with: Any = None

    def invoke(self, messages: list[Any]) -> AIMessage:
        self.invocations.append(list(messages))
        if self._responses:
            return self._responses.pop(0)
        # Exhausted script → behave like a model that produced final text.
        return AIMessage(content="(exhausted)")

    def bind_tools(self, tools: Any, **_kw: Any) -> "_ScriptedLLM":
        self.bind_tools_called_with = tools
        return self


class _RecordingTool:
    """A fake StructuredTool: ``.name`` + ``.invoke(args)`` returning a JSON str.

    Records the args it was invoked with so tests can assert the model's
    tool_call arguments reached the impl."""

    def __init__(self, name: str, result: str = '{"ok": true, "data": {}}') -> None:
        self.name = name
        self._result = result
        self.invoked_with: list[dict] = []

    def invoke(self, args: dict) -> str:
        self.invoked_with.append(dict(args))
        return self._result


def _ai_with_tool_call(name: str, args: dict, *, tc_id: str = "call_1") -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[{"name": name, "args": args, "id": tc_id, "type": "tool_call"}],
    )


def _start_messages() -> list[Any]:
    return [SystemMessage(content="sys"), HumanMessage(content="hi")]


# ---------------------------------------------------------------------------
# no tool call → text returned immediately
# ---------------------------------------------------------------------------


def test_no_tool_call_returns_text_immediately():
    llm = _ScriptedLLM([AIMessage(content="final answer")])
    out = run_tool_loop(llm, _start_messages(), {})
    assert out == "final answer"
    # exactly one invoke (no second round)
    assert len(llm.invocations) == 1


# ---------------------------------------------------------------------------
# one tool call → impl invoked, ToolMessage fed back, final text returned
# ---------------------------------------------------------------------------


def test_tool_call_invokes_impl_and_feeds_result_back():
    tool = _RecordingTool("strength_library", '{"ok": true, "data": {"exercises": []}}')
    llm = _ScriptedLLM(
        [
            _ai_with_tool_call("strength_library", {"targets": ["core"]}),
            AIMessage(content="here is your plan"),
        ]
    )
    out = run_tool_loop(llm, _start_messages(), {"strength_library": tool})

    assert out == "here is your plan"
    # the tool impl saw the model's args
    assert tool.invoked_with == [{"targets": ["core"]}]
    # round 2's message list must contain a ToolMessage with the result + tool_call_id
    second_round = llm.invocations[1]
    tool_msgs = [m for m in second_round if isinstance(m, ToolMessage)]
    assert len(tool_msgs) == 1
    assert tool_msgs[0].tool_call_id == "call_1"
    assert "exercises" in tool_msgs[0].content
    # the AIMessage that requested the tool was appended before the ToolMessage
    assert any(isinstance(m, AIMessage) and m.tool_calls for m in second_round)


# ---------------------------------------------------------------------------
# unknown tool → error ToolMessage, no crash, loop continues
# ---------------------------------------------------------------------------


def test_unknown_tool_appends_error_toolmessage_no_crash():
    llm = _ScriptedLLM(
        [
            _ai_with_tool_call("does_not_exist", {"x": 1}, tc_id="call_x"),
            AIMessage(content="recovered"),
        ]
    )
    out = run_tool_loop(llm, _start_messages(), {})
    assert out == "recovered"
    second_round = llm.invocations[1]
    tool_msgs = [m for m in second_round if isinstance(m, ToolMessage)]
    assert len(tool_msgs) == 1
    assert tool_msgs[0].tool_call_id == "call_x"
    assert "unknown tool" in tool_msgs[0].content.lower()


# ---------------------------------------------------------------------------
# max_tool_iters cap respected — final invoke without tools yields text
# ---------------------------------------------------------------------------


def test_max_tool_iters_cap_respected():
    tool = _RecordingTool("recent_training")
    # The model asks for the tool max_tool_iters times, then (on the final
    # tool-less re-invoke the loop performs after the cap) produces text.
    looping = [
        _ai_with_tool_call("recent_training", {"weeks": 4}, tc_id=f"c{i}")
        for i in range(3)
    ] + [AIMessage(content="forced final")]
    llm = _ScriptedLLM(looping)

    out = run_tool_loop(llm, _start_messages(), {"recent_training": tool}, max_tool_iters=3)

    # The tool was invoked at most max_tool_iters times (one per tool round).
    assert len(tool.invoked_with) <= 3
    # After the cap the loop does one final invoke (no further tool execution)
    # and returns its text.
    assert out == "forced final"
    # Reasoning rounds = max_tool_iters initial invokes + 1 final invoke.
    assert len(llm.invocations) == 4


# ---------------------------------------------------------------------------
# multiple tool calls in one AIMessage → all invoked, all fed back
# ---------------------------------------------------------------------------


def test_multiple_tool_calls_in_one_round():
    t1 = _RecordingTool("strength_library", '{"ok": true, "data": {"a": 1}}')
    t2 = _RecordingTool("recent_training", '{"ok": true, "data": {"b": 2}}')
    ai = AIMessage(
        content="",
        tool_calls=[
            {"name": "strength_library", "args": {"targets": ["core"]}, "id": "c1", "type": "tool_call"},
            {"name": "recent_training", "args": {"weeks": 4}, "id": "c2", "type": "tool_call"},
        ],
    )
    llm = _ScriptedLLM([ai, AIMessage(content="done")])
    out = run_tool_loop(
        llm, _start_messages(), {"strength_library": t1, "recent_training": t2}
    )
    assert out == "done"
    assert t1.invoked_with == [{"targets": ["core"]}]
    assert t2.invoked_with == [{"weeks": 4}]
    # Two ToolMessages, one per call, with matching ids.
    second_round = llm.invocations[1]
    tm = [m for m in second_round if isinstance(m, ToolMessage)]
    assert {m.tool_call_id for m in tm} == {"c1", "c2"}


# ---------------------------------------------------------------------------
# a tool that raises → loop converts it to an error ToolMessage, no crash
# ---------------------------------------------------------------------------


def test_tool_raising_does_not_crash_loop():
    class _Boom:
        name = "boom"

        def invoke(self, args: dict) -> str:
            raise RuntimeError("kaboom")

    llm = _ScriptedLLM(
        [
            _ai_with_tool_call("boom", {}, tc_id="cb"),
            AIMessage(content="survived"),
        ]
    )
    out = run_tool_loop(llm, _start_messages(), {"boom": _Boom()})
    assert out == "survived"
    second_round = llm.invocations[1]
    tm = [m for m in second_round if isinstance(m, ToolMessage)]
    assert len(tm) == 1
    assert "kaboom" in tm[0].content or "RuntimeError" in tm[0].content
