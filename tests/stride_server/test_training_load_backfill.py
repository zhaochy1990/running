from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from stride_core.models import ActivityDetail, DailyHealth, TimeseriesPoint

USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
INTERNAL_TOKEN = "test-internal-token-very-secret"


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
