"""Orchestrator idempotency — client_turn_id turn receipts (§ backend contract).

A ``client_turn_id`` makes one logical turn safe to retry after a dropped
connection: the same id + same request replays the stored ``TurnResponse``
without re-invoking the model; the same id + a *different* request is a client
bug and raises a conflict. Receipts live in the checkpointed graph state (last
``MAX_TURN_RECEIPTS``), so no new persistence backend is introduced.
"""

from __future__ import annotations

from langchain_core.messages import HumanMessage
from langgraph.checkpoint.memory import InMemorySaver

import pytest

from coach.contracts import (
    IntentHit,
    ResolverDraft,
    SpecialistCard,
    SpecialistRegistry,
    SpecialistResult,
    SpecialistTask,
    TargetHint,
    TargetRef,
    TurnResponse,
)
from coach.orchestrator import build_orchestrator_graph, coach_thread_id
from coach.orchestrator.idempotency import TurnConflictError


def _registry(runner) -> SpecialistRegistry:
    reg = SpecialistRegistry()
    reg.register(
        SpecialistCard(id="status_insight", description="状态诊断", writes=False),
        runner,
    )
    return reg


def _draft(_s: str, _u: str) -> ResolverDraft:
    return ResolverDraft(
        intents=[IntentHit(specialist_id="status_insight", action="read", confidence=0.95)]
    )


def _invoke(graph, *, message, client_turn_id, calls, session_id="s1"):
    return _invoke_state(
        graph, message=message, client_turn_id=client_turn_id, session_id=session_id
    )["turn_response_model"]


def _invoke_state(graph, *, message, client_turn_id, session_id="s1", target=None, review_context=None):
    config = {"configurable": {"thread_id": coach_thread_id("u1", session_id), "checkpoint_ns": ""}}
    # Mirror the adapter: a stable human id keyed on client_turn_id so a replay
    # overwrites the row via add_messages instead of appending a duplicate.
    human = HumanMessage(content=message)
    human.id = f"{client_turn_id}:u"
    seed = {
        "history": [human],
        "user_id": "u1",
        "session_id": session_id,
        "client_turn_id": client_turn_id,
    }
    if target is not None:
        seed["request_target"] = target
    if review_context is not None:
        seed["request_context"] = review_context
    state = graph.invoke(seed, config=config)
    return {
        **state,
        "turn_response_model": TurnResponse.model_validate(state["turn_response"]),
    }


def _graph(calls):
    def _runner(task: SpecialistTask) -> SpecialistResult:
        calls.append(task.objective)
        return SpecialistResult(status="completed", reply_fragment=f"诊断{len(calls)}")

    return build_orchestrator_graph(
        registry=_registry(_runner),
        draft_fn=_draft,
        checkpointer=InMemorySaver(),
    )


def test_same_turn_id_same_request_replays_without_model() -> None:
    calls: list[str] = []
    graph = _graph(calls)
    r1 = _invoke(graph, message="我状态如何", client_turn_id="t-1", calls=calls)
    r2 = _invoke(graph, message="我状态如何", client_turn_id="t-1", calls=calls)
    # Second call is a replay: specialist ran exactly once, reply is identical.
    assert len(calls) == 1
    assert r1.reply == r2.reply


def test_same_turn_id_different_request_conflicts() -> None:
    calls: list[str] = []
    graph = _graph(calls)
    _invoke(graph, message="我状态如何", client_turn_id="t-1", calls=calls)
    with pytest.raises(TurnConflictError):
        _invoke(graph, message="完全不同的问题", client_turn_id="t-1", calls=calls)


def test_distinct_turn_ids_each_run_the_model() -> None:
    calls: list[str] = []
    graph = _graph(calls)
    _invoke(graph, message="第一问", client_turn_id="t-1", calls=calls)
    _invoke(graph, message="第二问", client_turn_id="t-2", calls=calls)
    assert len(calls) == 2


