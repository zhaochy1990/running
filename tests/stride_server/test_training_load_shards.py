from __future__ import annotations

from datetime import date
import json
import sqlite3

from fastapi import FastAPI
from fastapi.testclient import TestClient

from stride_core.training_load import TRAINING_LOAD_MODEL_VERSION
from stride_core.training_load.types import (
    CalibrationSnapshot,
    PriorLoadState,
    TrainingLoadRunSummary,
)
from stride_storage.sqlite.database import Database

USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
INTERNAL_TOKEN = "test-internal-token-very-secret"


def _client(tmp_path, monkeypatch) -> TestClient:
    import stride_core.db as core_db_mod
    import stride_server.deps as deps_mod
    import stride_server.routes.training_load as route_mod
    from stride_server.config import clear_server_config_cache

    monkeypatch.setenv("STRIDE_INTERNAL_TOKEN", INTERNAL_TOKEN)
    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
    monkeypatch.setattr(deps_mod, "USER_DATA_DIR", tmp_path)
    monkeypatch.setattr(
        route_mod,
        "_get_or_refresh_calibration",
        lambda _db, *, as_of, lookback_days: CalibrationSnapshot(
            id=7,
            as_of_date=as_of,
            threshold_speed_mps=4.0,
        ),
    )
    clear_server_config_cache()
    (tmp_path / USER_UUID).mkdir(parents=True, exist_ok=True)
    with Database(user=USER_UUID) as db:
        db._conn.execute(
            "INSERT INTO activities (label_id, sport_type, date) VALUES (?, ?, ?)",
            ("source", 100, "2025-05-20T00:00:00+00:00"),
        )
        db._conn.commit()

    app = FastAPI()
    app.include_router(route_mod.internal_router)
    return TestClient(app, raise_server_exceptions=False)


def _post_step(client: TestClient, **overrides) -> object:
    body = {
        "user": USER_UUID,
        "as_of_date": "2026-05-20",
        "shard_days": 30,
        "only_if_missing": True,
        **overrides,
    }
    return client.post(
        "/internal/training-load/backfill/step",
        json=body,
        headers={"X-Internal-Token": INTERNAL_TOKEN},
    )


def test_step_persists_progress_and_passes_prior_state_to_next_shard(
    tmp_path, monkeypatch
):
    import stride_server.routes.training_load as route_mod

    calls: list[tuple[date, date, PriorLoadState, int | None]] = []

    def fake_recompute(
        _db,
        *,
        start,
        end,
        prior_state,
        calibration_override,
        **_kwargs,
    ):
        calls.append((start, end, prior_state, calibration_override.id))
        next_state = PriorLoadState(
            acute_load=prior_state.acute_load + 10,
            chronic_load=prior_state.chronic_load + 2,
        )
        return TrainingLoadRunSummary(
            activities_processed=1,
            activity_rows_written=1,
            daily_rows_written=(end - start).days + 1,
            calibration_id=calibration_override.id,
            start=start,
            end=end,
            persist=True,
            final_state=next_state,
        )

    monkeypatch.setattr(route_mod, "recompute_training_load", fake_recompute)
    client = _client(tmp_path, monkeypatch)

    first = _post_step(client)
    second = _post_step(client)

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert calls[0] == (
        date(2025, 5, 20),
        date(2025, 6, 18),
        PriorLoadState(),
        7,
    )
    assert calls[1] == (
        date(2025, 6, 19),
        date(2025, 7, 18),
        PriorLoadState(acute_load=10, chronic_load=2),
        7,
    )
    assert first.json()["next_shard_start"] == "2025-06-19"
    assert second.json()["next_shard_start"] == "2025-07-19"
    with Database(user=USER_UUID) as db:
        progress = db.get_training_load_backfill_progress()
        assert progress is not None
        assert progress["next_start"] == "2025-07-19"
        assert progress["acute_load"] == 20
        assert progress["chronic_load"] == 4
        assert progress["calibration"]["id"] == 7


def test_step_resumes_after_database_reopen_and_marks_only_at_end(tmp_path, monkeypatch):
    import stride_server.routes.training_load as route_mod

    def fake_recompute(
        _db,
        *,
        start,
        end,
        prior_state,
        calibration_override,
        **_kwargs,
    ):
        return TrainingLoadRunSummary(
            activities_processed=0,
            activity_rows_written=0,
            daily_rows_written=(end - start).days + 1,
            calibration_id=calibration_override.id,
            start=start,
            end=end,
            persist=True,
            final_state=PriorLoadState(
                acute_load=prior_state.acute_load + 1,
                chronic_load=prior_state.chronic_load + 0.5,
            ),
        )

    monkeypatch.setattr(route_mod, "recompute_training_load", fake_recompute)
    client = _client(tmp_path, monkeypatch)

    responses = []
    for _ in range(20):
        response = _post_step(client, shard_days=45)
        assert response.status_code == 200, response.text
        responses.append(response.json())
        if response.json()["done"]:
            break

    assert responses[-1]["done"] is True
    assert len(responses) == 9
    with Database(user=USER_UUID) as db:
        assert db.is_training_load_backfill_complete(
            TRAINING_LOAD_MODEL_VERSION
        ) is True
        assert db.get_training_load_backfill_progress() is None


