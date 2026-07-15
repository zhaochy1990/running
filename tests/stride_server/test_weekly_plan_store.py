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


def test_file_store_replaces_same_week_even_when_folder_label_changes(
    tmp_path, monkeypatch,
) -> None:
    import stride_core.db as core_db
    from dataclasses import replace

    monkeypatch.setattr(core_db, "USER_DATA_DIR", tmp_path)
    store = FileWeeklyPlanStore()
    original = _plan("2026-07-13_07-19(P2W4)")
    renamed = replace(
        original, week_folder="2026-07-13_07-19(recovery)",
        sessions=(replace(original.sessions[0], summary="Recovery run"),),
    )

    store.save_plan(USER_A, original)
    store.save_plan(USER_A, renamed)

    assert store.list_plans(USER_A) == [renamed]
    assert store.get_plan(USER_A, original.week_folder) == renamed


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


def test_store_preserves_top_level_notes(tmp_path, monkeypatch) -> None:
    import stride_core.db as core_db
    from dataclasses import replace

    monkeypatch.setattr(core_db, "USER_DATA_DIR", tmp_path)
    plan = replace(_plan(), notes_md="coach rationale")
    store = FileWeeklyPlanStore()
    store.save_plan(USER_A, plan)

    assert store.get_plan(USER_A, plan.week_folder).notes_md == "coach rationale"


def test_store_rejects_session_outside_folder(tmp_path, monkeypatch) -> None:
    import stride_core.db as core_db
    import pytest
    from dataclasses import replace

    monkeypatch.setattr(core_db, "USER_DATA_DIR", tmp_path)
    plan = _plan()
    invalid = replace(
        plan, sessions=(replace(plan.sessions[0], date="2026-07-20"),)
    )
    with pytest.raises(ValueError, match="outside"):
        FileWeeklyPlanStore().save_plan(USER_A, invalid)


def test_cross_year_folder_bounds(tmp_path, monkeypatch) -> None:
    import stride_core.db as core_db

    monkeypatch.setattr(core_db, "USER_DATA_DIR", tmp_path)
    plan = WeeklyPlan(
        week_folder="2026-12-29_01-04(NewYear)",
        sessions=(PlannedSession(
            date="2027-01-03", session_index=0, kind=SessionKind.REST,
            summary="rest",
        ),),
    )
    store = FileWeeklyPlanStore()
    store.save_plan(USER_A, plan)
    assert store.get_current_plan(USER_A, "2027-01-03") == plan


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


def test_azure_save_keys_entity_by_week_start() -> None:
    plan = _plan()
    captured = {}

    class _Table:
        def upsert_entity(self, entity, *, mode):
            captured.update(entity=entity, mode=mode)

    store = AzureTableWeeklyPlanStore.__new__(AzureTableWeeklyPlanStore)
    store._plans = type("Connection", (), {"table": lambda self: _Table()})()

    store.save_plan(USER_A, plan)

    assert captured["entity"]["RowKey"] == "2026-07-13"
    assert captured["entity"]["week_folder"] == plan.week_folder


def test_table_property_size_limit_is_checked(monkeypatch) -> None:
    import pytest

    plan = _plan()
    monkeypatch.setattr(
        "stride_storage.azure.weekly_plan_backend.MAX_TABLE_STRING_UTF16_BYTES",
        10,
    )
    with pytest.raises(ValueError, match="64 KiB"):
        _plan_json(plan)
