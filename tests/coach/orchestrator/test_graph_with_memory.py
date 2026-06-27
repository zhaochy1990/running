"""Phase C — end-to-end Memory Load + Writer loop through the orchestrator graph."""

from __future__ import annotations

from langchain_core.messages import HumanMessage
from langgraph.checkpoint.memory import InMemorySaver

from coach.contracts import (
    AthleteMemory,
    IntentHit,
    MemoryWrite,
    ResolverDraft,
    SpecialistCard,
    SpecialistRegistry,
    SpecialistResult,
    SpecialistTask,
    TurnResponse,
)
from coach.orchestrator import build_orchestrator_graph, coach_thread_id
from coach.orchestrator.memory import MemoryExtraction
from tests.coach.orchestrator.test_memory import FakeStore


def _invoke(graph, *, user_id, session_id, message) -> TurnResponse:
    config = {"configurable": {"thread_id": coach_thread_id(user_id, session_id), "checkpoint_ns": ""}}
    state = graph.invoke(
        {"history": [HumanMessage(content=message)], "user_id": user_id, "session_id": session_id},
        config=config,
    )
    return TurnResponse.model_validate(state["turn_response"])


def test_detect_confirm_remember_inject_loop():
    store = FakeStore()
    seen_notes: list[str | None] = []

    def _runner(task: SpecialistTask) -> SpecialistResult:
        seen_notes.append(task.context.notes)
        return SpecialistResult(status="completed", reply_fragment="收到，已了解你的情况。")

    reg = SpecialistRegistry()
    reg.register(SpecialistCard(id="status_insight", description="状态", writes=False), _runner)

    def _draft(_s, _u):
        return ResolverDraft(intents=[IntentHit(specialist_id="status_insight", confidence=0.9)])

    def _extract(_s, _u):
        return MemoryExtraction(
            writes=[
                MemoryWrite(
                    op="add",
                    memory=AthleteMemory(
                        id="", kind="life_event", content="现迁昆明高原训练，海拔~1900m",
                        affects=["pace_target", "training_load"],
                    ),
                )
            ]
        )

    graph = build_orchestrator_graph(
        registry=reg,
        draft_fn=_draft,
        checkpointer=InMemorySaver(),
        memory_store=store,
        memory_extract_fn=_extract,
    )

    # Turn 1: user confirms the move (keyword 搬 passes the pre-filter) → remembered.
    r1 = _invoke(graph, user_id="u1", session_id="s1", message="对，我搬昆明了")
    assert "已记住" in r1.reply
    assert seen_notes[0] is None  # nothing known yet when this turn's specialist ran
    assert store.fetch_active("u1")[0].content.startswith("现迁昆明")

    # Turn 2: the remembered fact is injected into the specialist context.
    _invoke(graph, user_id="u1", session_id="s1", message="那我状态如何")
    assert seen_notes[1] is not None
    assert "昆明" in seen_notes[1]


def test_no_memory_store_is_a_noop():
    """Without a store the pipeline runs exactly as before (S1 spine)."""
    reg = SpecialistRegistry()
    reg.register(
        SpecialistCard(id="status_insight", description="状态", writes=False),
        lambda task: SpecialistResult(status="completed", reply_fragment="好"),
    )
    graph = build_orchestrator_graph(
        registry=reg,
        draft_fn=lambda _s, _u: ResolverDraft(
            intents=[IntentHit(specialist_id="status_insight", confidence=0.9)]
        ),
    )
    r = _invoke(graph, user_id="u1", session_id="s1", message="我搬昆明了")
    assert r.reply == "好"  # no receipt appended