def test_step_returns_retryable_503_when_api_writer_is_busy(tmp_path, monkeypatch):
    from stride_server.sqlite_writer import try_user_sqlite_writer

    client = _client(tmp_path, monkeypatch)
    with try_user_sqlite_writer(USER_UUID) as acquired:
        assert acquired is True
        response = _post_step(client)

    assert response.status_code == 503
    assert response.headers["Retry-After"] == "2"


def test_step_translates_sqlite_lock_to_retryable_503_without_advancing(
    tmp_path, monkeypatch
):
    import stride_server.routes.training_load as route_mod

    monkeypatch.setattr(
        route_mod,
        "recompute_training_load",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            sqlite3.OperationalError("database is locked")
        ),
    )
    client = _client(tmp_path, monkeypatch)

    response = _post_step(client)

    assert response.status_code == 503
    assert response.headers["Retry-After"] == "2"
    with Database(user=USER_UUID) as db:
        progress = db.get_training_load_backfill_progress()
        assert progress is not None
        assert progress["next_start"] == progress["window_start"]
        assert db.is_training_load_backfill_complete(
            TRAINING_LOAD_MODEL_VERSION
        ) is False


def test_step_skips_empty_database_without_writing_progress(tmp_path, monkeypatch):
    import stride_core.db as core_db_mod
    import stride_server.deps as deps_mod
    import stride_server.routes.training_load as route_mod
    from stride_server.config import clear_server_config_cache

    monkeypatch.setenv("STRIDE_INTERNAL_TOKEN", INTERNAL_TOKEN)
    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
    monkeypatch.setattr(deps_mod, "USER_DATA_DIR", tmp_path)
    clear_server_config_cache()
    (tmp_path / USER_UUID).mkdir(parents=True, exist_ok=True)
    with Database(user=USER_UUID):
        pass
    app = FastAPI()
    app.include_router(route_mod.internal_router)
    client = TestClient(app, raise_server_exceptions=False)

    response = _post_step(client)

    assert response.status_code == 200
    assert response.json()["reason"] == "no_source_data"
    with Database(user=USER_UUID) as db:
        assert db.get_training_load_backfill_progress() is None
        assert db.is_training_load_backfill_complete(
            TRAINING_LOAD_MODEL_VERSION
        ) is False


def test_step_restart_clears_completion_marker_and_starts_from_zero(
    tmp_path, monkeypatch
):
    import stride_server.routes.training_load as route_mod

    calls: list[tuple[date, PriorLoadState]] = []

    def fake_recompute(
        _db,
        *,
        start,
        end,
        prior_state,
        calibration_override,
        **_kwargs,
    ):
        calls.append((start, prior_state))
        return TrainingLoadRunSummary(
            activities_processed=1,
            activity_rows_written=1,
            daily_rows_written=(end - start).days + 1,
            calibration_id=calibration_override.id,
            start=start,
            end=end,
            persist=True,
            final_state=PriorLoadState(acute_load=8, chronic_load=2),
        )

    monkeypatch.setattr(route_mod, "recompute_training_load", fake_recompute)
    client = _client(tmp_path, monkeypatch)
    with Database(user=USER_UUID) as db:
        db.mark_training_load_backfill_complete(
            TRAINING_LOAD_MODEL_VERSION, as_of_date="2026-05-20"
        )

    restarted = _post_step(
        client,
        only_if_missing=False,
        restart=True,
        restart_token="weekly:123:1",
    )
    retried = _post_step(
        client,
        only_if_missing=False,
        restart=True,
        restart_token="weekly:123:1",
    )

    assert restarted.status_code == 200, restarted.text
    assert restarted.json()["done"] is False
    assert retried.status_code == 200, retried.text
    assert calls == [
        (date(2025, 5, 20), PriorLoadState()),
        (date(2025, 6, 19), PriorLoadState(acute_load=8, chronic_load=2)),
    ]
    with Database(user=USER_UUID) as db:
        assert db.is_training_load_backfill_complete(
            TRAINING_LOAD_MODEL_VERSION
        ) is False


