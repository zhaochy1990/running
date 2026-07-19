from __future__ import annotations

import logging
import pytest
from datetime import date

from stride_core.models import ActivityDetail, TimeseriesPoint


class _RecordingHandler:
    def __init__(self, name: str, calls: list[str], *, applies: bool = True, fail: bool = False):
        self.name = name
        self._calls = calls
        self._applies = applies
        self._fail = fail

    def applies_to(self, context):
        return self._applies

    def run(self, context) -> None:
        self._calls.append(self.name)
        if self._fail:
            raise RuntimeError(f"boom:{self.name}")


def _make_run(label_id: str, date_iso: str, *, training_load: float | None = 123.0) -> ActivityDetail:
    return ActivityDetail(
        label_id=label_id,
        name="Run",
        sport_type=100,
        sport_name="Run",
        date=date_iso,
        distance_m=5000.0,
        duration_s=1800.0,
        avg_pace_s_km=360.0,
        adjusted_pace=None,
        best_km_pace=None,
        max_pace=None,
        avg_hr=150,
        max_hr=170,
        avg_cadence=180,
        max_cadence=190,
        avg_power=None,
        max_power=None,
        avg_step_len_cm=None,
        ascent_m=0.0,
        descent_m=0.0,
        calories_kcal=350,
        aerobic_effect=None,
        anaerobic_effect=None,
        training_load=training_load,
        vo2max=None,
        performance=None,
        train_type="Aerobic Endurance",
        temperature=None,
        humidity=None,
        feels_like=None,
        wind_speed=None,
        sport="run_outdoor",
        train_kind="aerobic",
        timeseries=[
            TimeseriesPoint(
                second * 100, 5000.0 * second / 1800.0, 150, 360.0,
                None, 180, 0.0, None,
            )
            for second in range(0, 1801, 30)
        ],
    )


def test_runner_orders_handlers_skips_inapplicable_and_isolates_failures(db, caplog):
    from stride_core.post_sync import PostSyncContext, run_post_sync_events

    calls: list[str] = []
    context = PostSyncContext(
        user="u",
        provider="coros",
        operation="sync",
        db=db,
        activity_label_ids=("a",),
    )
    handlers = (
        _RecordingHandler("first", calls),
        _RecordingHandler("skipped", calls, applies=False),
        _RecordingHandler("broken", calls, fail=True),
        _RecordingHandler("after", calls),
    )

    with caplog.at_level(logging.ERROR):
        run_post_sync_events(context, handlers=handlers)

    assert calls == ["first", "broken", "after"]
    assert "post-sync handler failed" in caplog.text
    assert "broken" in caplog.text


def test_stride_training_load_handler_recomputes_shanghai_tail(db, monkeypatch):
    from stride_core.post_sync import PostSyncContext, StrideTrainingLoadHandler

    # UTC 2026-05-01 16:30 is Shanghai 2026-05-02. The handler must derive
    # the affected date window via the canonical Shanghai calendar boundary.
    db.upsert_activity(_make_run("late_utc", "2026-05-01T16:30:00+00:00"), provider="coros")
    calls: list[dict] = []

    def fake_recompute(db_arg, **kwargs):
        calls.append(kwargs)

    monkeypatch.setattr("stride_core.post_sync.recompute_training_load", fake_recompute)
    monkeypatch.setattr(
        "stride_core.post_sync.backfill_training_load",
        lambda *_args, **_kwargs: pytest.fail("unexpected cold-start backfill"),
    )
    monkeypatch.setattr(
        db, "is_training_load_backfill_complete", lambda _version: True
    )
    monkeypatch.setattr("stride_core.post_sync.today_shanghai", lambda: __import__("datetime").date(2026, 5, 10))

    context = PostSyncContext(
        user="u",
        provider="coros",
        operation="sync",
        db=db,
        activity_label_ids=("late_utc",),
    )
    StrideTrainingLoadHandler(backoff_s=0).run(context)

    assert calls == [{"start": "2026-05-02", "end": "2026-05-10"}]


