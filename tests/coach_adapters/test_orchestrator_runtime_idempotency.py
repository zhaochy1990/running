"""Runtime-level idempotency + serialization for run_coach_turn (§ backend).

Drives the real adapter driver (graph + checkpointer + stable identity) with
injected fakes — no live LLM/DB — so the HTTP layer's replay guarantees are
exercised end-to-end below the route.
"""

from __future__ import annotations

import threading

from langgraph.checkpoint.memory import InMemorySaver

from coach.contracts import (
    IntentHit,
    ResolverDraft,
    SpecialistCard,
    SpecialistRegistry,
    SpecialistResult,
    SpecialistTask,
    TargetRef,
)
from stride_server.coach_adapters.orchestrator.runtime import (
    CoachTurnResult,
    run_coach_turn,
)


class _MemoryStore:
    def fetch_active(self, user_id, *, top_k: int = 10):
        return []


def _registry(calls: list[str]) -> SpecialistRegistry:
    reg = SpecialistRegistry()

    def _runner(task: SpecialistTask) -> SpecialistResult:
        calls.append(task.objective)
        return SpecialistResult(status="completed", reply_fragment=f"诊断{len(calls)}")

    reg.register(SpecialistCard(id="status_insight", description="状态", writes=False), _runner)
    return reg


def _draft(_s: str, _u: str) -> ResolverDraft:
    return ResolverDraft(
        intents=[IntentHit(specialist_id="status_insight", action="read", confidence=0.95)]
    )


def _run(
    *, message, client_turn_id, checkpointer, calls,
    target=None, review_context=None, registry=None,
):
    return run_coach_turn(
        user_id="11111111-2222-4aaa-89ab-123456789012",
        session_id="web-default",
        message=message,
        client_turn_id=client_turn_id,
        target=target,
        review_context=review_context,
        draft_fn=_draft,
        registry=registry or _registry(calls),
        checkpointer=checkpointer,
        specialist_llm=object(),
        status_insight_llm=object(),
        memory_store=_MemoryStore(),
        memory_extract_fn=lambda **_k: [],
    )


def test_run_coach_turn_returns_coach_turn_result_with_assistant_message() -> None:
    calls: list[str] = []
    cp = InMemorySaver()
    res = _run(message="我状态如何", client_turn_id="t-1", checkpointer=cp, calls=calls)
    assert isinstance(res, CoachTurnResult)
    assert res.assistant_message is not None
    assert res.assistant_message["turn_id"] == "t-1"
    assert res.assistant_message["message_id"] == "t-1:a"


def test_replay_runs_model_once_and_returns_identical_assistant_message() -> None:
    calls: list[str] = []
    cp = InMemorySaver()
    r1 = _run(message="我状态如何", client_turn_id="t-1", checkpointer=cp, calls=calls)
    r2 = _run(message="我状态如何", client_turn_id="t-1", checkpointer=cp, calls=calls)
    assert len(calls) == 1  # model ran once
    assert r1.assistant_message == r2.assistant_message
    assert r1.turn_response.reply == r2.turn_response.reply


def _tasks_registry(tasks: list[SpecialistTask]) -> SpecialistRegistry:
    reg = SpecialistRegistry()

    def _runner(task: SpecialistTask) -> SpecialistResult:
        tasks.append(task)
        return SpecialistResult(status="completed", reply_fragment="ok")

    reg.register(SpecialistCard(id="status_insight", description="状态", writes=False), _runner)
    return reg


def test_review_context_is_cleared_on_a_following_ordinary_turn() -> None:
    """Turn-scoped request inputs must not linger in the checkpoint."""
    tasks: list[SpecialistTask] = []
    cp = InMemorySaver()
    review_context = {
        "kind": "weekly_create",
        "proposal": {"folder": "2026-07-20_07-26", "plan": {"week_folder": "2026-07-20_07-26"}},
    }
    # Turn 1: a review turn carries the draft into the specialist task.
    _run(
        message="这个课表的训练逻辑是什么",
        client_turn_id="t-1",
        checkpointer=cp,
        calls=[],
        target=TargetRef(kind="week", folder="2026-07-20_07-26"),
        review_context=review_context,
        registry=_tasks_registry(tasks),
    )
    assert tasks[-1].context.data.get("review_context") == review_context
    # Turn 2: an ordinary turn on the SAME session must not inherit the draft.
    _run(
        message="我最近状态如何",
        client_turn_id="t-2",
        checkpointer=cp,
        calls=[],
        review_context=None,
        registry=_tasks_registry(tasks),
    )
    assert tasks[-1].context.data == {}
    assert tasks[-1].active_target == TargetRef(
        kind="week", folder="2026-07-20_07-26"
    )


def test_concurrent_same_thread_turns_run_serially() -> None:
    # Two turns on the same thread fired concurrently must not interleave; the
    # blocking lock serialises them and both complete without error.
    cp = InMemorySaver()
    results: list[object] = []
    errors: list[BaseException] = []

    def _worker(msg: str, tid: str) -> None:
        try:
            results.append(
                _run(message=msg, client_turn_id=tid, checkpointer=cp, calls=[])
            )
        except BaseException as exc:  # noqa: BLE001 — record for assertion
            errors.append(exc)

    t1 = threading.Thread(target=_worker, args=("第一问", "t-1"))
    t2 = threading.Thread(target=_worker, args=("第二问", "t-2"))
    t1.start(); t2.start(); t1.join(); t2.join()

    assert not errors, errors
    assert len(results) == 2
