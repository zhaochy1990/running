from __future__ import annotations

from stride_core.plan_spec import (
    PlannedNutrition,
    PlannedSession,
    SessionKind,
    WeeklyPlan,
)
from stride_server.config.models import WeeklyPlanStorageConfig
from stride_storage.azure.weekly_plan_backend import (
    AzureTableWeeklyPlanStore,
    FileWeeklyPlanStore,
    store_from_config,
    _plan_json,
)

USER_A = "a1b2c3d4-e5f6-4aaa-89ab-111111111111"
USER_B = "b1b2c3d4-e5f6-4aaa-89ab-222222222222"


def _plan(folder: str = "2026-07-13_07-19(P2W4)") -> WeeklyPlan:
    return WeeklyPlan(
        week_folder=folder,
        sessions=(
            PlannedSession(
                date=folder[:10],
                session_index=0,
                kind=SessionKind.RUN,
                summary="Easy run",
                total_distance_m=8000,
            ),
        ),
        nutrition=(PlannedNutrition(date=folder[:10], kcal_target=2400),),
    )


def test_factory_selects_file_and_azure_backends() -> None:
    assert isinstance(
        store_from_config(WeeklyPlanStorageConfig()), FileWeeklyPlanStore
    )
    assert isinstance(
        store_from_config(
            WeeklyPlanStorageConfig(
                table_account_url="https://example.table.core.windows.net/"
            )
        ),
        AzureTableWeeklyPlanStore,
    )


def test_file_store_round_trip_current_lookup_and_isolation(tmp_path, monkeypatch) -> None:
    import stride_core.db as core_db

    monkeypatch.setattr(core_db, "USER_DATA_DIR", tmp_path)
    store = FileWeeklyPlanStore()
    plan = _plan()
    store.save_plan(USER_A, plan, generated_by="test")

    assert store.get_plan(USER_A, plan.week_folder) == plan
    assert store.get_current_plan(USER_A, "2026-07-15") == plan
    assert store.get_current_plan(USER_A, "2026-07-20") is None
    assert store.get_plan(USER_B, plan.week_folder) is None
    assert store.list_plans(USER_A) == [plan]


def test_file_store_rejects_invalid_folder(tmp_path, monkeypatch) -> None:
    import stride_core.db as core_db
    import pytest

    monkeypatch.setattr(core_db, "USER_DATA_DIR", tmp_path)
    with pytest.raises(ValueError, match="invalid weekly plan folder"):
        FileWeeklyPlanStore().save_plan(USER_A, WeeklyPlan(week_folder="bad"))


def test_file_store_delete_user(tmp_path, monkeypatch) -> None:
    import stride_core.db as core_db

    monkeypatch.setattr(core_db, "USER_DATA_DIR", tmp_path)
    store = FileWeeklyPlanStore()
    store.save_plan(USER_A, _plan())
    store.save_plan(USER_B, _plan())

    assert store.delete_user(USER_A) == 1
    assert store.list_plans(USER_A) == []
    assert len(store.list_plans(USER_B)) == 1


def test_store_drops_local_scheduled_workout_id(tmp_path, monkeypatch) -> None:
    import stride_core.db as core_db
    from dataclasses import replace

    monkeypatch.setattr(core_db, "USER_DATA_DIR", tmp_path)
    plan = _plan()
    local = replace(
        plan, sessions=(replace(plan.sessions[0], scheduled_workout_id=123),)
    )
    store = FileWeeklyPlanStore()
    store.save_plan(USER_A, local)

    assert (
        store.get_plan(USER_A, local.week_folder).sessions[0].scheduled_workout_id
        is None
    )


def test_azure_current_lookup_uses_partition_and_date_bounds() -> None:
    plan = _plan()
    captured = {}

    class _Table:
        def query_entities(self, query, *, parameters):
            captured.update(query=query, parameters=parameters)
            return [
                {
                    "plan_json": __import__("json").dumps(plan.to_dict()),
                    "updated_at": "2026-07-15T00:00:00Z",
                }
            ]

    store = AzureTableWeeklyPlanStore.__new__(AzureTableWeeklyPlanStore)
    store._plans = type("Connection", (), {"table": lambda self: _Table()})()

    assert store.get_current_plan(USER_A, "2026-07-15") == plan
    assert captured["parameters"] == {
        "pk": USER_A,
        "kind": "plan",
        "day": "2026-07-15",
    }
    assert "PartitionKey eq @pk" in captured["query"]
    assert "date_from le @day" in captured["query"]
    assert "date_to ge @day" in captured["query"]


def test_table_property_size_limit_is_checked(monkeypatch) -> None:
    import pytest

    plan = _plan()
    monkeypatch.setattr(
        "stride_storage.azure.weekly_plan_backend.MAX_TABLE_STRING_UTF16_BYTES",
        10,
    )
    with pytest.raises(ValueError, match="64 KiB"):
        _plan_json(plan)
