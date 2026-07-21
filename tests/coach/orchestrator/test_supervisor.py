"""S1c — Supervisor fast path: ResolverOutput -> CallPlan (§4.2)."""

from __future__ import annotations

from coach.contracts import (
    REVIEW_CONTEXT_KEY,
    Ambiguity,
    IntentHit,
    ResolverOutput,
    SpecialistCard,
    SpecialistRegistry,
    TargetRef,
    Turn,
)
from coach.orchestrator.supervisor import build_call_plan


def _registry() -> SpecialistRegistry:
    reg = SpecialistRegistry()
    reg.register(
        SpecialistCard(id="status_insight", description="状态诊断", writes=False)
    )
    reg.register(SpecialistCard(id="weekly_plan", description="调整本周", writes=True))
    return reg


def test_single_intent_fast_path_one_call() -> None:
    out = ResolverOutput(
        intents=[IntentHit(specialist_id="status_insight", action="read", confidence=0.9)],
        active_target=TargetRef(kind="week", folder="2026-W26"),
    )
    plan = build_call_plan(
        out,
        registry=_registry(),
        utterance="我最近状态如何",
        conversation_window=[Turn(role="user", content="hi")],
    )
    assert len(plan.calls) == 1
    call = plan.calls[0]
    assert call.specialist_id == "status_insight"
    assert call.task.objective == "我最近状态如何"
    assert call.task.active_target == TargetRef(kind="week", folder="2026-W26")
    assert call.task.conversation_window == [Turn(role="user", content="hi")]
    assert call.depends_on == []


def test_read_specialist_gets_readonly_boundaries() -> None:
    out = ResolverOutput(intents=[IntentHit(specialist_id="status_insight", action="read", confidence=0.9)])
    plan = build_call_plan(out, registry=_registry(), utterance="x")
    assert "不要产出修改提案" in plan.calls[0].task.boundaries


def test_write_specialist_gets_write_boundaries() -> None:
    out = ResolverOutput(
        intents=[IntentHit(specialist_id="weekly_plan", action="write", confidence=0.9)],
        active_target=TargetRef(kind="week", folder="2026-W26"),
    )
    plan = build_call_plan(out, registry=_registry(), utterance="改周三")
    assert "等用户确认" in plan.calls[0].task.boundaries


def test_review_context_rides_scoped_context_data() -> None:
    """A review draft is placed on ScopedContext.data for the specialist."""
    ctx = {"kind": "weekly_create", "proposal": {"folder": "2026-W26"}}
    out = ResolverOutput(
        intents=[IntentHit(specialist_id="status_insight", action="read", confidence=0.9)],
        active_target=TargetRef(kind="week", folder="2026-W26"),
    )
    plan = build_call_plan(
        out, registry=_registry(), utterance="这个课表的训练逻辑是什么", review_context=ctx
    )
    assert plan.calls[0].task.context.data[REVIEW_CONTEXT_KEY] == ctx


def test_no_review_context_leaves_scoped_data_empty() -> None:
    out = ResolverOutput(
        intents=[IntentHit(specialist_id="status_insight", action="read", confidence=0.9)],
    )
    plan = build_call_plan(out, registry=_registry(), utterance="我状态如何")
    assert plan.calls[0].task.context.data == {}


def test_ambiguity_yields_empty_plan() -> None:
    out = ResolverOutput(
        intents=[IntentHit(specialist_id="status_insight", action="read", confidence=0.2)],
        ambiguity=Ambiguity(kind="intent", clarification="想了解什么？"),
    )
    plan = build_call_plan(out, registry=_registry(), utterance="嗯")
    assert plan.calls == []


def test_no_intents_yields_empty_plan() -> None:
    out = ResolverOutput(intents=[])
    plan = build_call_plan(out, registry=_registry(), utterance="天气")
    assert plan.calls == []


def test_multi_intent_degrades_to_independent_serial_calls() -> None:
    out = ResolverOutput(
        intents=[
            IntentHit(specialist_id="status_insight", action="read", confidence=0.8),
            IntentHit(specialist_id="weekly_plan", action="write", confidence=0.78),
        ],
        is_compound=True,
        active_target=TargetRef(kind="week", folder="2026-W26"),
    )
    plan = build_call_plan(out, registry=_registry(), utterance="看状态再改周三")
    assert [c.specialist_id for c in plan.calls] == ["status_insight", "weekly_plan"]
    assert all(c.depends_on == [] for c in plan.calls)
