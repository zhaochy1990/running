"""Orchestrator assembly — registry + per-turn driver (§4, §8 A1).

Wires the core orchestrator graph to real infrastructure: the specialist
registry (with adapter-built runners), the cheap orchestrator LLM (Resolver),
the strong specialist LLM (generator role), and the session checkpointer.
"""

from __future__ import annotations

from typing import Any

from langchain_core.messages import HumanMessage

from coach.contracts import SpecialistRegistry, TurnResponse
from coach.orchestrator import (
    build_orchestrator_graph,
    coach_thread_id,
    make_llm_draft_fn,
)
from coach.orchestrator.memory import make_llm_memory_extractor
from coach.orchestrator.resolver import ResolverDraftFn

from coach.contracts import TargetHint, TargetRef
from coach.orchestrator.resolver import TargetResolverFn

from ..toolkit import build_stride_toolkit
from .season_plan import (
    SEASON_PLAN_CARD,
    make_current_master_target_resolver,
    make_season_plan_runner,
)
from .status_insight import STATUS_INSIGHT_CARD, make_status_insight_runner
from .weekly_plan import (
    WEEKLY_PLAN_CARD,
    make_current_week_target_resolver,
    make_weekly_plan_runner,
)


def build_specialist_registry(
    *,
    user_id: str,
    specialist_llm: Any,
    status_insight_llm: Any | None = None,
) -> SpecialistRegistry:
    """Register the S1 specialist set. Adding a specialist = one more register()."""
    registry = SpecialistRegistry()
    toolkit = build_stride_toolkit(user_id)
    registry.register(
        STATUS_INSIGHT_CARD,
        make_status_insight_runner(
            user_id=user_id,
            llm=status_insight_llm or specialist_llm,
            toolkit=toolkit,
        ),
    )
    registry.register(
        WEEKLY_PLAN_CARD,
        make_weekly_plan_runner(user_id=user_id, llm=specialist_llm, toolkit=toolkit),
    )
    registry.register(
        SEASON_PLAN_CARD,
        make_season_plan_runner(user_id=user_id, llm=specialist_llm, toolkit=toolkit),
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
    draft_fn: ResolverDraftFn | None = None,
    registry: SpecialistRegistry | None = None,
    checkpointer: Any | None = None,
    specialist_llm: Any | None = None,
    status_insight_llm: Any | None = None,
    memory_store: Any | None = None,
    memory_extract_fn: Any | None = None,
) -> TurnResponse:
    """Run one orchestrator turn and return the TurnResponse (§8 A1).

    Dependencies default to the process singletons but are all injectable for
    tests. Plan specialists use the generator, status insight uses its optional
    fast model, and the Resolver uses the orchestrator model.
    """
    from stride_server.coach_runtime import (
        get_athlete_memory_store,
        get_checkpointer,
        get_generator_llm,
        get_orchestrator_llm,
        get_status_insight_llm,
    )

    resolved_specialist_llm = specialist_llm or get_generator_llm()
    resolved_status_llm = status_insight_llm or (
        specialist_llm if specialist_llm is not None else get_status_insight_llm()
    )
    resolved_registry = registry or build_specialist_registry(
        user_id=user_id,
        specialist_llm=resolved_specialist_llm,
        status_insight_llm=resolved_status_llm,
    )
    orchestrator_llm = get_orchestrator_llm()
    resolved_draft_fn = draft_fn or make_llm_draft_fn(orchestrator_llm)
    resolved_checkpointer = checkpointer or get_checkpointer()
    resolved_store = memory_store or get_athlete_memory_store()
    resolved_extract_fn = memory_extract_fn or make_llm_memory_extractor(orchestrator_llm)

    graph = build_orchestrator_graph(
        registry=resolved_registry,
        draft_fn=resolved_draft_fn,
        checkpointer=resolved_checkpointer,
        memory_store=resolved_store,
        memory_extract_fn=resolved_extract_fn,
        target_resolver=build_target_resolver(user_id),
    )
    thread_id = coach_thread_id(user_id, session_id)
    config = {"configurable": {"thread_id": thread_id, "checkpoint_ns": ""}}
    state = graph.invoke(
        {
            "history": [HumanMessage(content=message)],
            "user_id": user_id,
            "session_id": session_id,
        },
        config=config,
    )
    raw = state.get("turn_response")
    if raw is None:
        # OrchestratorState is total=False; the pipeline always sets this, so a
        # missing value means the graph degraded — surface it explicitly rather
        # than KeyError-ing.
        raise RuntimeError("orchestrator pipeline produced no turn_response")
    return TurnResponse.model_validate(raw)
