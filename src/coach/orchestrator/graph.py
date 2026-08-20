"""Orchestrator graph — the §4 pipeline as a checkpointed LangGraph.

Wires ⓪ Memory Load → ① Resolver → ② Supervisor → ③ dispatch → ④ Aggregator
into a single pipeline node over :class:`OrchestratorState`. The graph is pure
(core layer): the LLM (``draft_fn`` / ``synth_fn``), the ``registry`` (with its
adapter-built runners) and the ``checkpointer`` are all injected, so the
orchestration logic is unit-testable without infrastructure.

Memory Writer (⑤) and the compound Supervisor/dispatcher slow paths are deferred
to later slices (S4 / S2); S1 is the single-intent spine.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from collections.abc import Callable
from typing import Any

from langchain_core.messages import AIMessage
from langgraph.graph import END, START, StateGraph

from coach.contracts import SpecialistRegistry, TargetRef, Turn, TurnResponse
from .aggregator import SynthFn, aggregate
from .dispatcher import dispatch
from .idempotency import (
    append_receipt,
    assistant_message_id,
    request_fingerprint,
    resolve_replay,
)
from .memory import MemoryExtractFn, MemoryStore, load_active_memories, write_memories
from .resolver import ResolverDraftFn, TargetResolverFn, resolve
from .state import (
    OrchestratorState,
    history_to_window,
    last_human_text,
)
from .supervisor import build_call_plan

logger = logging.getLogger(__name__)

TurnPreflightFn = Callable[[str, list[Turn]], TurnResponse | None]


def _ms(since: float) -> float:
    return (time.perf_counter() - since) * 1000.0


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _events_context(events: list[dict[str, Any]], *, limit: int = 5) -> str:
    """Compact natural-language projection of the most recent trusted events.

    Surfaces what the user actually committed to (applied / abandoned a
    proposal) so the coach doesn't re-propose something just done or dropped.
    """
    if not events:
        return ""
    recent = events[-limit:]
    lines = ["# 最近的计划操作回执"]
    for ev in recent:
        summary = str(ev.get("summary") or ev.get("type") or "")
        status = str(ev.get("status") or "")
        lines.append(f"- [{status}] {summary}".rstrip())
    return "\n".join(lines)


def _build_assistant_message(
    *, reply: str, message_id: str, turn_id: str, created_at: str
) -> dict[str, Any]:
    """The stable-identity assistant message dict surfaced to the HTTP layer.

    Kept as a plain dict (core layer) so the route/runtime can return an
    identical payload on the first run and on any replay.
    """
    parts = [{"kind": "text", "text": reply}] if reply else []
    return {
        "role": "assistant",
        "message_id": message_id,
        "turn_id": turn_id,
        "created_at": created_at,
        "parts": parts,
    }


def build_orchestrator_graph(
    *,
    registry: SpecialistRegistry,
    draft_fn: ResolverDraftFn,
    checkpointer: Any | None = None,
    synth_fn: SynthFn | None = None,
    memory_store: MemoryStore | None = None,
    memory_extract_fn: MemoryExtractFn | None = None,
    target_resolver: TargetResolverFn | None = None,
    turn_preflight_fn: TurnPreflightFn | None = None,
) -> Any:
    """Compile the orchestrator pipeline graph.

    ``checkpointer`` (an ``AzureTableCheckpointSaver`` in prod, ``InMemorySaver``
    in tests, or ``None`` for a stateless single-shot) persists session memory
    keyed by the ``{user}:coach:{session_id}`` thread id supplied at invoke time.
    """

    def _pipeline(state: OrchestratorState) -> dict[str, Any]:
        t0 = time.perf_counter()
        history = list(state.get("history") or [])
        utterance = last_human_text(history)
        # Window excludes the current utterance (the trailing HumanMessage).
        window = history_to_window(history[:-1]) if history else []

        # Idempotency: a replay of the same client_turn_id + same request returns
        # the stored turn output (including stable message identity) without
        # re-invoking the model. A reuse with a different request raises
        # TurnConflictError (surfaced as 409 upstream). The fingerprint is keyed
        # on the *request* target the client sent this turn, never the promoted
        # active_target (which the pipeline mutates).
        client_turn_id = state.get("client_turn_id")
        receipts = list(state.get("turn_receipts") or [])
        request_context = state.get("request_context")
        fingerprint = ""
        if client_turn_id:
            fingerprint = request_fingerprint(
                message=utterance,
                request_target=state.get("request_target"),
                request_context=request_context,
            )
            receipt = resolve_replay(
                receipts, client_turn_id=client_turn_id, fingerprint=fingerprint
            )
            if receipt is not None:
                replayed = receipt.get("turn_response") or {}
                replayed_reply = str(replayed.get("reply") or "")
                aid = assistant_message_id(client_turn_id)
                created_at = str(receipt.get("created_at") or "")
                # Re-emit the SAME assistant id so add_messages replaces (not
                # appends) the prior row — history stays de-duplicated.
                return {
                    "history": [AIMessage(content=replayed_reply, id=aid)],
                    "active_target": (replayed.get("active_target") or None),
                    "turn_response": replayed,
                    "assistant_message": _build_assistant_message(
                        reply=replayed_reply,
                        message_id=str(receipt.get("message_id") or aid),
                        turn_id=client_turn_id,
                        created_at=created_at,
                    ),
                    "injected_memories": [],
                    "turn_receipts": receipts,
                }

        def _finish(result: dict[str, Any]) -> dict[str, Any]:
            """Attach stable message identity + an idempotency receipt."""
            reply = str((result.get("turn_response") or {}).get("reply") or "")
            if client_turn_id:
                aid = assistant_message_id(client_turn_id)
                created_at = _now_iso()
                # Tag the emitted assistant message with a stable id so a later
                # replay overwrites this row instead of appending a copy.
                new_history = result.get("history") or []
                result["history"] = [
                    (m.model_copy(update={"id": aid}) if isinstance(m, AIMessage) else m)
                    for m in new_history
                ]
                result["assistant_message"] = _build_assistant_message(
                    reply=reply,
                    message_id=aid,
                    turn_id=client_turn_id,
                    created_at=created_at,
                )
                result["turn_receipts"] = append_receipt(
                    receipts,
                    client_turn_id=client_turn_id,
                    fingerprint=fingerprint,
                    turn_response=result.get("turn_response") or {},
                    message_id=aid,
                    created_at=created_at,
                )
            return result


        # Adapter-provided deterministic gates may answer before any memory,
        # target, data, or specialist access. The response still enters graph
        # history, so the next turn can resume the clarification naturally.
        if turn_preflight_fn is not None:
            preflight = turn_preflight_fn(utterance, window)
            if preflight is not None:
                return _finish({
                    "history": [AIMessage(content=preflight.reply)],
                    "active_target": (
                        preflight.active_target.model_dump()
                        if preflight.active_target is not None
                        else None
                    ),
                    "turn_response": preflight.model_dump(),
                    "injected_memories": [],
                })

        prior_raw = state.get("active_target")
        prior_target = TargetRef.model_validate(prior_raw) if prior_raw else None

        # ⓪ Memory Load — inject active long-term facts into Resolver + specialist.
        user_id = state.get("user_id") or ""
        active_memories: list[Any] = []
        memory_context = ""
        if memory_store is not None and user_id:
            active_memories, memory_context = load_active_memories(memory_store, user_id)
        # Project trusted events (applied / abandoned) into context so the coach
        # knows what the user actually committed to. Kept compact (last few).
        events_context = _events_context(state.get("events") or [])
        if events_context:
            memory_context = (
                f"{memory_context}\n{events_context}" if memory_context else events_context
            )
        injected_ids = [m.id for m in active_memories]
        logger.debug(
            "turn start | window=%d turns | memories=%d | prior_target_kind=%s "
            "| utterance_chars=%d",
            len(window),
            len(active_memories),
            prior_target.kind if prior_target else None,
            len(utterance),
        )

        t_resolve = time.perf_counter()
        resolver_output = resolve(
            utterance,
            registry=registry,
            draft_fn=draft_fn,
            conversation_window=window,
            prior_target=prior_target,
            memory_context=memory_context,
            review_context=request_context,
            target_resolver=target_resolver,
        )
        logger.debug(
            "① resolver %.0fms | intents=%s | compound=%s | target_kind=%s "
            "(from %s) | ambiguity=%s",
            _ms(t_resolve),
            [(h.specialist_id, round(h.confidence, 2)) for h in resolver_output.intents],
            resolver_output.is_compound,
            resolver_output.active_target.kind
            if resolver_output.active_target
            else None,
            resolver_output.resolved_from,
            resolver_output.ambiguity.kind if resolver_output.ambiguity else None,
        )

        if resolver_output.ambiguity is not None:
            logger.debug(
                "→ clarify short-circuit (no dispatch) | clarification_chars=%d",
                len(resolver_output.ambiguity.clarification),
            )
            turn_response = aggregate(
                [], resolver_output=resolver_output, utterance=utterance, synth_fn=synth_fn
            )
        else:
            t_plan = time.perf_counter()
            call_plan = build_call_plan(
                resolver_output,
                registry=registry,
                utterance=utterance,
                conversation_window=window,
                memory_context=memory_context,
                review_context=request_context,
            )
            logger.debug(
                "② supervisor %.0fms | call_plan=%s",
                _ms(t_plan),
                [c.specialist_id for c in call_plan.calls],
            )
            t_disp = time.perf_counter()
            dispatched = dispatch(call_plan, registry=registry)
            logger.debug(
                "③ dispatch %.0fms | results=%s",
                _ms(t_disp),
                [
                    (d.specialist_id, d.result.status, f"{len(d.result.reply_fragment)}c")
                    for d in dispatched
                ],
            )
            t_agg = time.perf_counter()
            turn_response = aggregate(
                dispatched,
                resolver_output=resolver_output,
                utterance=utterance,
                synth_fn=synth_fn,
            )
            logger.debug(
                "④ aggregate %.0fms | reply=%dc | proposals=%d | clarify=%s",
                _ms(t_agg),
                len(turn_response.reply),
                len(turn_response.proposals),
                turn_response.clarification is not None,
            )

        # ⑤ Memory Writer — pre-filter → extract → dedup → persist → receipt.
        if memory_store is not None and memory_extract_fn is not None and user_id:
            conversation_text = f"用户：{utterance}\n教练：{turn_response.reply}"
            applied, receipt = write_memories(
                memory_store,
                memory_extract_fn,
                user_id=user_id,
                session_id=state.get("session_id") or "",
                user_text=utterance,  # gate on the user turn, not the coach reply
                conversation_text=conversation_text,
                active=active_memories,
                now=_now_iso(),
            )
            if receipt:
                turn_response = turn_response.model_copy(
                    update={"reply": turn_response.reply + receipt}
                )
            if applied:
                logger.debug("⑤ memory writer | %d new fact(s) persisted", len(applied))

        logger.debug("turn done | total %.0fms", _ms(t0))

        active_target = (
            resolver_output.active_target.model_dump()
            if resolver_output.active_target is not None
            else None
        )
        return _finish({
            "history": [AIMessage(content=turn_response.reply)],
            "active_target": active_target,
            "turn_response": turn_response.model_dump(),
            "injected_memories": injected_ids,
        })

    graph = StateGraph(OrchestratorState)
    graph.add_node("pipeline", _pipeline)
    graph.add_edge(START, "pipeline")
    graph.add_edge("pipeline", END)
    return graph.compile(checkpointer=checkpointer)


def build_event_recorder_graph(*, checkpointer: Any | None = None) -> Any:
    """A minimal graph that appends a trusted CoachEvent to a thread's state.

    Uses langgraph's own checkpoint mechanism (not a hand-built ``put``) so the
    event lands durably on the same thread the chat turns use. The event goes on
    the dedicated ``events`` channel — never disguised as a message turn.
    """

    def _record(state: OrchestratorState) -> dict[str, Any]:
        # The caller seeds a single-item ``events`` list on invoke; langgraph's
        # append reducer merges it into the persisted list before this node runs.
        # Nothing else to compute — the event is already recorded.
        return {}

    graph = StateGraph(OrchestratorState)
    graph.add_node("record", _record)
    graph.add_edge(START, "record")
    graph.add_edge("record", END)
    return graph.compile(checkpointer=checkpointer)
