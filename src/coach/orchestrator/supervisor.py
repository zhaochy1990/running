"""Supervisor — turn the ResolverOutput into a CallPlan (§4.2).

S1 implements the **single-intent fast path** (no LLM): most turns are a single
intent, so synthesising "schedule one call" through a planning LLM is wasteful —
a deterministic template emits the rich :class:`SpecialistTask` directly.

Multi-intent input degrades to **independent serial calls** (the §4.2 hardening
fallback: "规划失败 → 退化为按 Resolver intents 顺序串行执行"). The proper
compound slow path — an LLM that splits the user goal into per-specialist
objectives and wires ``depends_on`` — lands in S2.
"""

from __future__ import annotations

from coach.contracts import (
    CallPlan,
    IntentHit,
    ResolverOutput,
    ScopedContext,
    SpecialistCall,
    SpecialistRegistry,
    SpecialistTask,
    TargetRef,
    Turn,
)

_READ_BOUNDARIES = "只读诊断：可读取任何训练数据，但本轮只回答 / 诊断，不要产出修改提案。"
_WRITE_BOUNDARIES = "可读取数据并产出 typed 修改提案（diff），但不要直接落地，等用户确认。"


def build_specialist_task(
    intent: IntentHit,
    *,
    registry: SpecialistRegistry,
    utterance: str,
    active_target: TargetRef | None,
    conversation_window: list[Turn],
) -> SpecialistTask:
    """Synthesise the rich brief for one specialist call (§4.2).

    S1 hands the expert an empty ``ScopedContext`` — the specialist self-serves
    its read prefetch (§4.3 "专家自给"). Per-``data_needs`` prefetch is a later
    optimisation handled in the adapter layer.
    """
    card = registry.get_card(intent.specialist_id)
    boundaries = _WRITE_BOUNDARIES if card.writes else _READ_BOUNDARIES
    return SpecialistTask(
        objective=utterance,
        active_target=active_target,
        context=ScopedContext(),
        boundaries=boundaries,
        conversation_window=list(conversation_window),
    )


def build_call_plan(
    resolver_output: ResolverOutput,
    *,
    registry: SpecialistRegistry,
    utterance: str,
    conversation_window: list[Turn] | None = None,
) -> CallPlan:
    """Build the dispatch plan from a ResolverOutput.

    A clarify turn (``ambiguity`` set) yields an empty plan — the orchestrator
    short-circuits to the Aggregator before reaching here, but returning an
    empty plan keeps this function safe to call unconditionally.
    """
    if resolver_output.ambiguity is not None or not resolver_output.intents:
        return CallPlan(calls=[])

    window = conversation_window or []
    calls = [
        SpecialistCall(
            specialist_id=intent.specialist_id,
            task=build_specialist_task(
                intent,
                registry=registry,
                utterance=utterance,
                active_target=resolver_output.active_target,
                conversation_window=window,
            ),
            depends_on=[],
        )
        for intent in resolver_output.intents
    ]
    return CallPlan(calls=calls)
