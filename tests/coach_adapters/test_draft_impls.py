"""US-007: 7 week-scope draft tools emit valid PlanDiff."""

from __future__ import annotations

from pathlib import Path

import pytest

from coach.schemas import ToolResult
from stride_core.plan_diff import DiffOpKind, PlanDiff
from stride_server.coach_adapters.tool_impls import draft_impls


# ---------------------------------------------------------------------------
# Fixture: seed a tmp DB with sample planned_session rows
# ---------------------------------------------------------------------------


@pytest.fixture
def patched_plan(tmp_path, monkeypatch):
    """Open a real Database under tmp_path and monkeypatch ``_open_plan_store``
    so every draft impl uses it. Seeds two run sessions + one strength."""
    from stride_storage.sqlite.database import Database
    from stride_storage.sqlite.state_stores import SqlitePlanStateStore

    db_path = tmp_path / "draft_test.db"
    db = Database(db_path)
    plan_store = SqlitePlanStateStore(db)

    folder = "2026-05-11_05-17(P1W3)"
    db._conn.executemany(
        """INSERT INTO planned_session
           (week_folder, date, session_index, kind, summary, total_distance_m, total_duration_s)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        [
            (folder, "2026-05-13", 0, "run", "周三轻松跑", 8000, 2700),
            (folder, "2026-05-14", 0, "run", "周四节奏跑", 12000, 3900),
            (folder, "2026-05-15", 0, "strength", "全身力量", None, 3000),
        ],
    )
    db._conn.commit()

    def _factory(_uid: str):
        d = Database(db_path)
        return d, SqlitePlanStateStore(d)

    monkeypatch.setattr(draft_impls, "_open_plan_store", _factory)
    yield folder, db
    db.close()


def _assert_plan_diff(res: ToolResult) -> PlanDiff:
    assert res.ok, f"tool failed: {res.errors}"
    assert isinstance(res.data, dict)
    pd = PlanDiff.model_validate(res.data)
    assert pd.folder
    assert pd.diff_id
    assert pd.created_at
    return pd


# ---------------------------------------------------------------------------
# Per-tool acceptance
# ---------------------------------------------------------------------------


def test_swap_sessions_emits_two_move_ops(patched_plan):
    folder, _ = patched_plan
    impl = draft_impls.SwapSessionsImpl("uid")
    res = impl(folder=folder, date_a="2026-05-13", date_b="2026-05-14")
    pd = _assert_plan_diff(res)
    assert len(pd.ops) == 2
    assert all(o.op == DiffOpKind.MOVE_SESSION for o in pd.ops)
    dates = {(o.date, o.spec_patch["new_date"]) for o in pd.ops}
    assert ("2026-05-13", "2026-05-14") in dates
    assert ("2026-05-14", "2026-05-13") in dates


def test_swap_sessions_with_no_sessions_fails(patched_plan):
    folder, _ = patched_plan
    res = draft_impls.SwapSessionsImpl("uid")(
        folder=folder, date_a="2026-06-01", date_b="2026-06-02"
    )
    assert not res.ok


def test_shift_session_single_move(patched_plan):
    folder, _ = patched_plan
    res = draft_impls.ShiftSessionImpl("uid")(
        folder=folder, date="2026-05-13", to_date="2026-05-16", session_index=0
    )
    pd = _assert_plan_diff(res)
    assert len(pd.ops) == 1
    op = pd.ops[0]
    assert op.op == DiffOpKind.MOVE_SESSION
    assert op.date == "2026-05-13"
    assert op.spec_patch["new_date"] == "2026-05-16"


def test_shift_missing_session_fails(patched_plan):
    folder, _ = patched_plan
    res = draft_impls.ShiftSessionImpl("uid")(
        folder=folder, date="2026-12-31", to_date="2027-01-01"
    )
    assert not res.ok


def test_reduce_intensity_scales_distance(patched_plan):
    folder, _ = patched_plan
    res = draft_impls.ReduceIntensityImpl("uid")(
        folder=folder, scope="week", factor=0.8, reason="疲劳较高"
    )
    pd = _assert_plan_diff(res)
    # Two run sessions → two REPLACE_DISTANCE ops; strength skipped
    assert len(pd.ops) == 2
    assert all(o.op == DiffOpKind.REPLACE_DISTANCE for o in pd.ops)
    expected = {"2026-05-13": 8000 * 0.8, "2026-05-14": 12000 * 0.8}
    for op in pd.ops:
        assert op.spec_patch["total_distance_m"] == round(expected[op.date])


def test_reduce_intensity_invalid_scope_fails(patched_plan):
    folder, _ = patched_plan
    res = draft_impls.ReduceIntensityImpl("uid")(
        folder=folder, scope="month", factor=0.8, reason="x"
    )
    assert not res.ok


def test_reduce_intensity_invalid_factor_fails(patched_plan):
    folder, _ = patched_plan
    for bad_factor in (0, -0.5, 1.5):
        res = draft_impls.ReduceIntensityImpl("uid")(
            folder=folder, scope="week", factor=bad_factor, reason="x"
        )
        assert not res.ok


def test_replace_session_changes_kind(patched_plan):
    folder, _ = patched_plan
    res = draft_impls.ReplaceSessionImpl("uid")(
        folder=folder,
        date="2026-05-13",
        session_index=0,
        new_kind="rest",
        params={"summary": "完全休息"},
    )
    pd = _assert_plan_diff(res)
    assert len(pd.ops) == 1
    op = pd.ops[0]
    assert op.op == DiffOpKind.REPLACE_KIND
    assert op.spec_patch["kind"] == "rest"


def test_replace_session_invalid_kind_fails(patched_plan):
    folder, _ = patched_plan
    res = draft_impls.ReplaceSessionImpl("uid")(
        folder=folder, date="2026-05-13", session_index=0, new_kind="random", params={}
    )
    assert not res.ok


def test_add_strength_session_appends_after_existing(patched_plan):
    folder, _ = patched_plan
    res = draft_impls.AddStrengthSessionImpl("uid")(
        folder=folder, date="2026-05-15", focus="下肢"
    )
    pd = _assert_plan_diff(res)
    assert len(pd.ops) == 1
    op = pd.ops[0]
    assert op.op == DiffOpKind.ADD_SESSION
    # Existing strength at idx 0 → new session goes to idx 1
    assert op.session_index == 1
    assert op.spec_patch["kind"] == "strength"


def test_change_pace_target_emits_replace(patched_plan):
    folder, _ = patched_plan
    res = draft_impls.ChangePaceTargetImpl("uid")(
        folder=folder, date="2026-05-14", session_index=0, new_pace_s_per_km=275
    )
    pd = _assert_plan_diff(res)
    assert len(pd.ops) == 1
    op = pd.ops[0]
    assert op.op == DiffOpKind.REPLACE_DISTANCE
    assert "4:35/km" in op.spec_patch["summary"]


def test_change_pace_target_invalid_pace_fails(patched_plan):
    folder, _ = patched_plan
    res = draft_impls.ChangePaceTargetImpl("uid")(
        folder=folder, date="2026-05-14", session_index=0, new_pace_s_per_km=0
    )
    assert not res.ok


def test_regenerate_week_clears_all_sessions(patched_plan):
    folder, _ = patched_plan
    res = draft_impls.RegenerateWeekImpl("uid")(
        folder=folder, reason="状态差", constraints=["避免高强度", "保留长距离"]
    )
    pd = _assert_plan_diff(res)
    # 3 sessions in fixture → 3 REMOVE_SESSION ops
    assert len(pd.ops) == 3
    assert all(o.op == DiffOpKind.REMOVE_SESSION for o in pd.ops)
    assert "避免高强度" in pd.ai_explanation


def test_master_draft_impls_real_and_fail_on_missing_plan():
    """Master-scope tools (US-009) now produce MasterPlanDiff. With a bogus
    plan_id they return ok=False with 'not found' rather than the old
    'not yet implemented' placeholder."""
    for cls, kwargs in (
        (draft_impls.ExtendPhaseImpl, {"plan_id": "pid", "phase_id": "phid", "weeks": 1}),
        (draft_impls.CompressPhaseImpl, {"plan_id": "pid", "phase_id": "phid", "weeks": 1}),
        (draft_impls.ShiftMilestoneImpl, {"plan_id": "pid", "milestone_id": "mid", "new_date": "2026-08-01"}),
        (draft_impls.ChangeTargetImpl, {"plan_id": "pid", "milestone_id": "mid", "new_target_time": "10K 40:00"}),
        (draft_impls.ProposeAlternativesImpl, {"plan_id": "pid", "intent": "test"}),
        (draft_impls.RegenerateMasterImpl, {"plan_id": "pid", "reason": "test"}),
    ):
        impl = cls("uid")
        res = impl(**kwargs)
        assert not res.ok
        assert any("not found" in e for e in res.errors)
