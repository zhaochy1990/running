"""Unit tests for FileMasterPlanStore (the JSON-file backend).

Azure Table backend requires live Azure credentials and is not tested here.
The file backend is the dev/CI default when
``STRIDE_MASTER_PLAN_TABLE_ACCOUNT_URL`` is unset.
"""

from __future__ import annotations

import json

import pytest

from stride_core.master_plan import (
    MasterPlan,
    MasterPlanStatus,
    MasterPlanVersion,
    Milestone,
    MilestoneType,
    Phase,
)

# ---------------------------------------------------------------------------
# Shared test data helpers
# ---------------------------------------------------------------------------

USER_A = "a1b2c3d4-e5f6-4aaa-89ab-111111111111"
USER_B = "b1b2c3d4-e5f6-4aaa-89ab-222222222222"

PLAN_ID_1 = "plan-0000-0001-0000-000000000001"
PLAN_ID_2 = "plan-0000-0002-0000-000000000002"
GOAL_ID   = "goal-0000-0001-0000-000000000001"


def _make_phase(phase_id: str = "ph-1") -> Phase:
    return Phase(
        id=phase_id,
        name="基础期",
        start_date="2026-06-01",
        end_date="2026-07-31",
        focus="有氧基础",
        weekly_distance_km_low=50.0,
        weekly_distance_km_high=65.0,
        key_session_types=["长距离", "有氧"],
        milestone_ids=[],
    )


def _make_milestone(milestone_id: str = "ms-1", phase_id: str = "ph-1") -> Milestone:
    return Milestone(
        id=milestone_id,
        type=MilestoneType.LONG_RUN,
        date="2026-07-15",
        phase_id=phase_id,
        target="30K 节奏跑 4'45/km",
        completed_actual=None,
    )


def _make_plan(
    plan_id: str = PLAN_ID_1,
    user_id: str = USER_A,
    status: MasterPlanStatus = MasterPlanStatus.DRAFT,
    version: int = 1,
) -> MasterPlan:
    return MasterPlan(
        plan_id=plan_id,
        user_id=user_id,
        status=status,
        goal_id=GOAL_ID,
        start_date="2026-06-01",
        end_date="2026-11-15",
        phases=[_make_phase()],
        milestones=[_make_milestone()],
        training_principles=["循序渐进", "恢复优先"],
        generated_by="gpt-4.1",
        version=version,
        created_at="2026-05-12T10:00:00+00:00",
        updated_at="2026-05-12T10:00:00+00:00",
    )


def _make_version(
    version_id: str = "ver-0001",
    plan_id: str = PLAN_ID_1,
    version: int = 1,
) -> MasterPlanVersion:
    snapshot = _make_plan(plan_id=plan_id, version=version)
    return MasterPlanVersion(
        version_id=version_id,
        plan_id=plan_id,
        version=version,
        changed_at="2026-05-12T11:00:00+00:00",
        change_reason="调整基础期时长",
        change_summary="将基础期从 8 周缩短至 6 周",
        snapshot_json=snapshot.model_dump_json(),
    )


# ---------------------------------------------------------------------------
# Fixture: isolated FileMasterPlanStore per test
# ---------------------------------------------------------------------------


@pytest.fixture
def store(tmp_path, monkeypatch):
    """Patch USER_DATA_DIR to tmp_path so each test gets an empty store."""
    import stride_core.db as core_db
    import stride_server.master_plan_store as ms

    monkeypatch.setattr(core_db, "USER_DATA_DIR", tmp_path)
    monkeypatch.delenv("STRIDE_MASTER_PLAN_TABLE_ACCOUNT_URL", raising=False)
    ms.reset_master_plan_store_cache()

    yield ms.get_master_plan_store()

    ms.reset_master_plan_store_cache()


# ---------------------------------------------------------------------------
# Tests: save_plan / get_plan round-trip
# ---------------------------------------------------------------------------


