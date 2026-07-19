from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from stride_core.models import ActivityDetail, DailyHealth, TimeseriesPoint

USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
INTERNAL_TOKEN = "test-internal-token-very-secret"
UNALIASED_USER_UUID = "b2c3d4e5-f6a7-4bbb-8abc-234567890123"


def _timeseries(duration_s: int = 3600) -> list[TimeseriesPoint]:
    return [
        TimeseriesPoint(
            timestamp=i * 100,
            distance=4.0 * i,
            heart_rate=170,
            speed=250.0,
            adjusted_pace=None,
            cadence=180,
            altitude=0.0,
            power=None,
        )
        for i in range(0, duration_s + 1, 30)
    ]


def _activity(label_id: str, date_iso: str) -> ActivityDetail:
    return ActivityDetail(
        label_id=label_id,
        name="Run",
        sport_type=100,
        sport_name="Run",
        date=date_iso,
        distance_m=14400,
        duration_s=3600.0,
        avg_pace_s_km=250.0,
        adjusted_pace=None,
        best_km_pace=None,
        max_pace=None,
        avg_hr=168,
        max_hr=186,
        avg_cadence=180,
        max_cadence=190,
        avg_power=None,
        max_power=None,
        avg_step_len_cm=None,
        ascent_m=0.0,
        descent_m=0.0,
        calories_kcal=500,
        aerobic_effect=None,
        anaerobic_effect=None,
        training_load=999.0,
        vo2max=None,
        performance=None,
        train_type="Aerobic Endurance",
        temperature=None,
        humidity=None,
        feels_like=None,
        wind_speed=None,
        sport="run_outdoor",
        train_kind="aerobic",
        timeseries=_timeseries(),
    )


def test_internal_training_load_users_scans_live_uuid_databases(tmp_path, monkeypatch):
    import stride_core.db as core_db_mod

    monkeypatch.setenv("STRIDE_INTERNAL_TOKEN", INTERNAL_TOKEN)
    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)

    from stride_server.config import clear_server_config_cache
    from stride_server.routes.training_load import internal_router
    from stride_storage.sqlite.database import Database

    clear_server_config_cache()
    # Both UUID databases must be found even though no alias file exists.
    for user_id in (USER_UUID, UNALIASED_USER_UUID):
        with Database(user=user_id):
            pass
    # Non-user directories and empty placeholders are not rollout targets.
    (tmp_path / "_jobs_dev").mkdir()
    empty_dir = tmp_path / "c3d4e5f6-a7b8-4ccc-8abc-345678901234"
    empty_dir.mkdir()
    (empty_dir / "coros.db").touch()

    app = FastAPI()
    app.include_router(internal_router)
    client = TestClient(app, raise_server_exceptions=False)

    unauthorized = client.get("/internal/training-load/users")
    response = client.get(
        "/internal/training-load/users",
        headers={"X-Internal-Token": INTERNAL_TOKEN},
    )

    assert unauthorized.status_code == 401
    assert response.status_code == 200, response.text
    assert response.json() == {
        "ok": True,
        "users": [USER_UUID, UNALIASED_USER_UUID],
        "count": 2,
    }


