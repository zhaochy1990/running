"""Whole-plan op-id validation for apply — the client must accept exactly the
set of applicable ops (accepted != False), order-ignored (§ backend contract)."""

from __future__ import annotations

import pytest

from stride_core.plan_diff import DiffOp, DiffOpKind, PlanDiff, require_whole_plan_op_ids


def _op(op_id: str, accepted: bool | None = None) -> DiffOp:
    return DiffOp(
        id=op_id,
        op=DiffOpKind.MOVE_SESSION,
        date="2026-06-24",
        session_index=0,
        old_value=None,
        new_value={"date": "2026-06-25", "session_index": 0},
        spec_patch={"new_date": "2026-06-25", "new_session_index": 0},
        accepted=accepted,
    )


def _diff(*ops: DiffOp) -> PlanDiff:
    return PlanDiff(
        diff_id="d1", folder="2026-06-22_06-28(W8)", ops=list(ops),
        ai_explanation="x", created_at="2026-06-28T00:00:00Z",
    )


def test_exact_set_passes_order_ignored() -> None:
    diff = _diff(_op("op1"), _op("op2"))
    # Order ignored.
    assert require_whole_plan_op_ids(diff.ops, ["op2", "op1"]) == ["op1", "op2"]


def test_rejected_ops_are_excluded_and_must_not_be_sent() -> None:
    diff = _diff(_op("op1"), _op("op2", accepted=False))
    # Only op1 is applicable; sending exactly ["op1"] is required.
    assert require_whole_plan_op_ids(diff.ops, ["op1"]) == ["op1"]


def test_partial_acceptance_is_rejected() -> None:
    diff = _diff(_op("op1"), _op("op2"))
    with pytest.raises(ValueError):
        require_whole_plan_op_ids(diff.ops, ["op1"])  # op2 missing


def test_unknown_op_id_is_rejected() -> None:
    diff = _diff(_op("op1"))
    with pytest.raises(ValueError):
        require_whole_plan_op_ids(diff.ops, ["op1", "ghost"])


def test_duplicate_op_id_is_rejected() -> None:
    diff = _diff(_op("op1"), _op("op2"))
    with pytest.raises(ValueError):
        require_whole_plan_op_ids(diff.ops, ["op1", "op2", "op2"])


def test_sending_a_rejected_op_is_rejected() -> None:
    diff = _diff(_op("op1"), _op("op2", accepted=False))
    with pytest.raises(ValueError):
        require_whole_plan_op_ids(diff.ops, ["op1", "op2"])  # op2 was rejected
