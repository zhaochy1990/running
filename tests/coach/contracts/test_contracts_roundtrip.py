"""S0 contracts — pydantic round-trips + structural invariants (§3, §4)."""

from __future__ import annotations

import pytest

from coach.contracts import (
    Ambiguity,
    CallPlan,
    IntentHit,
    ProposalCard,
    ResolverDraft,
    ResolverOutput,
    ScopedContext,
    SpecialistCall,
    SpecialistCard,
    SpecialistResult,
    SpecialistTask,
    TargetHint,
    TargetRef,
    Turn,
    TurnResponse,
)
from stride_core.plan_diff import DiffOp, DiffOpKind, PlanDiff
from stride_core.master_plan_diff import (
    MasterPlanDiff,
    MasterPlanDiffOp,
    MasterPlanDiffOpKind,
)


def _plan_diff() -> PlanDiff:
    return PlanDiff(
        diff_id="d1",
        folder="2026-W26",
        ops=[
            DiffOp(
                id="op1",
                op=DiffOpKind.MOVE_SESSION,
                date="2026-06-24",
                session_index=0,
                old_value={"summary": "intervals"},
                new_value={"summary": "easy"},
                spec_patch={"kind": "easy"},
                accepted=None,
            )
        ],
        ai_explanation="moved the hard session",
        created_at="2026-06-26T00:00:00Z",
    )


def _master_diff() -> MasterPlanDiff:
    return MasterPlanDiff(
        diff_id="md1",
        plan_id="plan-abc",
        ops=[
            MasterPlanDiffOp(
                id="mop1",
                op=MasterPlanDiffOpKind.RESIZE_PHASE,
                phase_id="base",
                new_value={"weeks": 6},
                spec_patch={"weeks": 6},
            )
        ],
        ai_explanation="extended base phase",
        created_at="2026-06-26T00:00:00Z",
    )


@pytest.mark.parametrize(
    "ref",
    [
        TargetRef(kind="master", plan_id="p1"),
        TargetRef(kind="week", folder="2026-W26"),
        TargetRef(kind="session", folder="2026-W26", date="2026-06-24", session_index=1),
    ],
)
def test_target_ref_roundtrip(ref: TargetRef) -> None:
    assert TargetRef.model_validate(ref.model_dump()) == ref


def test_specialist_task_roundtrip_with_window() -> None:
    task = SpecialistTask(
        objective="diagnose fatigue",
        active_target=TargetRef(kind="week", folder="2026-W26"),
        context=ScopedContext(data={"fatigue": {"form": -12}}, notes="acute high"),
        boundaries="only diagnose, do not change sessions",
        conversation_window=[Turn(role="user", content="how am I doing?")],
    )
    assert SpecialistTask.model_validate(task.model_dump()) == task


def test_specialist_result_carries_plan_diff_proposal() -> None:
    result = SpecialistResult(
        status="completed",
        reply_fragment="把周三改成轻松跑",
        proposal=_plan_diff(),
    )
    dumped = result.model_dump()
    restored = SpecialistResult.model_validate(dumped)
    assert isinstance(restored.proposal, PlanDiff)
    assert restored.proposal.folder == "2026-W26"


def test_specialist_result_carries_master_diff_proposal() -> None:
    result = SpecialistResult(status="completed", proposal=_master_diff())
    restored = SpecialistResult.model_validate(result.model_dump())
    assert isinstance(restored.proposal, MasterPlanDiff)
    assert restored.proposal.plan_id == "plan-abc"


def test_specialist_result_needs_clarification() -> None:
    result = SpecialistResult(
        status="needs_clarification",
        clarification="你说的是哪一周？",
    )
    assert result.proposal is None
    assert result.status == "needs_clarification"


def test_resolver_draft_and_output_roundtrip() -> None:
    draft = ResolverDraft(
        intents=[IntentHit(specialist_id="status_insight", action="read", confidence=0.9)],
        is_compound=False,
        target_hint=TargetHint(kind="week", ref_phrase="这周", is_anaphora=False),
        self_ambiguity=False,
    )
    assert ResolverDraft.model_validate(draft.model_dump()) == draft

    out = ResolverOutput(
        intents=draft.intents,
        is_compound=False,
        active_target=TargetRef(kind="week", folder="2026-W26"),
        ambiguity=None,
        resolved_from="explicit",
    )
    assert ResolverOutput.model_validate(out.model_dump()) == out


def test_resolver_output_ambiguity_shortcircuit() -> None:
    out = ResolverOutput(
        intents=[],
        ambiguity=Ambiguity(kind="target", clarification="哪个计划？"),
    )
    assert out.ambiguity is not None
    assert out.ambiguity.kind == "target"


def test_call_plan_dag_roundtrip() -> None:
    plan = CallPlan(
        calls=[
            SpecialistCall(
                specialist_id="status_insight",
                task=SpecialistTask(objective="read status"),
                depends_on=[],
            ),
            SpecialistCall(
                specialist_id="weekly_plan",
                task=SpecialistTask(objective="adjust week"),
                depends_on=[0],
            ),
        ]
    )
    restored = CallPlan.model_validate(plan.model_dump())
    assert restored.calls[1].depends_on == [0]


def test_turn_response_roundtrip_with_proposal_card() -> None:
    resp = TurnResponse(
        reply="已为你准备好调整方案",
        proposals=[
            ProposalCard(
                specialist_id="weekly_plan",
                proposal=_plan_diff(),
                target=TargetRef(kind="week", folder="2026-W26"),
                summary="周三改轻松跑",
            )
        ],
        active_target=TargetRef(kind="week", folder="2026-W26"),
    )
    restored = TurnResponse.model_validate(resp.model_dump())
    assert isinstance(restored.proposals[0].proposal, PlanDiff)
    assert restored.clarification is None
