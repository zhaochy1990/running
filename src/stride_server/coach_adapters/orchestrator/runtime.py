"""Orchestrator assembly — registry + per-turn driver (§4, §8 A1).

Wires the core orchestrator graph to real infrastructure: the specialist
registry (with adapter-built runners), the cheap orchestrator LLM (Resolver),
the strong specialist LLM (generator role), and the session checkpointer.
"""

from __future__ import annotations

import threading
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Iterator

from langchain_core.messages import HumanMessage

from coach.contracts import SpecialistRegistry, TurnResponse
from coach.orchestrator import (
    build_event_recorder_graph,
    build_orchestrator_graph,
    coach_thread_id,
    make_llm_draft_fn,
)
from coach.contracts import CoachEvent
from coach.orchestrator.idempotency import human_message_id
from coach.orchestrator.state import history_to_window
from coach.orchestrator.memory import make_llm_memory_extractor
from coach.orchestrator.resolver import ResolverDraftFn

from coach.contracts import TargetHint, TargetRef
from coach.orchestrator.resolver import TargetResolverFn

from .season_plan import (
    SEASON_PLAN_CARD,
    make_current_master_target_resolver,
    make_season_plan_runner,
    preflight_season_plan_turn,
)
from .status_insight import STATUS_INSIGHT_CARD, make_status_insight_runner
from .weekly_plan import (
    WEEKLY_PLAN_CARD,
    make_current_week_target_resolver,
    make_weekly_plan_runner,
)


@dataclass(frozen=True)
class CoachTurnResult:
    """One orchestrated turn's output for the HTTP layer.

    ``assistant_message`` carries the stable-identity assistant message (message
    id / turn id / created_at / parts) so a client_turn_id replay returns an
    identical payload. ``None`` when no ``client_turn_id`` was supplied.
    """

    turn_response: TurnResponse
    assistant_message: dict[str, Any] | None = None


# ---------------------------------------------------------------------------
# Per-thread serialization — two concurrent turns on the same session run
# strictly in order, so the second turn resolves against the first's committed
# checkpoint (no lost update / interleaved history). Blocking (not fail-fast):
# the later turn waits, it does not 409.
# ---------------------------------------------------------------------------

_THREAD_LOCKS_GUARD = threading.Lock()
_THREAD_LOCKS: dict[str, threading.Lock] = {}


@contextmanager
def coach_turn_lock(thread_id: str) -> Iterator[None]:
    """Serialize turns on one coach thread; the later caller blocks until free."""
    with _THREAD_LOCKS_GUARD:
        lock = _THREAD_LOCKS.setdefault(thread_id, threading.Lock())
    lock.acquire()
    try:
        yield
    finally:
        lock.release()



def build_specialist_registry(
    *,
    user_id: str,
    specialist_llm: Any,
    status_insight_llm: Any | None = None,
) -> SpecialistRegistry:
    """Register the S1 specialist set. Adding a specialist = one more register()."""
    registry = SpecialistRegistry()
    registry.register(
        STATUS_INSIGHT_CARD,
        make_status_insight_runner(
            user_id=user_id,
            llm=status_insight_llm or specialist_llm,
        ),
    )
    registry.register(
        WEEKLY_PLAN_CARD,
        make_weekly_plan_runner(user_id=user_id, llm=specialist_llm),
    )
    registry.register(
        SEASON_PLAN_CARD,
        make_season_plan_runner(user_id=user_id, llm=specialist_llm),
    )
    return registry


def build_target_resolver(user_id: str) -> TargetResolverFn:
    """Resolve master targets or current-week targets for write intents.

    The original hint accompanies the kind-only target so the week resolver can
    distinguish an explicit current week from another unresolved week.
    """
    master_resolver = make_current_master_target_resolver(user_id)
    week_resolver = make_current_week_target_resolver(user_id)

    def _resolve(
        target: TargetRef | None, hint: TargetHint | None
    ) -> TargetRef | None:
        if target is not None and target.kind == "master":
            return master_resolver(target)
        return week_resolver(target, hint)

    return _resolve