def test_replay_does_not_duplicate_history() -> None:
    calls: list[str] = []
    graph = _graph(calls)
    s1 = _invoke_state(graph, message="我状态如何", client_turn_id="t-1")
    s2 = _invoke_state(graph, message="我状态如何", client_turn_id="t-1")
    # Stable ids mean add_messages replaces rows; history length is unchanged.
    assert len(s1["history"]) == len(s2["history"])
    # Exactly one user + one assistant row for the turn.
    assert len(s2["history"]) == 2


def test_replay_returns_identical_assistant_message() -> None:
    calls: list[str] = []
    graph = _graph(calls)
    s1 = _invoke_state(graph, message="我状态如何", client_turn_id="t-1")
    s2 = _invoke_state(graph, message="我状态如何", client_turn_id="t-1")
    assert s1["assistant_message"] == s2["assistant_message"]
    assert s1["assistant_message"]["message_id"] == "t-1:a"


def test_same_turn_id_same_context_replays_without_model() -> None:
    ctx = {"kind": "weekly_create", "proposal": {"folder": "2026-W26"}}
    calls: list[str] = []
    graph = _graph(calls)
    s1 = _invoke_state(graph, message="讲讲这个课表", client_turn_id="t-1", review_context=ctx)
    s2 = _invoke_state(graph, message="讲讲这个课表", client_turn_id="t-1", review_context=ctx)
    assert len(calls) == 1
    assert (
        TurnResponse.model_validate(s1["turn_response"]).reply
        == TurnResponse.model_validate(s2["turn_response"]).reply
    )


def test_same_turn_id_different_context_conflicts() -> None:
    calls: list[str] = []
    graph = _graph(calls)
    _invoke_state(
        graph,
        message="讲讲这个课表",
        client_turn_id="t-1",
        review_context={"kind": "weekly_create", "proposal": {"folder": "2026-W26"}},
    )
    with pytest.raises(TurnConflictError):
        _invoke_state(
            graph,
            message="讲讲这个课表",
            client_turn_id="t-1",
            review_context={"kind": "weekly_create", "proposal": {"folder": "2026-W40"}},
        )


def test_adding_context_to_same_turn_id_conflicts() -> None:
    """A turn first sent without context, replayed with one, is a conflict."""
    calls: list[str] = []
    graph = _graph(calls)
    _invoke_state(graph, message="讲讲这个课表", client_turn_id="t-1")
    with pytest.raises(TurnConflictError):
        _invoke_state(
            graph,
            message="讲讲这个课表",
            client_turn_id="t-1",
            review_context={"kind": "weekly_create", "proposal": {"folder": "2026-W26"}},
        )
    # The first turn ran the model once; the conflicting replay never re-ran it.
    assert len(calls) == 1


def test_fingerprint_uses_request_target_not_promoted_active_target() -> None:
    # Turn 1 resolves a target that the pipeline promotes into active_target.
    # A replay with the same request (no explicit request_target) must NOT
    # conflict just because active_target now differs from its turn-1 value.
    seen: list[object] = []

    def _runner(task: SpecialistTask) -> SpecialistResult:
        seen.append(task.active_target)
        return SpecialistResult(status="completed", reply_fragment="ok")

    drafts = iter(
        [
            ResolverDraft(
                intents=[IntentHit(specialist_id="status_insight", action="read", confidence=0.9)],
                target_hint=TargetHint(kind="master", ref_phrase="赛季计划"),
            ),
            ResolverDraft(
                intents=[IntentHit(specialist_id="status_insight", action="read", confidence=0.9)],
                target_hint=TargetHint(kind="master", ref_phrase="赛季计划"),
            ),
        ]
    )
    target = TargetRef(kind="master", plan_id="p1")
    graph = build_orchestrator_graph(
        registry=_registry(_runner),
        draft_fn=lambda _s, _u: next(drafts),
        target_resolver=lambda _t, _h: target,
        checkpointer=InMemorySaver(),
    )
    _invoke_state(graph, message="赛季计划如何", client_turn_id="t-1")
    # No conflict raised → replay recognised despite active_target being promoted.
    s2 = _invoke_state(graph, message="赛季计划如何", client_turn_id="t-1")
    assert s2["turn_response_model"].reply == "ok"
    assert len(seen) == 1  # ran once; second was a replay
