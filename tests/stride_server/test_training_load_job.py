"""Tests for the async ``training_load_backfill`` worker handler.

The deploy rollout enqueues one ``training_load_backfill`` job per user instead
of running the 365-day backfill inline inside the request (which 504s past the
ACA 240s budget). These tests pin the handler's contract:

- it is registered under ``training_load_backfill``
- when a current-version running_calibration snapshot already exists it REUSES
  it (recompute only) rather than refreshing calibration + rescanning history
- it reports training_load progress via ``heartbeat``
- an empty activities+health DB returns ``skipped=no_source_data`` (not a 500)
"""

from __future__ import annotations

from datetime import date
from types import SimpleNamespace

import pytest

from stride_core.models import ActivityDetail, DailyHealth, TimeseriesPoint
from stride_core.training_load import TRAINING_LOAD_MODEL_VERSION
from stride_core.running_calibration import (
    RUNNING_CALIBRATION_MODEL_VERSION,
    CalibrationConfidence,
    RunningCalibrationSnapshot,
)
from stride_storage.interfaces.jobs import JobRecord, JobStatus
from stride_storage.sqlite.calibration_connector import SQLiteRunningCalibrationRepository
from stride_storage.sqlite.database import Database

USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"


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


def _save_snapshot(db, *, as_of_date: date) -> int:
    repo = SQLiteRunningCalibrationRepository(db)
    snap = RunningCalibrationSnapshot(
        as_of_date=as_of_date,
        algorithm_version=RUNNING_CALIBRATION_MODEL_VERSION,
        threshold_hr=170.0,
        threshold_speed_mps=4.0,
        threshold_hr_confidence=CalibrationConfidence.MEDIUM,
        threshold_speed_confidence=CalibrationConfidence.MEDIUM,
        rhr_baseline=50.0,
        observed_max_hr=186.0,
        hrmax_estimate=186.0,
        hrmax_confidence=CalibrationConfidence.MEDIUM,
    )
    return repo.save_snapshot(snap)


def _job(*, input_json: str | None = None) -> JobRecord:
    return JobRecord(
        job_id="tl-job-1",
        partition_key=USER_UUID,
        job_type="training_load_backfill",
        status=JobStatus.RUNNING,
        input_json=input_json,
    )


def _get_handler():
    from stride_server.jobs.handlers import ensure_handlers_registered
    from stride_server.jobs.registry import get_handler

    ensure_handlers_registered()
    return get_handler("training_load_backfill")


def test_training_load_backfill_handler_registered():
    assert _get_handler() is not None


def test_handler_reuses_existing_snapshot_without_refreshing_calibration(tmp_path, monkeypatch):
    import stride_core.db as core_db_mod

    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
    (tmp_path / USER_UUID).mkdir(parents=True, exist_ok=True)
    with Database(user=USER_UUID) as db:
        _save_snapshot(db, as_of_date=date(2026, 5, 20))
        db.upsert_daily_health(DailyHealth("2026-05-20", None, None, 50, None, None, None, None, None))
        db.upsert_activity(_activity("recent_run", "2026-05-20T00:00:00+00:00"), provider="garmin")

    def fail_refresh(*_args, **_kwargs):
        raise AssertionError("handler must reuse the existing snapshot, not refresh calibration")

    # A snapshot already exists → the handler must NOT re-fit athlete baselines.
    monkeypatch.setattr(
        "stride_core.training_load.refresh_training_load_calibration", fail_refresh, raising=False
    )

    handler = _get_handler()
    assert handler is not None
    heartbeats: list[dict] = []
    result = handler(_job(), heartbeat=lambda **kw: heartbeats.append(kw))

    assert result.get("skipped") is not True
    with Database(user=USER_UUID) as db:
        assert db.fetch_activity_training_load("recent_run") is not None
        assert db.query("SELECT COUNT(*) AS n FROM running_calibration_snapshot")[0]["n"] == 1
        assert db.is_training_load_backfill_complete(
            TRAINING_LOAD_MODEL_VERSION
        ) is True
    assert any(hb.get("stage") == "training_load" for hb in heartbeats)