def test_stride_training_load_handler_recomputes_health_tail_from_earliest_changed_day(db, monkeypatch):
    from stride_core.models import DailyHealth
    from stride_core.post_sync import PostSyncContext, StrideTrainingLoadHandler

    db.upsert_daily_health(
        DailyHealth("20260502", None, None, 50, None, None, None, None, None)
    )
    calls: list[dict] = []
    monkeypatch.setattr(
        "stride_core.post_sync.recompute_training_load",
        lambda db_arg, **kwargs: calls.append(kwargs),
    )
    monkeypatch.setattr(
        "stride_core.post_sync.today_shanghai", lambda: date(2026, 5, 10)
    )
    monkeypatch.setattr(
        db, "is_training_load_backfill_complete", lambda _version: True
    )

    context = PostSyncContext(
        user="u",
        provider="coros",
        operation="health_only",
        db=db,
        activity_label_ids=(),
        health_dates=("2026-05-02", "2026-05-04"),
    )
    assert StrideTrainingLoadHandler().applies_to(context) is True
    StrideTrainingLoadHandler(backoff_s=0).run(context)

    assert calls == [{"start": "2026-05-02", "end": "2026-05-10"}]


def test_stride_training_load_handler_health_dates_survive_missing_activity_window(
    db, monkeypatch
):
    """Regression: when label_ids are present but the activity window lookup
    returns None (activities not yet in DB), health_dates must still drive
    a recompute — the early-return must not discard them."""
    from stride_core.post_sync import PostSyncContext, StrideTrainingLoadHandler

    calls: list[dict] = []
    monkeypatch.setattr(
        "stride_core.post_sync.recompute_training_load",
        lambda db_arg, **kwargs: calls.append(kwargs),
    )
    monkeypatch.setattr(
        "stride_core.post_sync.today_shanghai", lambda: date(2026, 5, 10)
    )
    monkeypatch.setattr(
        db, "is_training_load_backfill_complete", lambda _version: True
    )

    # label_id not present in DB → _activity_shanghai_window returns None.
    context = PostSyncContext(
        user="u",
        provider="coros",
        operation="sync",
        db=db,
        activity_label_ids=("ghost-label-not-in-db",),
        health_dates=("2026-05-03",),
    )
    StrideTrainingLoadHandler(backoff_s=0).run(context)

    # health_dates drove the recompute; no silent discard.
    assert calls == [{"start": "2026-05-03", "end": "2026-05-10"}]


def test_stride_training_load_handler_cold_start_backfills_full_warmup(db, monkeypatch):
    from stride_core.post_sync import PostSyncContext, StrideTrainingLoadHandler

    calls: list[dict] = []
    monkeypatch.setattr(
        "stride_core.post_sync.backfill_training_load",
        lambda db_arg, **kwargs: calls.append(kwargs),
    )
    monkeypatch.setattr(
        "stride_core.post_sync.recompute_training_load",
        lambda *_args, **_kwargs: pytest.fail("cold start must backfill"),
    )
    monkeypatch.setattr(
        "stride_core.post_sync.today_shanghai", lambda: date(2026, 5, 10)
    )

    StrideTrainingLoadHandler(backoff_s=0).run(PostSyncContext(
        user="u", provider="garmin", operation="sync", db=db,
        health_dates=("2026-05-02",),
    ))

    assert calls == [{
        "as_of_date": "2026-05-10",
        "load_lookback_days": 365,
        "calibration_lookback_days": 365,
        "persist": True,
    }]


