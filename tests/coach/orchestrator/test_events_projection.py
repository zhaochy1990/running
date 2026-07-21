"""Trusted events project into orchestrator context (resolver + specialist)."""

from __future__ import annotations

from langchain_core.messages import HumanMessage
from langgraph.checkpoint.memory import InMemorySaver

from coach.contracts import (
    IntentHit,
    ResolverDraft,
    SpecialistCard,
    SpecialistRegistry,
    SpecialistResult,
    SpecialistTask,
)
from coach.orchestrator import build_orchestrator_graph, coach_thread_id
from coach.orchestrator.graph import _events_context


def test_events_context_projection_is_compact() -> None:
    ctx = _events_context(
        [
            {"type": "weekly_plan_applied", "status": "applied", "summary": "应用本周调整"},
            {"type": "proposal_abandoned", "status": "abandoned", "summary": "放弃方案"},
        ]
    )
    assert "应用本周调整" in ctx
    assert "放弃方案" in ctx
    assert ctx.startswith("# ")


def test_events_reach_the_specialist_via_context() -> None:
    seen: list[str] = []

    def _runner(task: SpecialistTask) -> SpecialistResult:
        seen.append(task.context.notes or "")
        return SpecialistResult(status="completed", reply_fragment="ok")

    reg = SpecialistRegistry()
    reg.register(SpecialistCard(id="status_insight", description="x", writes=False), _runner)

    graph = build_orchestrator_graph(
        registry=reg,
        draft_fn=lambda _s, _u: ResolverDraft(
            intents=[IntentHit(specialist_id="status_insight", action="read", confidence=0.95)]
        ),
        checkpointer=InMemorySaver(),
    )
    config = {"configurable": {"thread_id": coach_thread_id("u1", "s1"), "checkpoint_ns": ""}}
    graph.invoke(
        {
            "history": [HumanMessage(content="我状态如何")],
            "user_id": "u1",
            "session_id": "s1",
            "events": [
                {"type": "weekly_plan_applied", "status": "applied", "summary": "应用本周调整"}
            ],
        },
        config=config,
    )
    assert seen
    assert "应用本周调整" in seen[0]