def test_save_and_get_plan(store):
    plan = _make_plan()
    store.save_plan(plan)

    retrieved = store.get_plan(USER_A, PLAN_ID_1)
    assert retrieved is not None
    assert retrieved.plan_id == PLAN_ID_1
    assert retrieved.user_id == USER_A
    assert retrieved.status == MasterPlanStatus.DRAFT
    assert retrieved.version == 1
    assert len(retrieved.phases) == 1
    assert len(retrieved.milestones) == 1


def test_get_plan_missing_returns_none(store):
    result = store.get_plan(USER_A, "nonexistent-plan-id")
    assert result is None


def test_save_plan_overwrites_existing(store):
    plan = _make_plan(version=1)
    store.save_plan(plan)

    updated = plan.model_copy(update={"version": 2, "status": MasterPlanStatus.ACTIVE})
    store.save_plan(updated)

    retrieved = store.get_plan(USER_A, PLAN_ID_1)
    assert retrieved.version == 2
    assert retrieved.status == MasterPlanStatus.ACTIVE


# ---------------------------------------------------------------------------
# Tests: archive_plan
# ---------------------------------------------------------------------------


def test_archive_previous_sets_status(store):
    # Save an ACTIVE plan and a DRAFT plan for the same user
    active_plan = _make_plan(plan_id=PLAN_ID_1, status=MasterPlanStatus.ACTIVE)
    new_plan    = _make_plan(plan_id=PLAN_ID_2, status=MasterPlanStatus.DRAFT)
    store.save_plan(active_plan)
    store.save_plan(new_plan)

    # Promote new_plan as the active one — old plan should be archived
    store.archive_previous(USER_A, new_plan_id=PLAN_ID_2)

    old = store.get_plan(USER_A, PLAN_ID_1)
    new = store.get_plan(USER_A, PLAN_ID_2)

    assert old.status == MasterPlanStatus.ARCHIVED
    # The new plan itself is NOT touched by archive_previous
    assert new.status == MasterPlanStatus.DRAFT


def test_archive_previous_skips_already_archived(store):
    already_archived = _make_plan(plan_id=PLAN_ID_1, status=MasterPlanStatus.ARCHIVED)
    new_plan         = _make_plan(plan_id=PLAN_ID_2, status=MasterPlanStatus.ACTIVE)
    store.save_plan(already_archived)
    store.save_plan(new_plan)

    store.archive_previous(USER_A, new_plan_id=PLAN_ID_2)

    old = store.get_plan(USER_A, PLAN_ID_1)
    assert old.status == MasterPlanStatus.ARCHIVED  # unchanged


# ---------------------------------------------------------------------------
# Tests: get_active_plan
# ---------------------------------------------------------------------------


def test_get_active_plan_returns_active_plan(store):
    draft  = _make_plan(plan_id=PLAN_ID_1, status=MasterPlanStatus.DRAFT)
    active = _make_plan(plan_id=PLAN_ID_2, status=MasterPlanStatus.ACTIVE)
    store.save_plan(draft)
    store.save_plan(active)

    result = store.get_active_plan(USER_A)
    assert result is not None
    assert result.plan_id == PLAN_ID_2
    assert result.status == MasterPlanStatus.ACTIVE


def test_get_active_plan_returns_none_when_no_active(store):
    draft = _make_plan(plan_id=PLAN_ID_1, status=MasterPlanStatus.DRAFT)
    store.save_plan(draft)

    result = store.get_active_plan(USER_A)
    assert result is None


def test_get_active_plan_returns_none_for_empty_store(store):
    result = store.get_active_plan(USER_A)
    assert result is None


# ---------------------------------------------------------------------------
# Tests: list_plans
# ---------------------------------------------------------------------------


def test_list_plans_returns_all_user_plans(store):
    p1 = _make_plan(plan_id=PLAN_ID_1, status=MasterPlanStatus.ACTIVE)
    p2 = _make_plan(plan_id=PLAN_ID_2, status=MasterPlanStatus.ARCHIVED)
    store.save_plan(p1)
    store.save_plan(p2)

    plans = store.list_plans(USER_A)
    assert len(plans) == 2
    ids = {p.plan_id for p in plans}
    assert ids == {PLAN_ID_1, PLAN_ID_2}


def test_list_plans_empty_user(store):
    assert store.list_plans(USER_A) == []


