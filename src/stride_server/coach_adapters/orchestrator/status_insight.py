"""status_insight specialist — wraps the existing qa conversation graph (§4.3, §7).

The status_insight expert answers training-status / fatigue / load / metric
questions. It already exists as the LIVE qa scope of the conversation graph, so
this adapter just dresses it in the SpecialistContract: ``SpecialistTask`` →
``SpecialistResult``.

Key design point — the runner is **stateless per call** (the qa graph is built
with ``checkpointer=None``). Session memory lives at the orchestrator level (the
``conversation_window`` arrives inside the task); the specialist must not write
to the legacy ``{user}:qa:{date}`` daily thread.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage

from coach.contracts import (
    SpecialistCard,
    SpecialistResult,
    SpecialistRunner,
    SpecialistTask,
    Turn,
)
from coach.graphs.conversation.graph import build_conversation_graph
from coach.schemas import assistant_parts_from_message

from ..toolkit import build_stride_toolkit

logger = logging.getLogger(__name__)

# Builds the qa conversation graph; injectable so the runner is unit-testable
# without a real toolkit / LLM.
GraphFactory = Callable[..., Any]


STATUS_INSIGHT_CARD = SpecialistCard(
    id="status_insight",
    description=(
        "回答训练状态、疲劳、负荷、训练指标、身体数据相关的问题；解读 PMC/form 趋势、"
        "判断是否过度训练、给现状诊断。只读，不修改任何计划。"
    ),
    tags=["状态", "疲劳", "负荷", "诊断", "指标", "form", "问答"],
    examples=[
        "我最近状态怎么样",
        "这周训练量够吗",
        "我是不是过度训练了",
        "解释一下我的 form 趋势",
        "昨天那节间歇质量如何",
    ],
    writes=False,
    data_needs=["fatigue", "load", "prediction", "completion"],
)


def _window_to_messages(window: list[Turn]) -> list[Any]:
    messages: list[Any] = []
    for turn in window:
        if turn.role == "user":
            messages.append(HumanMessage(content=turn.content))
        else:
            messages.append(AIMessage(content=turn.content))
    return messages


def _extract_answer(state: dict[str, Any]) -> str:
    history = state.get("history") or []
    last = history[-1] if history else None
    if last is None:
        return ""
    texts = [part.text for part in assistant_parts_from_message(last) if part.kind == "text"]
    return "\n".join(t for t in texts if t).strip()


def make_status_insight_runner(
    *,
    user_id: str,
    llm: Any,
    toolkit: Any | None = None,
    graph_factory: GraphFactory = build_conversation_graph,
) -> SpecialistRunner:
    """Build the status_insight runner.

    ``llm`` is the strong specialist model (the generator role — §4.7 reserves
    strong models for specialists). ``toolkit`` / ``graph_factory`` are
    injectable for tests.
    """

    def _run(task: SpecialistTask) -> SpecialistResult:
        active_toolkit = toolkit or build_stride_toolkit(user_id)
        graph = graph_factory(
            toolkit=active_toolkit, llm=llm, checkpointer=None, scope="qa"
        )
        messages: list[Any] = []
        # Long-term memory (injected by Memory Load, §4.0) as background context.
        if task.context and task.context.notes:
            messages.append(HumanMessage(content=f"（已知长期背景，供参考）\n{task.context.notes}"))
        messages.extend(_window_to_messages(task.conversation_window))
        messages.append(HumanMessage(content=task.objective))
        logger.debug(
            "status_insight: running qa graph | seed=%d msgs (window=%d + objective)",
            len(messages),
            len(task.conversation_window),
        )
        state_in = {
            "history": messages,
            "scope": "qa",
            "user_id": user_id,
            "thread_id": "",
            "folder": None,
            "plan_id": None,
            "constraints": [],
            "last_diff": None,
            "iteration": 0,
        }
        state = graph.invoke(state_in, config={})
        answer = _extract_answer(state)
        logger.debug(
            "status_insight: qa graph done | answer=%dc | iters=%s",
            len(answer),
            state.get("iteration"),
        )
        return SpecialistResult(status="completed", reply_fragment=answer)

    return _run
