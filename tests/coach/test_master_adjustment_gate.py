"""Hard gates for evidence-based master-plan adjustment proposals."""

from __future__ import annotations

from typing import Any

from langchain_core.messages import AIMessage, HumanMessage

from coach.graphs.conversation.graph import build_conversation_graph
from coach.schemas import ToolResult
from .stubs.fake_toolkit import FakeToolkit


class _ScriptedLLM:
    def __init__(self, responses: list[AIMessage]) -> None:
        self._responses = list(responses)
        self.bound_tool_names: set[str] = set()

    def bind_tools(self, tools: list[Any], **_kwargs: Any) -> "_ScriptedLLM":
        self.bound_tool_names = {tool.name for tool in tools}
        return self

    def invoke(self, _messages: list[Any]) -> AIMessage:
        if not self._responses:
            raise AssertionError("scripted LLM ran out of responses")
        return self._responses.pop(0)


class _NoArgRead:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def __call__(self) -> ToolResult:
        self.calls.append({})
        return ToolResult(ok=True, data={})


class _PmcRead:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def __call__(self, *, days: int = 42, granularity: str = "daily") -> ToolResult:
        self.calls.append({"days": days, "granularity": granularity})
        return ToolResult(ok=True, data={})


class _MasterLoadRead:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def __call__(
        self,
        *,
        plan: dict | None = None,
        target_race: dict | None = None,
        weekly_run_days_max: int | None = None,
        injuries: list[str] | None = None,
        as_of_date: str | None = None,
    ) -> ToolResult:
        self.calls.append({"plan": plan})
        return ToolResult(ok=True, data={})


class _ProposeAlternatives:
    def __init__(self, result: ToolResult | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self.result = result or ToolResult(ok=True, data={})

    def __call__(self, *, plan_id: str, intent: str) -> ToolResult:
        self.calls.append({"plan_id": plan_id, "intent": intent})
        return self.result


def _toolkit() -> FakeToolkit:
    toolkit = FakeToolkit()
    toolkit.get_master_plan_current = _NoArgRead()
    toolkit.get_health_snapshot = _NoArgRead()
    toolkit.get_pmc_series = _PmcRead()
    toolkit.estimate_master_plan_load = _MasterLoadRead()
    toolkit.propose_alternatives = _ProposeAlternatives()
    return toolkit


def _tool_calls(*calls: tuple[str, dict[str, Any]]) -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[
            {
                "name": name,
                "args": args,
                "id": f"call-{index}",
                "type": "tool_call",
            }
            for index, (name, args) in enumerate(calls)
        ],
    )


def _read_calls() -> AIMessage:
    return _tool_calls(
        ("get_master_plan_current", {}),
        ("get_health_snapshot", {}),
        ("get_pmc_series", {"days": 42}),
        ("estimate_master_plan_load", {}),
    )


def _invoke(
    llm: _ScriptedLLM,
    toolkit: FakeToolkit,
    *,
    consulted_tools: list[str] | None = None,
    tracked_request: str | None = "我想降低基础期周跑量",
    assessment: dict[str, Any] | None = None,
) -> dict[str, Any]:
    graph = build_conversation_graph(
        toolkit=toolkit, llm=llm, checkpointer=None, scope="master_chat"
    )
    return graph.invoke(
        {
            "history": [HumanMessage(content="我想降低基础期周跑量")],
            "scope": "master_chat",
            "user_id": "u1",
            "plan_id": "plan-1",
            "consulted_tools": consulted_tools or [],
            "master_adjustment_request": tracked_request,
            "master_adjustment_assessment": assessment,
            "last_diff": None,
            "iteration": 0,
        },
        config={},
    )


def test_assessment_is_rejected_until_required_data_has_been_read() -> None:
    toolkit = _toolkit()
    llm = _ScriptedLLM(
        [
            _tool_calls(
                (
                    "assess_master_adjustment",
                    {
                        "adjustment_request": "我想降低基础期周跑量",
                        "verdict": "reasonable",
                        "rationale": "看起来可以",
                    },
                )
            ),
            AIMessage(content="我需要先读取你的训练数据。"),
        ]
    )

    state = _invoke(llm, toolkit)

    assert state.get("master_adjustment_assessment") is None
    assert state.get("last_diff") is None


