"""Revise a not-yet-applied weekly-create draft (§5.4 Review write path).

When the user is reviewing an unapplied ``WeeklyPlanCreateProposal`` and asks the
coach to change it (e.g. "把周三的间歇换到周四"), the write turn must produce a
*new* full proposal derived from the draft — not from a saved plan (there is
none) and not a bare ``PlanDiff`` (the Review workspace re-renders a complete
proposal). This module is the pure projection that closes that loop:

    draft proposal  +  PlanDiff  ->  new WeeklyPlanCreateProposal

It applies the diff to the draft's ``WeeklyPlan`` via the shared
:func:`stride_core.plan_diff.apply_diff_to_weekly_plan` pure function, so
unchanged nutrition / week notes / untouched session specs survive verbatim; the
returned proposal carries a fresh id / created_at and a natural-language
explanation. No persistence — the caller emits it as a proposal awaiting the
user's explicit confirmation.
"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from stride_core.plan_diff import PlanDiff, apply_diff_to_weekly_plan
from stride_core.weekly_plan_proposal import WeeklyPlanCreateProposal


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _total_distance_km(plan) -> float:
    """Weekly running volume in km, summed over structured session distances."""
    total_m = 0.0
    for session in plan.sessions:
        distance = session.total_distance_m
        if distance:
            total_m += float(distance)
    return round(total_m / 1000.0, 2)


def revise_weekly_create_proposal(
    draft: WeeklyPlanCreateProposal,
    diff: PlanDiff,
) -> WeeklyPlanCreateProposal:
    """Apply ``diff`` to the draft proposal's plan; return a fresh proposal.

    The diff's ``folder`` must match the draft's — the revision stays on the same
    target week. Every applicable op (``accepted is not False``) is applied; a
    review revision is a whole-plan projection, not a partial cherry-pick. The
    returned proposal preserves the draft's nutrition / week notes / untouched
    session specs (``apply_diff_to_weekly_plan`` only replaces sessions), gets a
    new ``proposal_id`` / ``created_at`` and carries the diff's explanation.
    """
    if diff.folder != draft.folder:
        raise ValueError(
            f"diff folder {diff.folder!r} does not match draft folder "
            f"{draft.folder!r}"
        )

    base_plan = draft.to_weekly_plan()
    applicable_op_ids = [op.id for op in diff.ops if op.accepted is not False]
    revised_plan = apply_diff_to_weekly_plan(base_plan, diff, applicable_op_ids)
    if not revised_plan.sessions:
        raise ValueError(
            "review revision would remove every session without a replacement plan"
        )

    explanation = (diff.ai_explanation or "").strip() or (
        "已根据你的要求调整这份未启用的周计划草案；确认后才会保存。"
    )
    return WeeklyPlanCreateProposal(
        proposal_id=str(uuid4()),
        folder=draft.folder,
        plan=revised_plan.to_dict(),
        total_distance_km=_total_distance_km(revised_plan),
        ai_explanation=explanation,
        created_at=_now_iso(),
        base_revision=draft.base_revision,
    )
