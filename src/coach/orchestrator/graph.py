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
from typing import Any

from langchain_core.messages import AIMessage
from langgraph.graph import END, START, StateGraph

from coach.contracts import SpecialistRegistry, TargetRef
from .aggregator import SynthFn, aggregate
from .dispatcher import dispatch
from .memory import MemoryExtractFn, MemoryStore, load_active_memories, write_memories
from .resolver import ResolverDraftFn, resolve
from .state import (
    OrchestratorState,
    history_to_window,
    last_human_text,
)
from .supervisor import build_call_plan

logger = logging.getLogger(__name__)


def _ms(since: float) -> float:
    return (time.perf_counter() - since) * 1000.0


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def build_orchestrator_graph(
    *,
    registry: SpecialistRegistry,
    draft_fn: ResolverDraftFn,
    checkpointer: Any | None = None,
    synth_fn: SynthFn | None = None,
    memory_store: MemoryStore | None = None,
    memory_extract_fn: MemoryExtractFn | None = None,
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

        prior_raw = state.get("active_target")
        prior_target = TargetRef.model_validate(prior_raw) if prior_raw else None

        # ⓪ Memory Load — inject active long-term facts into Resolver + specialist.
        user_id = state.get("user_id") or ""
        active_memories: list[Any] = []
        memory_context = ""
        if memory_store is not None and user_id:
            active_memories, memory_context = load_active_memories(memory_store, user_id)
        injected_ids = [m.id for m in active_memories]
        logger.debug(
            "turn start | session=%s | window=%d turns | memories=%d | prior_target=%s | utterance=%r",
            state.get("session_id"),
            len(window),
            len(active_memories),
            prior_raw,
            utterance,
        )

        t_resolve = time.perf_counter()
        resolver_output = resolve(
            utterance,
            registry=registry,
            draft_fn=draft_fn,
            conversation_window=window,
            prior_target=prior_target,
            memory_context=memory_context,
        )
        logger.debug(
            "① resolver %.0fms | intents=%s | compound=%s | target=%s (from %s) | ambiguity=%s",
            _ms(t_resolve),
            [(h.specialist_id, round(h.confidence, 2)) for h in resolver_output.intents],
            resolver_output.is_compound,
            resolver_output.active_target.model_dump(exclude_none=True)
            if resolver_output.active_target
            else None,
            resolver_output.resolved_from,
            resolver_output.ambiguity.kind if resolver_output.ambiguity else None,
        )

        if resolver_output.ambiguity is not None:
            logger.debug("→ clarify short-circuit (no dispatch) | %s", resolver_output.ambiguity.clarification)
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
        return {
            "history": [AIMessage(content=turn_response.reply)],
            "active_target": active_target,
            "turn_response": turn_response.model_dump(),
            "injected_memories": injected_ids,
        }

    graph = StateGraph(OrchestratorState)
    graph.add_node("pipeline", _pipeline)
    graph.add_edge(START, "pipeline")
    graph.add_edge("pipeline", END)
    return graph.compile(checkpointer=checkpointer)