def test_draft_is_rejected_without_a_reasonable_assessment() -> None:
    toolkit = _toolkit()
    llm = _ScriptedLLM(
        [
            _tool_calls(
                (
                    "propose_alternatives",
                    {"plan_id": "plan-1", "intent": "降低基础期周跑量"},
                )
            ),
            AIMessage(content="我需要先评估这个想法是否合理。"),
        ]
    )

    state = _invoke(llm, toolkit)

    assert toolkit.propose_alternatives.calls == []
    assert state.get("last_diff") is None


def test_unreasonable_assessment_never_allows_a_proposal() -> None:
    toolkit = _toolkit()
    llm = _ScriptedLLM(
        [
            _read_calls(),
            _tool_calls(
                (
                    "assess_master_adjustment",
                    {
                        "adjustment_request": "我想降低基础期周跑量",
                        "verdict": "unreasonable",
                        "rationale": "会压缩必要的赛前调整期",
                    },
                )
            ),
            _tool_calls(
                (
                    "propose_alternatives",
                    {"plan_id": "plan-1", "intent": "降低基础期周跑量"},
                )
            ),
            AIMessage(content="这个调整目前不合理，因此不会生成提案。"),
        ]
    )

    state = _invoke(llm, toolkit)

    assert state["master_adjustment_assessment"]["verdict"] == "unreasonable"
    assert toolkit.propose_alternatives.calls == []
    assert state.get("last_diff") is None


def test_reasonable_assessment_after_data_reads_allows_a_proposal() -> None:
    toolkit = _toolkit()
    diff = {
        "diff_id": "d1",
        "plan_id": "plan-1",
        "ops": [],
        "ai_explanation": "降低基础期周跑量",
        "created_at": "2026-07-15T00:00:00+00:00",
    }
    toolkit.propose_alternatives = _ProposeAlternatives(
        ToolResult(ok=True, data={"alternatives": [diff], "intent": "降低基础期周跑量"})
    )
    llm = _ScriptedLLM(
        [
            _read_calls(),
            _tool_calls(
                (
                    "assess_master_adjustment",
                    {
                        "adjustment_request": "我想降低基础期周跑量",
                        "verdict": "reasonable",
                        "rationale": "近期负荷和恢复数据支持温和下调",
                    },
                )
            ),
            _tool_calls(
                (
                    "propose_alternatives",
                    {"plan_id": "plan-1", "intent": "降低基础期周跑量"},
                )
            ),
        ]
    )

    state = _invoke(llm, toolkit)

    assert {
        "get_master_plan_current",
        "get_health_snapshot",
        "get_pmc_series",
        "estimate_master_plan_load",
    }.issubset(state["consulted_tools"])
    assert state["master_adjustment_assessment"]["verdict"] == "reasonable"
    assert toolkit.propose_alternatives.calls == [
        {"plan_id": "plan-1", "intent": "降低基础期周跑量"}
    ]
    assert state["last_diff"]["alternatives"][0]["diff_id"] == "d1"
    assert "assess_master_adjustment" in llm.bound_tool_names


def test_reasonable_assessment_for_an_old_request_cannot_authorize_a_new_draft() -> None:
    toolkit = _toolkit()
    llm = _ScriptedLLM(
        [
            _tool_calls(
                (
                    "propose_alternatives",
                    {"plan_id": "plan-1", "intent": "降低基础期周跑量"},
                )
            ),
            AIMessage(content="我需要先评估当前这条调整想法。"),
        ]
    )

    state = _invoke(
        llm,
        toolkit,
        assessment={
            "adjustment_request": "我想延长基础期两周",
            "verdict": "reasonable",
            "rationale": "旧想法合理",
        },
    )

    assert toolkit.propose_alternatives.calls == []
    assert state.get("last_diff") is None


def test_reads_for_an_old_request_cannot_authorize_a_new_assessment() -> None:
    toolkit = _toolkit()
    llm = _ScriptedLLM(
        [
            _tool_calls(
                (
                    "assess_master_adjustment",
                    {
                        "adjustment_request": "我想降低基础期周跑量",
                        "verdict": "reasonable",
                        "rationale": "旧数据不能用于新想法",
                    },
                )
            ),
            AIMessage(content="我需要针对这个想法重新读取数据。"),
        ]
    )

    state = _invoke(
        llm,
        toolkit,
        consulted_tools=[
            "get_master_plan_current",
            "get_health_snapshot",
            "get_pmc_series",
            "estimate_master_plan_load",
        ],
        tracked_request="我想延长基础期两周",
    )

    assert state.get("master_adjustment_assessment") is None
    assert state.get("last_diff") is None
