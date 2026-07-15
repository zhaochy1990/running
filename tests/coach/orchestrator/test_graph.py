"""S1g — orchestrator graph: end-to-end spine + session memory (§4, §5.1)."""

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
    TargetHint,
    TurnResponse,
)
from coach.orchestrator import build_orchestrator_graph, coach_thread_id


def _registry(runner) -> SpecialistRegistry:
    reg = SpecialistRegistry()
    reg.register(
        SpecialistCard(id="status_insight", description="状态诊断", writes=False),
        runner,
    )
    return reg


def _echo_runner(task: SpecialistTask) -> SpecialistResult:
    # Echo the window length so we can prove session memory reached the specialist.
    return SpecialistResult(
        status="completed",
        reply_fragment=f"诊断结果（窗口 {len(task.conversation_window)} 轮）：{task.objective}",
    )


def _draft_fn_status(_system: str, _user: str) -> ResolverDraft:
    return ResolverDraft(intents=[IntentHit(specialist_id="status_insight", action="read", confidence=0.95)])


def _invoke(graph, *, user_id: str, session_id: str, message: str) -> TurnResponse:
    config = {"configurable": {"thread_id": coach_thread_id(user_id, session_id), "checkpoint_ns": ""}}
    state = graph.invoke(
        {"history": [HumanMessage(content=message)], "user_id": user_id, "session_id": session_id},
        config=config,
    )
    return TurnResponse.model_validate(state["turn_response"])


def test_single_turn_spine_end_to_end() -> None:
    graph = build_orchestrator_graph(registry=_registry(_echo_runner), draft_fn=_draft_fn_status)
    resp = _invoke(graph, user_id="u1", session_id="s1", message="我最近状态如何")
    assert resp.clarification is None
    assert "我最近状态如何" in resp.reply
    assert "窗口 0 轮" in resp.reply  # first turn: empty window


def test_session_memory_accumulates_across_turns() -> None:
    graph = build_orchestrator_graph(
        registry=_registry(_echo_runner),
        draft_fn=_draft_fn_status,
        checkpointer=InMemorySaver(),
    )
    _invoke(graph, user_id="u1", session_id="s1", message="第一句")
    resp2 = _invoke(graph, user_id="u1", session_id="s1", message="第二句")
    # Turn 2's window holds turn 1's user + assistant messages (2 turns).
    assert "窗口 2 轮" in resp2.reply


def test_separate_sessions_do_not_share_memory() -> None:
    graph = build_orchestrator_graph(
        registry=_registry(_echo_runner),
        draft_fn=_draft_fn_status,
        checkpointer=InMemorySaver(),
    )
    _invoke(graph, user_id="u1", session_id="s1", message="s1 第一句")
    resp = _invoke(graph, user_id="u1", session_id="s2", message="s2 第一句")
    assert "窗口 0 轮" in resp.reply  # fresh session, empty window


def test_anaphora_reuses_promoted_active_target() -> None:
    seen_targets: list[object] = []

    def _runner(task: SpecialistTask) -> SpecialistResult:
        seen_targets.append(task.active_target)
        return SpecialistResult(status="completed", reply_fragment="ok")

    # Turn 1 mentions a master plan explicitly; turn 2 says "它" (anaphora).
    drafts = iter(
        [
            ResolverDraft(
                intents=[IntentHit(specialist_id="status_insight", action="read", confidence=0.9)],
                target_hint=TargetHint(kind="master", ref_phrase="赛季计划"),
            ),
            ResolverDraft(
                intents=[IntentHit(specialist_id="status_insight", action="read", confidence=0.9)],
                target_hint=TargetHint(is_anaphora=True, ref_phrase="它"),
            ),
        ]
    )

    def _draft_fn(_s: str, _u: str) -> ResolverDraft:
        return next(drafts)

    graph = build_orchestrator_graph(
        registry=_registry(_runner), draft_fn=_draft_fn, checkpointer=InMemorySaver()
    )
    _invoke(graph, user_id="u1", session_id="s1", message="赛季计划怎么样")
    _invoke(graph, user_id="u1", session_id="s1", message="它现在如何")
    # Both turns saw the same master target — turn 2 resolved "它" from turn 1.
    assert seen_targets[0] is not None
    assert seen_targets[0].kind == "master"
    assert seen_targets[1] == seen_targets[0]


def test_clarify_turn_short_circuits_no_dispatch() -> None:
    def _boom(task: SpecialistTask) -> SpecialistResult:
        raise AssertionError("specialist must not run on a clarify turn")

    def _draft_low(_s: str, _u: str) -> ResolverDraft:
        return ResolverDraft(intents=[IntentHit(specialist_id="status_insight", action="read", confidence=0.1)])

    graph = build_orchestrator_graph(registry=_registry(_boom), draft_fn=_draft_low)
    resp = _invoke(graph, user_id="u1", session_id="s1", message="嗯")
    assert resp.clarification is not None
    assert resp.proposals == []