def test_completed_restart_token_is_idempotent_after_response_loss(
    tmp_path, monkeypatch
):
    import stride_server.routes.training_load as route_mod

    calls = 0

    def fake_recompute(
        _db,
        *,
        start,
        end,
        prior_state,
        calibration_override,
        **_kwargs,
    ):
        nonlocal calls
        calls += 1
        return TrainingLoadRunSummary(
            activities_processed=1,
            activity_rows_written=1,
            daily_rows_written=(end - start).days + 1,
            calibration_id=calibration_override.id,
            start=start,
            end=end,
            persist=True,
            final_state=PriorLoadState(
                acute_load=prior_state.acute_load + 1,
                chronic_load=prior_state.chronic_load + 0.5,
            ),
        )

    monkeypatch.setattr(route_mod, "recompute_training_load", fake_recompute)
    client = _client(tmp_path, monkeypatch)
    token = "weekly:456:1"

    response = _post_step(
        client,
        shard_days=45,
        only_if_missing=False,
        restart=True,
        restart_token=token,
    )
    while not response.json()["done"]:
        response = _post_step(
            client,
            shard_days=45,
            only_if_missing=False,
        )
        assert response.status_code == 200, response.text

    completed_calls = calls
    retried = _post_step(
        client,
        shard_days=45,
        only_if_missing=False,
        restart=True,
        restart_token=token,
    )

    assert retried.status_code == 200, retried.text
    assert retried.json()["done"] is True
    assert retried.json()["reason"] == "restart_already_complete"
    assert calls == completed_calls


def test_step_rejects_restart_when_only_if_missing_is_enabled(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)

    response = _post_step(
        client,
        restart=True,
        restart_token="weekly:123:1",
        only_if_missing=True,
    )

    assert response.status_code == 422


def test_step_rebuilds_malformed_progress_from_window_start(tmp_path, monkeypatch):
    import stride_server.routes.training_load as route_mod

    calls: list[tuple[date, PriorLoadState]] = []

    def fake_recompute(
        _db,
        *,
        start,
        end,
        prior_state,
        calibration_override,
        **_kwargs,
    ):
        calls.append((start, prior_state))
        return TrainingLoadRunSummary(
            activities_processed=1,
            activity_rows_written=1,
            daily_rows_written=(end - start).days + 1,
            calibration_id=calibration_override.id,
            start=start,
            end=end,
            persist=True,
            final_state=PriorLoadState(acute_load=1, chronic_load=0.5),
        )

    monkeypatch.setattr(route_mod, "recompute_training_load", fake_recompute)
    client = _client(tmp_path, monkeypatch)
    with Database(user=USER_UUID) as db:
        db.set_training_load_backfill_progress(
            {
                "schema_version": 1,
                "algorithm_version": TRAINING_LOAD_MODEL_VERSION,
                "window_start": "2025-05-20",
                "window_end": "2026-05-20",
                "next_start": "2030-01-01",
                "acute_load": 99,
                "chronic_load": 42,
                "calibration": {},
            }
        )

    response = _post_step(client)

    assert response.status_code == 200, response.text
    assert calls == [(date(2025, 5, 20), PriorLoadState())]


def test_step_advances_an_empty_shard_when_later_window_has_source(
    tmp_path, monkeypatch
):
    client = _client(tmp_path, monkeypatch)
    with Database(user=USER_UUID) as db:
        db._conn.execute("DELETE FROM activities")
        db._conn.execute(
            "INSERT INTO activities (label_id, sport_type, date) VALUES (?, ?, ?)",
            ("later-source", 100, "2026-05-01T00:00:00+00:00"),
        )
        db._conn.commit()

    response = _post_step(client)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["done"] is False
    assert body["shard"]["start"] == "2025-05-20"
    assert body["shard"]["end"] == "2025-06-18"
    assert body["shard"]["activities_processed"] == 0
    assert body["shard"]["daily_rows_written"] == 30
    with Database(user=USER_UUID) as db:
        rows = db.fetch_daily_training_load("2025-05-20", "2025-06-18")
        assert len(rows) == 30
        assert {row["coverage_status"] for row in rows} == {"unknown"}


def test_step_ignores_source_data_outside_backfill_window(tmp_path, monkeypatch):
    import stride_server.routes.training_load as route_mod

    client = _client(tmp_path, monkeypatch)
    monkeypatch.setattr(
        route_mod,
        "recompute_training_load",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("source outside the 365-day window must not run a shard")
        ),
    )
    with Database(user=USER_UUID) as db:
        db._conn.execute("DELETE FROM activities")
        db._conn.execute(
            "INSERT INTO activities (label_id, sport_type, date) VALUES (?, ?, ?)",
            ("too-old", 100, "2024-01-01T00:00:00+00:00"),
        )
        db._conn.commit()

    response = _post_step(client)

    assert response.status_code == 200, response.text
    assert response.json()["reason"] == "no_source_data"
    with Database(user=USER_UUID) as db:
        assert db.get_training_load_backfill_progress() is None