def run_coach_turn(
    *,
    user_id: str,
    session_id: str,
    message: str,
    client_turn_id: str | None = None,
    target: TargetRef | None = None,
    draft_fn: ResolverDraftFn | None = None,
    registry: SpecialistRegistry | None = None,
    checkpointer: Any | None = None,
    specialist_llm: Any | None = None,
    status_insight_llm: Any | None = None,
    memory_store: Any | None = None,
    memory_extract_fn: Any | None = None,
) -> CoachTurnResult:
    """Run one orchestrator turn and return the TurnResponse (§8 A1).

    Dependencies default to the process singletons but are all injectable for
    tests. Plan specialists use the generator, status insight uses its optional
    fast model, and the Resolver uses the orchestrator model.

    ``client_turn_id`` makes the turn idempotent (replay-safe). ``target`` is the
    authoritative turn target supplied by the client; when present it seeds the
    graph's ``active_target`` so this turn binds to it regardless of anaphora.
    """
    from stride_server.coach_runtime import (
        get_athlete_memory_store,
        get_checkpointer,
        get_generator_llm,
        get_orchestrator_llm,
        get_status_insight_llm,
    )

    resolved_checkpointer = checkpointer or get_checkpointer()
    thread_id = coach_thread_id(user_id, session_id)
    config = {"configurable": {"thread_id": thread_id, "checkpoint_ns": ""}}

    def _seed(extra: dict[str, Any] | None = None) -> dict[str, Any]:
        human = HumanMessage(content=message)
        if client_turn_id is not None:
            # Stable human id so a replay of this turn overwrites (not appends)
            # the prior row via add_messages.
            human.id = human_message_id(client_turn_id)
        seed: dict[str, Any] = {
            "history": [human],
            "user_id": user_id,
            "session_id": session_id,
        }
        if client_turn_id is not None:
            seed["client_turn_id"] = client_turn_id
        if target is not None:
            # Authoritative target for this turn: seeds active_target (binding)
            # AND request_target (idempotency fingerprint input).
            seed["active_target"] = target.model_dump()
            seed["request_target"] = target.model_dump()
        if extra:
            seed.update(extra)
        return seed

    def _result(state: dict[str, Any]) -> CoachTurnResult:
        raw = state.get("turn_response")
        if raw is None:
            # OrchestratorState is total=False; the pipeline always sets this, so
            # a missing value means the graph degraded — surface it explicitly.
            raise RuntimeError("orchestrator pipeline produced no turn_response")
        return CoachTurnResult(
            turn_response=TurnResponse.model_validate(raw),
            assistant_message=state.get("assistant_message"),
        )

    # Serialize turns on this thread: a concurrent second turn blocks here until
    # the first commits its checkpoint, so it always resolves against the latest
    # state (no lost update / interleaved history).
    with coach_turn_lock(thread_id):
        # Run the deterministic master-adjustment clarification gate before any
        # LLM singleton/provider or athlete memory/toolkit is constructed. Read
        # the existing checkpoint only to recover the conversation window.
        checkpoint_tuple = resolved_checkpointer.get_tuple(config)
        checkpoint = checkpoint_tuple.checkpoint if checkpoint_tuple is not None else {}
        prior_history = (checkpoint.get("channel_values") or {}).get("history") or []
        preflight = preflight_season_plan_turn(message, history_to_window(prior_history))
        if preflight is not None:
            preflight_graph = build_orchestrator_graph(
                registry=SpecialistRegistry(),
                draft_fn=lambda _system, _user: (_ for _ in ()).throw(
                    AssertionError("resolver must not run on a preflight turn")
                ),
                checkpointer=resolved_checkpointer,
                turn_preflight_fn=preflight_season_plan_turn,
            )
            state = preflight_graph.invoke(_seed(), config=config)
            return _result(state)

        resolved_specialist_llm = specialist_llm or get_generator_llm()
        resolved_status_llm = status_insight_llm or (
            specialist_llm if specialist_llm is not None else get_status_insight_llm()
        )
        resolved_registry = registry or build_specialist_registry(
            user_id=user_id,
            specialist_llm=resolved_specialist_llm,
            status_insight_llm=resolved_status_llm,
        )
        orchestrator_llm = None
        if draft_fn is None or memory_extract_fn is None:
            orchestrator_llm = get_orchestrator_llm()
        resolved_draft_fn = draft_fn or make_llm_draft_fn(orchestrator_llm)
        resolved_store = memory_store or get_athlete_memory_store()
        resolved_extract_fn = memory_extract_fn or make_llm_memory_extractor(
            orchestrator_llm
        )

        graph = build_orchestrator_graph(
            registry=resolved_registry,
            draft_fn=resolved_draft_fn,
            checkpointer=resolved_checkpointer,
            memory_store=resolved_store,
            memory_extract_fn=resolved_extract_fn,
            target_resolver=build_target_resolver(user_id),
            turn_preflight_fn=preflight_season_plan_turn,
        )
        state = graph.invoke(_seed(), config=config)
        return _result(state)


# ---------------------------------------------------------------------------
# Trusted events — applied / abandoned receipts recorded on the coach thread.
# ---------------------------------------------------------------------------

DEFAULT_EVENT_SESSION_ID = "web-default"


def record_coach_event(
    *,
    user_id: str,
    event: CoachEvent,
    session_id: str = DEFAULT_EVENT_SESSION_ID,
    checkpointer: Any | None = None,
) -> None:
    """Append a trusted ``CoachEvent`` to the user's coach thread.

    Recorded on the dedicated ``events`` checkpoint channel (never disguised as
    a message turn) so it surfaces as a ``role="event"`` history row and can be
    projected into later orchestrator context. Serialised under the same
    per-thread lock as chat turns so an event can't interleave with a turn.
    """
    from stride_server.coach_runtime import get_checkpointer

    resolved_checkpointer = checkpointer or get_checkpointer()
    thread_id = coach_thread_id(user_id, session_id)
    config = {"configurable": {"thread_id": thread_id, "checkpoint_ns": ""}}
    graph = build_event_recorder_graph(checkpointer=resolved_checkpointer)
    with coach_turn_lock(thread_id):
        graph.invoke(
            {
                "user_id": user_id,
                "session_id": session_id,
                "events": [event.model_dump()],
            },
            config=config,
        )
