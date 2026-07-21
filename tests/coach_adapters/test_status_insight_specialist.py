"""S1f — status_insight runner wraps the qa graph as a SpecialistContract."""

from __future__ import annotations

from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from coach.contracts import (
    MAX_REVIEW_CONTEXT_BYTES,
    ScopedContext,
    SpecialistTask,
    TargetRef,
    Turn,
)
from stride_server.coach_adapters.orchestrator.status_insight import (
    CURRENT_WEEK_MISSING_REPLY,
    STATUS_INSIGHT_CARD,
    make_status_insight_runner,
)

_DRAFT_CONTEXT = {
    "kind": "weekly_create",
    "proposal": {
        "proposal_id": "wp-draft-1",
        "folder": "2026-07-20_07-26",
        "plan": {
            "week_folder": "2026-07-20_07-26",
            "sessions": [
                {
                    "date": "2026-07-22",
                    "session_index": 0,
                    "kind": "run",
                    "summary": "轻松跑 8km",
                }
            ],
            "notes_md": "本周以有氧积累为主",
        },
        "total_distance_km": 30.0,
        "ai_explanation": "以基础期有氧为主，暂不加强度。",
        "created_at": "2026-07-19T00:00:00Z",
    },
}


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
    assert len(history) == 2
    assert isinstance(history[0], HumanMessage)
    assert "folder = 2026-07-13_07-19(W12)" in history[0].content
    assert "get_week_plan" in history[0].content
    assert history[1].content == "本周计划是什么"


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


def test_review_draft_is_authoritative_and_forbids_saved_plan_read() -> None:
    """An unapplied review draft seeds the qa graph as the authoritative plan.

    The runner must inject the draft payload and instruct the model NOT to call
    get_week_plan — even for a plan-content question that would normally route
    to the saved-week read path.
    """
    capture: dict[str, Any] = {}
    runner = make_status_insight_runner(
        user_id="u1", llm=object(), toolkit=object(), graph_factory=_factory("草案逻辑是有氧积累。", capture)
    )

    result = runner(
        SpecialistTask(
            objective="这个课表的训练逻辑是什么",
            active_target=TargetRef(kind="week", folder="2026-07-20_07-26"),
            context=ScopedContext(data={"review_context": _DRAFT_CONTEXT}),
        )
    )

    history = capture["state_in"]["history"]
    draft_msg = history[0]
    assert isinstance(draft_msg, HumanMessage)
    assert "尚未启用" in draft_msg.content
    assert "folder = 2026-07-20_07-26" in draft_msg.content
    assert "不要调用 get_week_plan" in draft_msg.content
    assert "不要在右栏重复整张日历" in draft_msg.content
    # The draft JSON and the coach's explanation both ride the message.
    assert "轻松跑 8km" in draft_msg.content
    assert "以基础期有氧为主" in draft_msg.content
    # The saved-week read instruction must NOT also be injected.
    assert not any(
        isinstance(m, HumanMessage) and "调用 get_week_plan 时必须传这个 folder" in m.content
        for m in history
    )
    assert history[-1].content == "这个课表的训练逻辑是什么"
    assert result.reply_fragment == "草案逻辑是有氧积累。"


def test_oversized_internal_review_draft_falls_back_to_normal_path() -> None:
    """A corrupt checkpoint cannot inject an oversized draft into the QA prompt."""
    oversized_context = {
        **_DRAFT_CONTEXT,
        "proposal": {
            **_DRAFT_CONTEXT["proposal"],
            "plan": {
                **_DRAFT_CONTEXT["proposal"]["plan"],
                "notes_md": "x" * (MAX_REVIEW_CONTEXT_BYTES + 1),
            },
        },
    }
    capture: dict[str, Any] = {}
    runner = make_status_insight_runner(
        user_id="u1", llm=object(), toolkit=object(), graph_factory=_factory("ok", capture)
    )

    runner(
        SpecialistTask(
            objective="这个课表的训练逻辑是什么",
            active_target=TargetRef(kind="week", folder="2026-07-20_07-26"),
            context=ScopedContext(data={"review_context": oversized_context}),
        )
    )

    history = capture["state_in"]["history"]
    assert not any("尚未启用" in getattr(m, "content", "") for m in history)
    assert any("调用 get_week_plan 时必须传这个 folder" in getattr(m, "content", "") for m in history)


def test_malformed_review_draft_falls_back_to_normal_path() -> None:
    """A draft payload missing its plan is ignored (no draft message injected)."""
    capture: dict[str, Any] = {}
    runner = make_status_insight_runner(
        user_id="u1", llm=object(), toolkit=object(), graph_factory=_factory("ok", capture)
    )

    runner(
        SpecialistTask(
            objective="这个课表的训练逻辑是什么",
            active_target=TargetRef(kind="week", folder="2026-07-20_07-26"),
            context=ScopedContext(data={"review_context": {"kind": "weekly_create"}}),
        )
    )

    history = capture["state_in"]["history"]
    # No draft message; falls back to the saved-week read instruction.
    assert not any("尚未启用" in getattr(m, "content", "") for m in history)
    assert any("调用 get_week_plan 时必须传这个 folder" in getattr(m, "content", "") for m in history)