def test_post_sync_result_runs_health_only_handlers(monkeypatch, tmp_path):
    from stride_core.post_sync import run_post_sync_for_result
    from stride_core.source import SyncResult
    from stride_storage.sqlite.database import Database

    calls: list[tuple[tuple[str, ...], tuple[str, ...]]] = []

    class HealthHandler:
        name = "health"

        def applies_to(self, context):
            return bool(context.health_dates)

        def run(self, context):
            calls.append((context.activity_label_ids, context.health_dates))

    monkeypatch.setattr(
        "stride_core.post_sync.Database",
        lambda user=None: Database(tmp_path / "health-only.db"),
    )
    run_post_sync_for_result(
        user="u",
        provider="garmin",
        operation="health_only",
        result=SyncResult(
            activities=0, health=7, activity_label_ids=(),
            health_dates=("2026-05-01", "2026-05-02"),
        ),
        handlers=(HealthHandler(),),
    )

    assert calls == [((), ("2026-05-01", "2026-05-02"))]


def test_stride_training_load_handler_recomputes_full_days_for_daily_totals(db):
    from stride_core.post_sync import PostSyncContext, StrideTrainingLoadHandler
    from datetime import date
    from stride_core.running_calibration import RunningCalibrationSnapshot
    from stride_core.training_load import (
        TRAINING_LOAD_MODEL_VERSION,
        recompute_training_load,
    )
    from stride_storage.sqlite.calibration_connector import SQLiteRunningCalibrationRepository

    SQLiteRunningCalibrationRepository(db).save_snapshot(
        RunningCalibrationSnapshot(
            as_of_date=date(2026, 5, 1), threshold_speed_mps=3.0
        )
    )

    db.upsert_activity(_make_run("run1", "2026-05-01T00:00:00+00:00"), provider="coros")
    db.upsert_activity(_make_run("run2", "2026-05-01T08:00:00+00:00"), provider="coros")

    recompute_training_load(db, start="2026-05-01", end="2026-05-01")
    db.mark_training_load_backfill_complete(
        TRAINING_LOAD_MODEL_VERSION, as_of_date="2026-05-01"
    )
    before = db.fetch_daily_training_load("2026-05-01", "2026-05-01")[0]["training_dose"]

    context = PostSyncContext(
        user="u",
        provider="coros",
        operation="sync",
        db=db,
        activity_label_ids=("run2",),
    )
    StrideTrainingLoadHandler(backoff_s=0).run(context)

    after = db.fetch_daily_training_load("2026-05-01", "2026-05-01")[0]["training_dose"]
    assert before > 0
    assert after == before
    assert db.fetch_activity_training_load("run1") is not None
    assert db.fetch_activity_training_load("run2") is not None


def test_stride_training_load_handler_persists_stride_tables_without_overwriting_vendor_load(db):
    from stride_core.post_sync import PostSyncContext, StrideTrainingLoadHandler

    db.upsert_activity(_make_run("run1", "2026-05-01T08:00:00+00:00", training_load=321.0))

    context = PostSyncContext(
        user="u",
        provider="coros",
        operation="sync",
        db=db,
        activity_label_ids=("run1",),
    )
    StrideTrainingLoadHandler(backoff_s=0).run(context)

    assert db.fetch_activity_training_load("run1") is not None
    assert db.fetch_daily_training_load("2026-05-01", "2026-05-01")
    row = db.query("SELECT training_load FROM activities WHERE label_id = ?", ("run1",))[0]
    assert row["training_load"] == 321.0


def test_stride_training_load_handler_retries_three_times_then_logs_error(db, monkeypatch, caplog):
    from stride_core.post_sync import PostSyncContext, StrideTrainingLoadHandler

    db.upsert_activity(_make_run("run1", "2026-05-01T08:00:00+00:00"))
    attempts = 0

    def fail_recompute(*_args, **_kwargs):
        nonlocal attempts
        attempts += 1
        raise RuntimeError("load failed")

    monkeypatch.setattr("stride_core.post_sync.recompute_training_load", fail_recompute)
    monkeypatch.setattr(
        db, "is_training_load_backfill_complete", lambda _version: True
    )
    context = PostSyncContext(
        user="u",
        provider="coros",
        operation="sync",
        db=db,
        activity_label_ids=("run1",),
    )

    with caplog.at_level(logging.ERROR):
        StrideTrainingLoadHandler(backoff_s=0).run(context)

    assert attempts == 3
    assert "STRIDE training-load post-sync failed" in caplog.text


