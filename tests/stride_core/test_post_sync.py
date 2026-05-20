from __future__ import annotations

import logging
import threading
import time

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
        distance_m=5.0,
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
            TimeseriesPoint(0, 0.0, 145, 360.0, None, 178, 0.0, None),
            TimeseriesPoint(3000, 5000.0, 150, 360.0, None, 180, 0.0, None),
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


def test_stride_training_load_handler_recomputes_shanghai_label_window(db, monkeypatch):
    from stride_core.post_sync import PostSyncContext, StrideTrainingLoadHandler

    # UTC 2026-05-01 16:30 is Shanghai 2026-05-02. The handler must derive
    # the affected date window via the canonical Shanghai calendar boundary.
    db.upsert_activity(_make_run("late_utc", "2026-05-01T16:30:00+00:00"), provider="coros")
    calls: list[dict] = []

    def fake_recompute(db_arg, **kwargs):
        calls.append(kwargs)

    monkeypatch.setattr("stride_core.post_sync.recompute_training_load", fake_recompute)

    context = PostSyncContext(
        user="u",
        provider="coros",
        operation="sync",
        db=db,
        activity_label_ids=("late_utc",),
    )
    StrideTrainingLoadHandler(backoff_s=0).run(context)

    assert calls == [{"start": "2026-05-02", "end": "2026-05-02"}]


def test_stride_training_load_handler_recomputes_full_days_for_daily_totals(db):
    from stride_core.post_sync import PostSyncContext, StrideTrainingLoadHandler
    from stride_core.training_load import recompute_training_load

    db.upsert_activity(_make_run("run1", "2026-05-01T00:00:00+00:00"), provider="coros")
    db.upsert_activity(_make_run("run2", "2026-05-01T08:00:00+00:00"), provider="coros")

    recompute_training_load(db, start="2026-05-01", end="2026-05-01")
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


def test_activity_commentary_handler_generates_missing_rows_provider_neutral(db, monkeypatch):
    from stride_core.post_sync import ActivityCommentaryHandler, PostSyncContext

    db.upsert_activity(_make_run("run1", "2026-05-01T08:00:00+00:00"))
    calls: list[tuple[str, str]] = []
    generated = threading.Event()

    monkeypatch.setattr("stride_server.commentary_ai.is_enabled", lambda: True)

    def fake_generate(user: str, label_id: str, **_kwargs):
        calls.append((user, label_id))
        generated.set()
        return {"commentary": "draft"}

    monkeypatch.setattr("stride_server.commentary_ai.regenerate_and_save", fake_generate)
    monkeypatch.setattr("stride_server.commentary_ai.maybe_generate_for_new_activity", fake_generate)
    context = PostSyncContext(
        user="u",
        provider="garmin",
        operation="sync",
        db=db,
        activity_label_ids=("run1",),
    )
    ActivityCommentaryHandler().run(context)

    assert generated.wait(1)
    assert calls == [("u", "run1")]


def test_activity_commentary_handler_does_not_block_on_generation(db, monkeypatch):
    from stride_core.post_sync import ActivityCommentaryHandler, PostSyncContext

    db.upsert_activity(_make_run("run1", "2026-05-01T08:00:00+00:00"))
    calls: list[tuple[str, str]] = []
    generated = threading.Event()

    monkeypatch.setattr("stride_server.commentary_ai.is_enabled", lambda: True)

    def slow_generate(user: str, label_id: str, **_kwargs):
        time.sleep(0.25)
        calls.append((user, label_id))
        generated.set()
        return {"commentary": "draft"}

    monkeypatch.setattr("stride_server.commentary_ai.regenerate_and_save", slow_generate)
    monkeypatch.setattr("stride_server.commentary_ai.maybe_generate_for_new_activity", slow_generate)
    context = PostSyncContext(
        user="u",
        provider="coros",
        operation="sync",
        db=db,
        activity_label_ids=("run1",),
    )

    started = time.perf_counter()
    ActivityCommentaryHandler().run(context)
    elapsed = time.perf_counter() - started

    assert elapsed < 0.1
    assert calls == []
    assert generated.wait(1)
    assert calls == [("u", "run1")]


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
