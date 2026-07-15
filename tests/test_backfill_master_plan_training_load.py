from __future__ import annotations

import pytest

from stride_core.master_plan import MasterPlanStatus
from scripts.backfill_master_plan_training_load import _build_store, _project, main
from tests.stride_server.test_master_plan_load_projection import _plan


class _Store:
    def __init__(self, plans):
        self.plans = plans
        self.saved = []

    def list_active_plans(self):
        return [plan for plan in self.plans if plan.status == MasterPlanStatus.ACTIVE]

    def get_active_plan(self, user_id):
        return next((plan for plan in self.list_active_plans() if plan.user_id == user_id), None)

    def save_plan(self, plan):
        self.saved.append(plan)
        self.plans = [
            plan if existing.plan_id == plan.plan_id else existing
            for existing in self.plans
        ]


def _use_store(monkeypatch, store, *, label="test store") -> None:
    monkeypatch.setattr(
        "scripts.backfill_master_plan_training_load._build_store",
        lambda target: (store, f"{label} ({target})"),
    )


def test_target_store_must_be_explicit() -> None:
    with pytest.raises(SystemExit):
        main(["--all"])


def test_local_target_uses_file_store() -> None:
    store, label = _build_store("local")

    assert store.__class__.__name__ == "FileMasterPlanStore"
    assert ".master_plans.json" in label


def test_prod_target_reads_validated_azure_config(tmp_path, monkeypatch) -> None:
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    (config_dir / "server.prod.toml").write_text(
        """
[storage.master_plan]
table_account_url = "https://example.table.core.windows.net/"
table_name = "plans-test"
""",
        encoding="utf-8",
    )

    seen = {}

    class FakeAzureStore:
        def __init__(self, account_url, table_name):
            seen.update(account_url=account_url, table_name=table_name)

    monkeypatch.setattr("scripts.backfill_master_plan_training_load._REPO", tmp_path)
    monkeypatch.setattr(
        "stride_storage.azure.master_plan_backend.AzureTableMasterPlanStore",
        FakeAzureStore,
    )

    store, label = _build_store("prod")

    assert isinstance(store, FakeAzureStore)
    assert seen == {
        "account_url": "https://example.table.core.windows.net/",
        "table_name": "plans-test",
    }
    assert "production Azure Table" in label


def test_dry_run_does_not_write(monkeypatch) -> None:
    store = _Store([_plan(with_week=False)])
    _use_store(monkeypatch, store)

    assert main(["--local", "--all"]) == 0
    assert store.saved == []


def test_execute_writes_active_plan_without_bumping_business_version(monkeypatch) -> None:
    plan = _plan(with_week=False)
    store = _Store([plan])
    _use_store(monkeypatch, store)

    assert main(["--prod", "--all", "--execute"]) == 0
    assert len(store.saved) == 1
    assert store.saved[0].version == plan.version
    assert store.saved[0].training_load_projection.status == "unavailable"


def test_execute_projects_weekly_ranges_and_is_idempotent(monkeypatch) -> None:
    from coach.schemas import ToolResult

    class FakeLoadTool:
        def __init__(self, user_id):
            self.user_id = user_id

        def __call__(self, **kwargs):
            return ToolResult(
                ok=True,
                data={
                    "plan_estimate": {
                        "weeks": [{
                            "week_index": 1,
                            "target_training_dose_low": 210.0,
                            "target_training_dose_high": 260.0,
                        }],
                    },
                },
            )

    store = _Store([_plan(with_week=True)])
    monkeypatch.setattr(
        "stride_server.coach_adapters.tool_impls.read_impls.EstimateMasterPlanLoadImpl",
        FakeLoadTool,
    )
    _use_store(monkeypatch, store)

    assert main(["--prod", "--all", "--execute"]) == 0
    assert len(store.saved) == 1
    saved = store.saved[0]
    assert saved.training_load_projection.status == "available"
    assert saved.weeks[0].target_training_dose_low == 210.0
    assert saved.weeks[0].target_training_dose_high == 260.0
    calculated_at = saved.training_load_projection.calculated_at

    store.saved.clear()
    assert main(["--prod", "--all", "--execute"]) == 0
    assert store.saved == []
    assert store.plans[0].training_load_projection.calculated_at == calculated_at


def test_execute_is_noop_for_unchanged_unavailable_plan(monkeypatch) -> None:
    plan = _project(_plan(with_week=False))
    calculated_at = plan.training_load_projection.calculated_at
    store = _Store([plan])
    _use_store(monkeypatch, store)

    assert main(["--prod", "--all", "--execute"]) == 0
    assert store.saved == []
    assert plan.training_load_projection.calculated_at == calculated_at


def test_repeated_profiles_process_each_selected_active_plan(monkeypatch) -> None:
    first = _plan(with_week=False)
    second = first.model_copy(update={"plan_id": "plan-2", "user_id": "user-2"})
    store = _Store([first, second])
    _use_store(monkeypatch, store)

    assert main(["--prod", "-P", "user-1", "-P", "user-2", "--execute"]) == 0
    assert {plan.plan_id for plan in store.saved} == {"plan-1", "plan-2"}


def test_all_only_migrates_active_plans_and_leaves_snapshots_untouched(monkeypatch) -> None:
    active = _plan(with_week=False)
    draft = active.model_copy(update={
        "plan_id": "draft-plan",
        "status": MasterPlanStatus.DRAFT,
    })
    archived = active.model_copy(update={
        "plan_id": "archived-plan",
        "status": MasterPlanStatus.ARCHIVED,
    })
    store = _Store([active, draft, archived])
    snapshots = [{"version_id": "v1", "snapshot_json": "unchanged"}]
    store.snapshots = snapshots.copy()
    _use_store(monkeypatch, store)

    assert main(["--prod", "--all", "--execute"]) == 0
    assert [plan.plan_id for plan in store.saved] == [active.plan_id]
    assert store.snapshots == snapshots