def test_activity_commentary_handler_skips_disabled_and_existing_rows(db, monkeypatch):
    from stride_core.post_sync import ActivityCommentaryHandler, PostSyncContext

    db.upsert_activity(_make_run("run1", "2026-05-01T08:00:00+00:00"))
    db.upsert_activity_commentary("run1", "existing", generated_by="human")
    calls: list[str] = []

    monkeypatch.setattr("stride_server.commentary_ai.is_enabled", lambda: True)
    monkeypatch.setattr(
        "stride_server.commentary_ai.regenerate_and_save",
        lambda user, label_id, *, db=None: calls.append(label_id),
    )

    context = PostSyncContext(
        user="u",
        provider="garmin",
        operation="sync",
        db=db,
        activity_label_ids=("run1",),
    )
    ActivityCommentaryHandler().run(context)

    assert calls == []


def test_activity_commentary_handler_persists_missing_rows_before_return(db, monkeypatch):
    from stride_core.post_sync import ActivityCommentaryHandler, PostSyncContext

    db.upsert_activity(_make_run("run1", "2026-05-01T08:00:00+00:00"))
    calls: list[tuple[str, str]] = []

    monkeypatch.setattr("stride_server.commentary_ai.is_enabled", lambda: True)

    def fake_regenerate(user: str, label_id: str, *, db=None):
        calls.append((user, label_id))
        db.upsert_activity_commentary(label_id, "draft", generated_by="test")
        return {"commentary": "draft"}

    monkeypatch.setattr("stride_server.commentary_ai.regenerate_and_save", fake_regenerate)
    context = PostSyncContext(
        user="u",
        provider="garmin",
        operation="sync",
        db=db,
        activity_label_ids=("run1",),
    )
    ActivityCommentaryHandler().run(context)

    assert calls == [("u", "run1")]
    assert db.get_activity_commentary("run1") == "draft"


def test_ability_handler_forwards_label_ids(db, monkeypatch):
    from stride_core.post_sync import AbilityHandler, PostSyncContext

    calls: list[tuple[object, list[str]]] = []
    monkeypatch.setattr(
        "stride_core.post_sync.run_ability_hook",
        lambda db_arg, labels: calls.append((db_arg, labels)),
    )

    context = PostSyncContext(
        user="u",
        provider="coros",
        operation="sync",
        db=db,
        activity_label_ids=("a", "b"),
    )
    AbilityHandler().run(context)

    assert calls == [(db, ["a", "b"])]


def test_personal_bests_handler_registered_and_persists(db):
    from stride_core.post_sync import (
        DEFAULT_POST_SYNC_HANDLERS,
        PersonalBestsHandler,
        PostSyncContext,
    )
    from stride_core.pb_records import fetch_personal_bests

    assert any(h.name == "personal_bests" for h in DEFAULT_POST_SYNC_HANDLERS)

    db.upsert_activity(_make_run("run1", "2026-05-01T08:00:00+00:00"), provider="coros")
    # Table starts empty; the handler must populate it from the activity scan.
    assert fetch_personal_bests(db) == {}

    context = PostSyncContext(
        user="u", provider="coros", operation="sync", db=db, activity_label_ids=("run1",),
    )
    PersonalBestsHandler().run(context)

    pbs = fetch_personal_bests(db)
    assert "5K" in pbs and pbs["5K"]["pb_time_sec"]