# ---------------------------------------------------------------------------
# Tests: versions — save / list / get
# ---------------------------------------------------------------------------


def test_save_and_get_version(store):
    v = _make_version()
    store.save_version(v)

    retrieved = store.get_version(PLAN_ID_1, "ver-0001")
    assert retrieved is not None
    assert retrieved.version_id == "ver-0001"
    assert retrieved.plan_id == PLAN_ID_1
    assert retrieved.version == 1
    assert "基础期" in retrieved.change_summary


def test_get_version_missing_returns_none(store):
    result = store.get_version(PLAN_ID_1, "nonexistent-version-id")
    assert result is None


def test_list_versions_descending_order(store):
    v1 = _make_version(version_id="ver-0001", version=1)
    v2 = _make_version(version_id="ver-0002", version=2)
    v3 = _make_version(version_id="ver-0003", version=3)
    # Insert out of order to confirm sorting is applied
    store.save_version(v2)
    store.save_version(v3)
    store.save_version(v1)

    versions = store.list_versions(PLAN_ID_1)
    assert len(versions) == 3
    assert [v.version for v in versions] == [3, 2, 1]


def test_list_versions_empty(store):
    assert store.list_versions(PLAN_ID_1) == []


# ---------------------------------------------------------------------------
# Tests: cross-user isolation
# ---------------------------------------------------------------------------


def test_cross_user_isolation_plans(store):
    plan_a = _make_plan(plan_id=PLAN_ID_1, user_id=USER_A, status=MasterPlanStatus.ACTIVE)
    plan_b = _make_plan(plan_id=PLAN_ID_2, user_id=USER_B, status=MasterPlanStatus.ACTIVE)
    store.save_plan(plan_a)
    store.save_plan(plan_b)

    plans_a = store.list_plans(USER_A)
    plans_b = store.list_plans(USER_B)

    assert len(plans_a) == 1
    assert plans_a[0].plan_id == PLAN_ID_1

    assert len(plans_b) == 1
    assert plans_b[0].plan_id == PLAN_ID_2


def test_cross_user_get_active_plan_isolation(store):
    plan_a = _make_plan(plan_id=PLAN_ID_1, user_id=USER_A, status=MasterPlanStatus.ACTIVE)
    store.save_plan(plan_a)

    # USER_B has no plans — should get None, not USER_A's plan
    result = store.get_active_plan(USER_B)
    assert result is None


def test_archive_previous_scoped_to_user(store):
    """archive_previous for USER_A must not affect USER_B's plans."""
    plan_a = _make_plan(plan_id=PLAN_ID_1, user_id=USER_A, status=MasterPlanStatus.ACTIVE)
    # USER_B has a plan with the same plan_id pattern but different user
    plan_b_id = "plan-0000-0003-0000-000000000003"
    plan_b = _make_plan(plan_id=plan_b_id, user_id=USER_B, status=MasterPlanStatus.ACTIVE)
    store.save_plan(plan_a)
    store.save_plan(plan_b)

    new_plan_a_id = "plan-0000-0004-0000-000000000004"
    new_a = _make_plan(plan_id=new_plan_a_id, user_id=USER_A, status=MasterPlanStatus.DRAFT)
    store.save_plan(new_a)

    store.archive_previous(USER_A, new_plan_id=new_plan_a_id)

    # USER_A's old plan archived
    assert store.get_plan(USER_A, PLAN_ID_1).status == MasterPlanStatus.ARCHIVED
    # USER_B's plan untouched
    assert store.get_plan(USER_B, plan_b_id).status == MasterPlanStatus.ACTIVE


# ---------------------------------------------------------------------------
# Tests: snapshot_json round-trip
# ---------------------------------------------------------------------------


def test_version_snapshot_json_is_valid_master_plan(store):
    plan = _make_plan()
    v = _make_version(plan_id=plan.plan_id)
    store.save_version(v)

    retrieved = store.get_version(plan.plan_id, v.version_id)
    # snapshot_json must deserialise back into a MasterPlan
    restored = MasterPlan.model_validate_json(retrieved.snapshot_json)
    assert restored.plan_id == plan.plan_id
    assert restored.version == v.version