def test_handler_short_backfill_does_not_mark_full_rollout_complete(
    tmp_path, monkeypatch
):
    import json
    import stride_core.db as core_db_mod

    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
    (tmp_path / USER_UUID).mkdir(parents=True, exist_ok=True)
    with Database(user=USER_UUID) as db:
        _save_snapshot(db, as_of_date=date(2026, 5, 20))
        db.upsert_activity(
            _activity("recent_run", "2026-05-20T00:00:00+00:00"),
            provider="garmin",
        )

    handler = _get_handler()
    assert handler is not None
    result = handler(
        _job(
            input_json=json.dumps(
                {
                    "as_of_date": "2026-05-20",
                    "load_lookback_days": 90,
                    "only_if_missing": False,
                }
            )
        ),
        heartbeat=lambda **_kw: None,
    )

    assert result["load"]["daily_rows_written"] > 0
    with Database(user=USER_UUID) as db:
        assert db.is_training_load_backfill_complete(
            TRAINING_LOAD_MODEL_VERSION
        ) is False


def test_handler_reports_training_load_progress_via_heartbeat(tmp_path, monkeypatch):
    import stride_core.db as core_db_mod

    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
    (tmp_path / USER_UUID).mkdir(parents=True, exist_ok=True)
    with Database(user=USER_UUID) as db:
        _save_snapshot(db, as_of_date=date(2026, 5, 20))
        for day in range(1, 6):
            db.upsert_activity(
                _activity(f"run{day}", f"2026-05-0{day}T00:00:00+00:00"), provider="garmin"
            )

    handler = _get_handler()
    assert handler is not None
    heartbeats: list[dict] = []
    handler(_job(), heartbeat=lambda **kw: heartbeats.append(kw))

    pcts = [hb["progress_pct"] for hb in heartbeats if hb.get("progress_pct") is not None]
    assert pcts, "handler must report progress via heartbeat"
    assert pcts == sorted(pcts), "progress must be monotonic"
    assert pcts[-1] == 100


def test_handler_fails_when_source_exists_but_backfill_writes_no_daily_rows(
    tmp_path, monkeypatch
):
    import stride_core.db as core_db_mod

    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
    (tmp_path / USER_UUID).mkdir(parents=True, exist_ok=True)
    with Database(user=USER_UUID) as db:
        _save_snapshot(db, as_of_date=date(2026, 5, 20))
        db.upsert_activity(
            _activity("historical_run", "2020-05-20T00:00:00+00:00"),
            provider="garmin",
        )

    monkeypatch.setattr(
        "stride_core.training_load.recompute_training_load",
        lambda *_args, **_kwargs: SimpleNamespace(
            activities_processed=0,
            daily_rows_written=0,
            start=date(2025, 5, 20),
            end=date(2026, 5, 20),
        ),
    )

    handler = _get_handler()
    assert handler is not None
    with pytest.raises(RuntimeError, match="no daily training-load rows"):
        handler(_job(), heartbeat=lambda **_kw: None)
    with Database(user=USER_UUID) as db:
        assert db.is_training_load_backfill_complete(
            TRAINING_LOAD_MODEL_VERSION
        ) is False


def test_handler_skips_no_source_data_on_empty_db(tmp_path, monkeypatch):
    import stride_core.db as core_db_mod

    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
    (tmp_path / USER_UUID).mkdir(parents=True, exist_ok=True)
    with Database(user=USER_UUID):
        pass

    handler = _get_handler()
    assert handler is not None
    result = handler(_job(), heartbeat=lambda **kw: None)

    assert result == {"skipped": True, "reason": "no_source_data"}
    with Database(user=USER_UUID) as db:
        assert db.is_training_load_backfill_complete(
            TRAINING_LOAD_MODEL_VERSION
        ) is False


def test_handler_skips_only_when_completion_marker_exists(tmp_path, monkeypatch):
    import json
    import stride_core.db as core_db_mod

    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
    (tmp_path / USER_UUID).mkdir(parents=True, exist_ok=True)
    with Database(user=USER_UUID) as db:
        db.mark_training_load_backfill_complete(
            TRAINING_LOAD_MODEL_VERSION, as_of_date="2026-05-20"
        )

    monkeypatch.setattr(
        "stride_core.training_load.recompute_training_load",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("completed backfill must not recompute")
        ),
    )

    handler = _get_handler()
    assert handler is not None
    result = handler(
        _job(input_json=json.dumps({"only_if_missing": True})),
        heartbeat=lambda **_kw: None,
    )

    assert result == {
        "skipped": True,
        "reason": "backfill_already_complete",
        "algorithm_version": TRAINING_LOAD_MODEL_VERSION,
    }