def test_pb_candidates_drop_impossible_speed():
    """A GPS teleport (≈16.7 m/s 1K) must be dropped; a real 1K (3.3 m/s) kept.
    Guards the bogus-1K regression (e.g. 997 m credited in 31 s ≈ 32 m/s)."""
    from stride_core.pb_records import (
        MAX_PLAUSIBLE_SPEED_MPS,
        PB_DISPLAY_DISTANCES,
        best_effort_candidates_for_activity,
    )

    class _NoTimeseriesDb:
        def fetch_timeseries(self, _label_id):
            return []

    glitch = {"label_id": "g", "date": "2026-05-01T08:00:00+00:00",
              "distance_m": 1000.0, "duration_s": 60.0}    # 16.7 m/s
    cands = best_effort_candidates_for_activity(
        _NoTimeseriesDb(), glitch, distances=PB_DISPLAY_DISTANCES
    )
    assert all(c.distance_m / c.duration_s <= MAX_PLAUSIBLE_SPEED_MPS for c in cands)
    assert "1K" not in {c.distance for c in cands}

    real = {"label_id": "r", "date": "2026-05-01T08:00:00+00:00",
            "distance_m": 1000.0, "duration_s": 300.0}     # 3.3 m/s
    cands2 = best_effort_candidates_for_activity(
        _NoTimeseriesDb(), real, distances=PB_DISPLAY_DISTANCES
    )
    assert "1K" in {c.distance for c in cands2}


def test_persist_personal_bests_roundtrip_and_upsert(db):
    from stride_core.pb_records import (
        PB_DISPLAY_DISTANCES,
        detect_personal_bests,
        fetch_personal_bests,
        persist_personal_bests,
    )

    db.upsert_activity(_make_run("r1", "2026-05-01T08:00:00+00:00"), provider="coros")

    persisted = persist_personal_bests(db)
    fetched = fetch_personal_bests(db)
    # Table mirrors the live detector over the full DISPLAY superset (1K/3K/5K/
    # 10K/HM/FM), so /pbs + master-plan can share this one table.
    assert set(fetched) == set(detect_personal_bests(db, distances=PB_DISPLAY_DISTANCES))
    assert fetched["5K"]["pb_time_sec"] == persisted["5K"]["pb_time_sec"]
    # The nested entry (not just the scalar) survives the JSON round-trip: the
    # best-so-far history list reaches /pbs intact.
    hist = fetched["5K"]["history"]
    assert isinstance(hist, list) and hist
    assert "best_so_far_sec" in hist[0]

    # ON CONFLICT(distance) overwrites a stale row on the next persist.
    db._conn.execute("UPDATE personal_bests SET pb_time_sec = 99999 WHERE distance = '5K'")
    db._conn.commit()
    persist_personal_bests(db)
    assert fetch_personal_bests(db)["5K"]["pb_time_sec"] == persisted["5K"]["pb_time_sec"]


def test_load_personal_bests_no_rescan_for_pb_less_user(db, monkeypatch):
    """A user with zero qualifying activities is recorded as scanned, so
    load_personal_bests does NOT re-run the ~7s scan on every call."""
    import stride_core.pb_records as pb
    from stride_core.pb_records import load_personal_bests, personal_bests_scanned

    calls = {"n": 0}
    real_detect = pb.detect_personal_bests

    def counting_detect(*a, **k):
        calls["n"] += 1
        return real_detect(*a, **k)

    monkeypatch.setattr(pb, "detect_personal_bests", counting_detect)

    # Empty DB (no activities) → first load scans once, finds nothing, marks scanned.
    assert load_personal_bests(db) == {}
    assert personal_bests_scanned(db) is True
    assert calls["n"] == 1
    # Second load must read the (empty) marker, NOT re-scan.
    assert load_personal_bests(db) == {}
    assert calls["n"] == 1


def test_new_provider_only_needs_sync_result_label_ids_for_runner(db):
    from stride_core.post_sync import PostSyncContext, run_post_sync_events
    from stride_core.source import SyncResult

    calls: list[tuple[str, tuple[str, ...]]] = []
    result = SyncResult(activities=1, health=0, activity_label_ids=("x",))
    context = PostSyncContext(
        user="u",
        provider="fakewatch",
        operation="sync",
        db=db,
        activity_label_ids=result.activity_label_ids,
    )

    handler = _RecordingHandler("event", [])
    handler.run = lambda ctx: calls.append((ctx.provider, ctx.activity_label_ids))
    run_post_sync_events(context, handlers=(handler,))

    assert calls == [("fakewatch", ("x",))]
