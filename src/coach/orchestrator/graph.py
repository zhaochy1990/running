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

from typing import Any

from langchain_core.messages import AIMessage
from langgraph.graph import END, START, StateGraph

from coach.contracts import SpecialistRegistry, TargetRef
from .aggregator import SynthFn, aggregate
from .dispatcher import dispatch
from .resolver import ResolverDraftFn, resolve
from .state import (
    OrchestratorState,
    history_to_window,
    last_human_text,
)
from .supervisor import build_call_plan


def build_orchestrator_graph(
    *,
    registry: SpecialistRegistry,
    draft_fn: ResolverDraftFn,
    checkpointer: Any | None = None,
    synth_fn: SynthFn | None = None,
) -> Any:
    """Compile the orchestrator pipeline graph.

    ``checkpointer`` (an ``AzureTableCheckpointSaver`` in prod, ``InMemorySaver``
    in tests, or ``None`` for a stateless single-shot) persists session memory
    keyed by the ``{user}:coach:{session_id}`` thread id supplied at invoke time.
    """

    def _pipeline(state: OrchestratorState) -> dict[str, Any]:
        history = list(state.get("history") or [])
        utterance = last_human_text(history)
        # Window excludes the current utterance (the trailing HumanMessage).
        window = history_to_window(history[:-1]) if history else []

        prior_raw = state.get("active_target")
        prior_target = TargetRef.model_validate(prior_raw) if prior_raw else None

        resolver_output = resolve(
            utterance,
            registry=registry,
            draft_fn=draft_fn,
            conversation_window=window,
            prior_target=prior_target,
        )

        if resolver_output.ambiguity is not None:
            turn_response = aggregate(
                [], resolver_output=resolver_output, utterance=utterance, synth_fn=synth_fn
            )
        else:
            call_plan = build_call_plan(
                resolver_output,
                registry=registry,
                utterance=utterance,
                conversation_window=window,
            )
            dispatched = dispatch(call_plan, registry=registry)
            turn_response = aggregate(
                dispatched,
                resolver_output=resolver_output,
                utterance=utterance,
                synth_fn=synth_fn,
            )

        active_target = (
            resolver_output.active_target.model_dump()
            if resolver_output.active_target is not None
            else None
        )
        return {
            "history": [AIMessage(content=turn_response.reply)],
            "active_target": active_target,
            "turn_response": turn_response.model_dump(),
        }

    graph = StateGraph(OrchestratorState)
    graph.add_node("pipeline", _pipeline)
    graph.add_edge(START, "pipeline")
    graph.add_edge("pipeline", END)
    return graph.compile(checkpointer=checkpointer)
