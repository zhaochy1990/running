"""S1f — status_insight runner wraps the qa graph as a SpecialistContract."""

from __future__ import annotations

from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from coach.contracts import SpecialistTask, TargetRef, Turn
from stride_server.coach_adapters.orchestrator.status_insight import (
    CURRENT_WEEK_MISSING_REPLY,
    STATUS_INSIGHT_CARD,
    make_status_insight_runner,
)


class _FakeGraph:
    def __init__(self, answer: str, capture: dict[str, Any]):
        self._answer = answer
        self._capture = capture

    def invoke(self, state_in: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
        self._capture["state_in"] = state_in
        self._capture["config"] = config
        history = list(state_in["history"])
        history.append(AIMessage(content=self._answer))
        return {"history": history, "iteration": 1}


def _factory(answer: str, capture: dict[str, Any]):
    def _make(*, toolkit: Any, llm: Any, checkpointer: Any, scope: str) -> _FakeGraph:
        capture["build"] = {
            "toolkit": toolkit,
            "llm": llm,
            "checkpointer": checkpointer,
            "scope": scope,
        }
        return _FakeGraph(answer, capture)

    return _make


def test_card_is_read_only_with_routing_metadata() -> None:
    assert STATUS_INSIGHT_CARD.id == "status_insight"
    assert STATUS_INSIGHT_CARD.writes is False
    assert STATUS_INSIGHT_CARD.examples  # examples anchor routing
    assert "当前计划" in STATUS_INSIGHT_CARD.tags
    assert any("总体训练计划" in example for example in STATUS_INSIGHT_CARD.examples)


def test_runner_returns_completed_result_with_answer() -> None:
    capture: dict[str, Any] = {}
    runner = make_status_insight_runner(
        user_id="u1",
        llm=object(),
        toolkit=object(),
        graph_factory=_factory("你最近负荷偏高，注意恢复。", capture),
    )
    result = runner(SpecialistTask(objective="我状态如何"))
    assert result.status == "completed"
    assert result.reply_fragment == "你最近负荷偏高，注意恢复。"
    assert result.proposals == []


def test_runner_runs_stateless_qa_scope() -> None:
    """The wrapped qa graph must be built with no checkpointer (§4.3)."""
    capture: dict[str, Any] = {}
    runner = make_status_insight_runner(
        user_id="u1", llm=object(), toolkit=object(), graph_factory=_factory("ok", capture)
    )
    runner(SpecialistTask(objective="x"))
    assert capture["build"]["checkpointer"] is None
    assert capture["build"]["scope"] == "qa"


def test_runner_seeds_window_then_objective() -> None:
    capture: dict[str, Any] = {}
    runner = make_status_insight_runner(
        user_id="u1", llm=object(), toolkit=object(), graph_factory=_factory("ok", capture)
    )
    runner(
        SpecialistTask(
            objective="现在呢",
            conversation_window=[
                Turn(role="user", content="昨天我跑了10公里"),
                Turn(role="assistant", content="不错，注意恢复"),
            ],
        )
    )
    history = capture["state_in"]["history"]
    assert isinstance(history[0], HumanMessage) and history[0].content == "昨天我跑了10公里"
    assert isinstance(history[1], AIMessage)
    # Current objective is the trailing user message.
    assert isinstance(history[-1], HumanMessage) and history[-1].content == "现在呢"
    assert capture["state_in"]["scope"] == "qa"


def test_runner_seeds_concrete_read_only_plan_target() -> None:
    capture: dict[str, Any] = {}
    runner = make_status_insight_runner(
        user_id="u1", llm=object(), toolkit=object(), graph_factory=_factory("ok", capture)
    )

    runner(
        SpecialistTask(
            objective="本周计划是什么",
            active_target=TargetRef(kind="week", folder="2026-07-13_07-19(W12)"),
        )
    )

    history = capture["state_in"]["history"]
    assert len(history) == 1
    assert isinstance(history[0], HumanMessage)
    assert history[0].content == "本周计划是什么"


def test_week_target_does_not_override_an_unrelated_status_objective() -> None:
    capture: dict[str, Any] = {}
    runner = make_status_insight_runner(
        user_id="u1", llm=object(), toolkit=object(), graph_factory=_factory("ok", capture)
    )

    runner(
        SpecialistTask(
            objective="我今天恢复状态怎么样",
            active_target=TargetRef(kind="week", folder="2026-07-13_07-19(W12)"),
        )
    )

    history = capture["state_in"]["history"]
    assert len(history) == 1
    assert history[0].content == "我今天恢复状态怎么样"


def test_runner_normalizes_missing_current_week_tool_result() -> None:
    class _MissingWeekGraph:
        def invoke(self, state_in: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
            history = list(state_in["history"])
            history.extend(
                [
                    ToolMessage(
                        name="get_week_plan",
                        tool_call_id="week-1",
                        content=(
                            '{"ok":true,"data":{'
                            '"available":false,'
                            '"missing_reason":"no_plan_for_current_shanghai_week"}}'
                        ),
                    ),
                    AIMessage(content="当前没有可读取的结构化计划。"),
                ]
            )
            return {"history": history, "iteration": 1}

    def _missing_factory(**_kwargs):
        return _MissingWeekGraph()

    runner = make_status_insight_runner(
        user_id="u1",
        llm=object(),
        toolkit=object(),
        graph_factory=_missing_factory,
    )

    result = runner(
        SpecialistTask(
            objective="本周计划是什么",
            active_target=TargetRef(kind="week"),
        )
    )

    assert result.reply_fragment == CURRENT_WEEK_MISSING_REPLY