def test_internal_training_load_backfill_refreshes_threshold_and_recent_load(tmp_path, monkeypatch):
    import stride_core.db as core_db_mod
    import stride_server.deps as deps_mod

    monkeypatch.setenv("STRIDE_INTERNAL_TOKEN", INTERNAL_TOKEN)
    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
    monkeypatch.setattr(deps_mod, "USER_DATA_DIR", tmp_path)

    from stride_storage.sqlite.database import Database
    from stride_server.config import clear_server_config_cache
    from stride_server.routes.training_load import internal_router

    clear_server_config_cache()
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir(parents=True, exist_ok=True)
    with Database(user=USER_UUID) as db:
        db.upsert_daily_health(DailyHealth("2026-05-20", None, None, 50, None, None, None, None, None))
        db.upsert_activity(_activity("recent_run", "2026-05-20T00:00:00+00:00"), provider="garmin")

    app = FastAPI()
    app.include_router(internal_router)
    client = TestClient(app, raise_server_exceptions=False)

    resp = client.post(
        f"/internal/training-load/backfill?user={USER_UUID}&as_of_date=2026-05-20",
        headers={"X-Internal-Token": INTERNAL_TOKEN},
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert body["calibration"]["id"] is not None
    assert body["load"]["activities_processed"] == 1

    with Database(user=USER_UUID) as db:
        assert db.query("SELECT COUNT(*) AS n FROM running_calibration_snapshot")[0]["n"] == 1
        assert db.fetch_activity_training_load("recent_run") is not None


def test_internal_training_load_calibration_refresh_updates_threshold_only(tmp_path, monkeypatch):
    import stride_core.db as core_db_mod
    import stride_server.deps as deps_mod

    monkeypatch.setenv("STRIDE_INTERNAL_TOKEN", INTERNAL_TOKEN)
    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
    monkeypatch.setattr(deps_mod, "USER_DATA_DIR", tmp_path)

    from stride_storage.sqlite.database import Database
    from stride_server.config import clear_server_config_cache
    from stride_server.routes.training_load import internal_router

    clear_server_config_cache()
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir(parents=True, exist_ok=True)
    with Database(user=USER_UUID) as db:
        db.upsert_daily_health(DailyHealth("2026-05-20", None, None, 50, None, None, None, None, None))
        db.upsert_activity(_activity("recent_run", "2026-05-20T00:00:00+00:00"), provider="garmin")

    app = FastAPI()
    app.include_router(internal_router)
    client = TestClient(app, raise_server_exceptions=False)

    resp = client.post(
        f"/internal/training-load/calibration/refresh?user={USER_UUID}&as_of_date=2026-05-20",
        headers={"X-Internal-Token": INTERNAL_TOKEN},
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert body["calibration"]["id"] is not None
    # threshold_speed_mps comes from running_calibration algorithm — approx 4.0 m/s
    assert body["calibration"]["threshold_speed_mps"] is not None

    with Database(user=USER_UUID) as db:
        # Task 4a pivot: calibration row now lives in running_calibration_snapshot
        assert db.query("SELECT COUNT(*) AS n FROM running_calibration_snapshot")[0]["n"] == 1
        assert db.query("SELECT COUNT(*) AS n FROM activity_training_load")[0]["n"] == 0
        assert db.query("SELECT COUNT(*) AS n FROM daily_training_load")[0]["n"] == 0
        # Verify the old training_load_calibration table does NOT exist post-pivot
        tables = {
            r["name"]
            for r in db.query(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='training_load_calibration'"
            )
        }
        assert "training_load_calibration" not in tables, (
            "training_load_calibration table still exists — pivot to "
            "running_calibration_snapshot may be incomplete"
        )


def test_rollout_backfill_skips_only_when_completion_marker_exists(
    tmp_path, monkeypatch
):
    import stride_core.db as core_db_mod
    import stride_server.deps as deps_mod
    import stride_server.routes.training_load as route_mod

    from stride_core.training_load import TRAINING_LOAD_MODEL_VERSION
    from stride_server.config import clear_server_config_cache
    from stride_storage.sqlite.database import Database

    monkeypatch.setenv("STRIDE_INTERNAL_TOKEN", INTERNAL_TOKEN)
    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
    monkeypatch.setattr(deps_mod, "USER_DATA_DIR", tmp_path)
    clear_server_config_cache()

    user_dir = tmp_path / USER_UUID
    user_dir.mkdir(parents=True, exist_ok=True)
    with Database(user=USER_UUID) as db:
        db._conn.execute(
            """INSERT INTO daily_training_load
               (date, algorithm_version, training_dose, coverage_status)
               VALUES ('2026-05-20', ?, 50, 'complete')""",
            (TRAINING_LOAD_MODEL_VERSION,),
        )
        db._conn.commit()
        db.mark_training_load_backfill_complete(
            TRAINING_LOAD_MODEL_VERSION, as_of_date="2026-05-20"
        )

    def fail_backfill(*_args, **_kwargs):
        raise AssertionError("completed rollout must not recompute canonical rows")

    monkeypatch.setattr(route_mod, "backfill_training_load", fail_backfill)
    app = FastAPI()
    app.include_router(route_mod.internal_router)
    client = TestClient(app, raise_server_exceptions=False)

    resp = client.post(
        f"/internal/training-load/backfill?user={USER_UUID}&only_if_missing=true",
        headers={"X-Internal-Token": INTERNAL_TOKEN},
    )

    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "ok": True,
        "user": USER_UUID,
        "algorithm_version": TRAINING_LOAD_MODEL_VERSION,
        "skipped": True,
        "reason": "backfill_already_complete",
        "calibration_lookback_days": 180,
        "load_lookback_days": 90,
    }


def test_backfill_step_skips_when_completion_marker_exists(tmp_path, monkeypatch):
    """A verified full-backfill marker skips API-owned shard work."""
    import stride_core.db as core_db_mod
    import stride_server.deps as deps_mod
    import stride_server.routes.training_load as route_mod

    from stride_core.training_load import TRAINING_LOAD_MODEL_VERSION
    from stride_server.config import clear_server_config_cache
    from stride_storage.sqlite.database import Database

    monkeypatch.setenv("STRIDE_INTERNAL_TOKEN", INTERNAL_TOKEN)
    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
    monkeypatch.setattr(deps_mod, "USER_DATA_DIR", tmp_path)
    clear_server_config_cache()

    user_dir = tmp_path / USER_UUID
    user_dir.mkdir(parents=True, exist_ok=True)
    with Database(user=USER_UUID) as db:
        db.mark_training_load_backfill_complete(
            TRAINING_LOAD_MODEL_VERSION, as_of_date="2026-05-20"
        )

    app = FastAPI()
    app.include_router(route_mod.internal_router)
    client = TestClient(app, raise_server_exceptions=False)

    resp = client.post(
        "/internal/training-load/backfill/step",
        json={"user": USER_UUID, "only_if_missing": True},
        headers={"X-Internal-Token": INTERNAL_TOKEN},
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["done"] is True
    assert body["skipped"] is True
    assert body["reason"] == "backfill_already_complete"
    assert body["algorithm_version"] == TRAINING_LOAD_MODEL_VERSION


def test_internal_training_load_routes_reject_non_uuid_user(tmp_path, monkeypatch):
    import stride_core.db as core_db_mod
    import stride_server.deps as deps_mod
    import stride_server.routes.training_load as route_mod

    from stride_server.config import clear_server_config_cache

    monkeypatch.setenv("STRIDE_INTERNAL_TOKEN", INTERNAL_TOKEN)
    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
    monkeypatch.setattr(deps_mod, "USER_DATA_DIR", tmp_path)
    clear_server_config_cache()

    app = FastAPI()
    app.include_router(route_mod.internal_router)
    client = TestClient(app, raise_server_exceptions=False)
    headers = {"X-Internal-Token": INTERNAL_TOKEN}
    invalid_user = "../escaped-user"

    calibration = client.post(
        "/internal/training-load/calibration/refresh",
        params={"user": invalid_user},
        headers=headers,
    )
    backfill = client.post(
        "/internal/training-load/backfill",
        params={"user": invalid_user},
        headers=headers,
    )
    shard = client.post(
        "/internal/training-load/backfill/step",
        json={"user": invalid_user},
        headers=headers,
    )

    assert calibration.status_code == 422
    assert backfill.status_code == 422
    assert shard.status_code == 422
    assert not (tmp_path.parent / "escaped-user").exists()
