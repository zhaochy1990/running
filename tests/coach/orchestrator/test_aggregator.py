"""S1e — Aggregator: dispatched results -> TurnResponse (§4.4)."""

from __future__ import annotations

from coach.contracts import (
    Ambiguity,
    IntentHit,
    ResolverOutput,
    SpecialistResult,
    TargetRef,
)
from coach.orchestrator.aggregator import aggregate
from coach.orchestrator.dispatcher import DispatchResult
from stride_core.plan_diff import PlanDiff


def _resolver(**kw) -> ResolverOutput:
    kw.setdefault("intents", [IntentHit(specialist_id="status_insight", action="read", confidence=0.9)])
    return ResolverOutput(**kw)


def _completed(fragment: str, *, sid: str = "status_insight", proposal=None) -> DispatchResult:
    return DispatchResult(
        specialist_id=sid,
        result=SpecialistResult(
            status="completed",
            reply_fragment=fragment,
            proposals=[proposal] if proposal is not None else [],
        ),
    )


def _completed_with_proposals(
    fragment: str, *, sid: str, proposals: list[PlanDiff]
) -> DispatchResult:
    return DispatchResult(
        specialist_id=sid,
        result=SpecialistResult(
            status="completed", reply_fragment=fragment, proposals=proposals
        ),
    )


def _diff() -> PlanDiff:
    return PlanDiff(diff_id="d1", folder="2026-W26", ops=[], ai_explanation="x", created_at="t")


def test_single_completed_passthrough() -> None:
    resp = aggregate(
        [_completed("你最近负荷偏高，建议减量")],
        resolver_output=_resolver(active_target=TargetRef(kind="week", folder="2026-W26")),
        utterance="状态如何",
    )
    assert resp.reply == "你最近负荷偏高，建议减量"
    assert resp.clarification is None
    assert resp.proposals == []
    assert resp.active_target == TargetRef(kind="week", folder="2026-W26")


def test_resolver_ambiguity_short_circuits_to_clarify() -> None:
    resp = aggregate(
        [],
        resolver_output=_resolver(
            intents=[],
            ambiguity=Ambiguity(kind="intent", clarification="你想了解还是调整？"),
        ),
        utterance="嗯",
    )
    assert resp.clarification == "你想了解还是调整？"
    assert resp.reply == "你想了解还是调整？"
    assert resp.proposals == []


def test_specialist_needs_clarification_short_circuits() -> None:
    item = DispatchResult(
        specialist_id="weekly_plan",
        result=SpecialistResult(status="needs_clarification", clarification="改哪一天？"),
    )
    resp = aggregate([item], resolver_output=_resolver(), utterance="改一下")
    assert resp.clarification == "改哪一天？"
    assert resp.proposals == []


def test_clarification_suppresses_proposals_invariant() -> None:
    """clarification != None  =>  proposals == []  (§4.4 hard invariant)."""
    completed_with_proposal = _completed("已准备调整", sid="weekly_plan", proposal=_diff())
    needs_clar = DispatchResult(
        specialist_id="weekly_plan",
        result=SpecialistResult(status="needs_clarification", clarification="哪一周？"),
    )
    resp = aggregate(
        [completed_with_proposal, needs_clar],
        resolver_output=_resolver(),
        utterance="改",
    )
    assert resp.clarification is not None
    assert resp.proposals == []


def test_all_failed_honest_failure() -> None:
    failed = DispatchResult(
        specialist_id="status_insight",
        result=SpecialistResult(status="failed", reply_fragment="boom"),
    )
    resp = aggregate([failed], resolver_output=_resolver(), utterance="x")
    assert "没能完成" in resp.reply
    assert resp.proposals == []


def test_completed_with_proposal_builds_card() -> None:
    item = _completed("把周三改成轻松跑", sid="weekly_plan", proposal=_diff())
    resp = aggregate(
        [item],
        resolver_output=_resolver(active_target=TargetRef(kind="week", folder="2026-W26")),
        utterance="改周三",
    )
    assert len(resp.proposals) == 1
    card = resp.proposals[0]
    assert card.specialist_id == "weekly_plan"
    assert card.target == TargetRef(kind="week", folder="2026-W26")
    assert isinstance(card.proposal, PlanDiff)


def test_completed_with_multiple_proposals_builds_one_card_per_choice() -> None:
    conservative = _diff().model_copy(
        update={"diff_id": "conservative", "ai_explanation": "保守方案"}
    )
    aggressive = _diff().model_copy(
        update={"diff_id": "aggressive", "ai_explanation": "激进方案"}
    )
    item = _completed_with_proposals(
        "请选择一个方向",
        sid="season_plan",
        proposals=[conservative, aggressive],
    )
    resp = aggregate(
        [item],
        resolver_output=_resolver(active_target=TargetRef(kind="master", plan_id="plan-1")),
        utterance="给我两个方向",
    )
    assert [card.proposal.diff_id for card in resp.proposals] == [
        "conservative",
        "aggressive",
    ]
    assert [card.summary for card in resp.proposals] == ["保守方案", "激进方案"]
    assert all(card.specialist_id == "season_plan" for card in resp.proposals)


def test_multi_result_uses_synth_fn() -> None:
    items = [_completed("诊断：负荷高", sid="status_insight"), _completed("已调整周三", sid="weekly_plan")]
    seen: dict[str, object] = {}

    def _synth(fragments: list[str], utterance: str) -> str:
        seen["fragments"] = fragments
        return "综合回复"

    resp = aggregate(items, resolver_output=_resolver(), utterance="x", synth_fn=_synth)
    assert resp.reply == "综合回复"
    assert seen["fragments"] == ["诊断：负荷高", "已调整周三"]


def test_multi_result_without_synth_fn_joins() -> None:
    items = [_completed("A"), _completed("B", sid="weekly_plan")]
    resp = aggregate(items, resolver_output=_resolver(), utterance="x")
    assert resp.reply == "A\n\nB"
