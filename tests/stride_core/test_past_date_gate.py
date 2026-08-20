"""Past-date immutability: a weekly diff may not touch a past Shanghai day; a
session on today that already has a synced actual is locked (§ backend)."""

from __future__ import annotations

from stride_core.plan_diff import (
    DiffOp,
    DiffOpKind,
    op_touched_dates,
    past_dated_op_ids,
)


def _op(op_id, date, kind=DiffOpKind.MOVE_SESSION, new_date=None) -> DiffOp:
    patch = None
    if kind == DiffOpKind.MOVE_SESSION:
        patch = {"new_date": new_date or date, "new_session_index": 0}
    elif kind == DiffOpKind.REPLACE_KIND:
        patch = {"kind": "run"}
    return DiffOp(
        id=op_id, op=kind, date=date, session_index=0,
        old_value=None, new_value=None, spec_patch=patch, accepted=None,
    )


def test_op_touched_dates_includes_source_and_move_target() -> None:
    dates = op_touched_dates(_op("op1", "2026-06-24", new_date="2026-06-26"))
    assert dates == {"2026-06-24", "2026-06-26"}


def test_past_dated_op_ids_flags_source_before_today() -> None:
    ops = [_op("past", "2026-06-20"), _op("future", "2026-06-28")]
    flagged = past_dated_op_ids(ops, today="2026-06-24")
    assert flagged == ["past"]


def test_past_dated_op_ids_flags_move_into_past() -> None:
    # Source today, but moving the session back into a past day.
    ops = [_op("back", "2026-06-24", new_date="2026-06-22")]
    flagged = past_dated_op_ids(ops, today="2026-06-24")
    assert flagged == ["back"]


def test_today_is_not_past() -> None:
    ops = [_op("today", "2026-06-24")]
    assert past_dated_op_ids(ops, today="2026-06-24") == []
