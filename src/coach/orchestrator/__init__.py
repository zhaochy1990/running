"""Coach orchestrator brain (§4) — Resolver / Supervisor / dispatcher / Aggregator.

Pure core: the LLM-bearing nodes take injected callables so the orchestration
logic is unit-testable without a live model, and adapters supply the real LLMs +
specialist runners.
"""

from __future__ import annotations

from .resolver import (
    build_resolver_system_prompt,
    build_resolver_user_prompt,
    make_llm_draft_fn,
    render_card_catalog,
    resolve,
)
from .supervisor import build_call_plan, build_specialist_task
from .dispatcher import DispatchResult, dispatch
from .aggregator import SynthFn, aggregate
from .state import OrchestratorState, coach_thread_id, history_to_window, last_human_text
from .graph import build_orchestrator_graph

__all__ = [
    # resolver
    "build_resolver_system_prompt",
    "build_resolver_user_prompt",
    "make_llm_draft_fn",
    "render_card_catalog",
    "resolve",
    # supervisor
    "build_call_plan",
    "build_specialist_task",
    # dispatcher
    "DispatchResult",
    "dispatch",
    # aggregator
    "SynthFn",
    "aggregate",
    # state + graph
    "OrchestratorState",
    "coach_thread_id",
    "history_to_window",
    "last_human_text",
    "build_orchestrator_graph",
]
