"""SQLite adapter for objective training-load recomputation."""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any, Callable, Iterable, Sequence

from stride_storage.sqlite.database import HRV_PREFERRED_PER_DATE_SQL
from stride_core.normalize import kind_from_legacy_train_type
from stride_core.timefmt import (
    SHANGHAI_DAY_SQL,
    parse_local_day,
    sqlite_mixed_date_expr,
    today_shanghai,
    utc_iso_to_shanghai_iso,
)

from .core import compute_activity_load, compute_daily_load_series
from .types import (
    TRAINING_LOAD_MODEL_VERSION,
    ActivityLoadInput,
    ActivityLoadResult,
    ActivitySample,
    CalibrationSnapshot,
    FeedbackRow,
    HealthRow,
    HrvRow,
    PriorLoadState,
    SessionClass,
    TrainingLoadBackfillSummary,
    TrainingLoadRunSummary,
)

_IN_CLAUSE_CHUNK = 500


def _parse_date(value: Any) -> date | None:
    return parse_local_day(value)


def _activity_shanghai_date(value: Any) -> date | None:
    local = utc_iso_to_shanghai_iso(str(value)) if value is not None else None
    return _parse_date(local)


def _sport_from_row(row: Any) -> str:
    sport = row["sport"] if "sport" in row.keys() else None
    if isinstance(sport, str) and sport.strip():
        return sport.strip()
    sport_type = row["sport_type"] if "sport_type" in row.keys() else None
    if sport_type in {100, 8001}:
        return "run_outdoor"
    if sport_type in {101, 8002, 8003}:
        return "run_indoor"
    if sport_type in {102, 8005}:
        return "run_trail"
    if sport_type in {103, 8004}:
        return "run_track"
    if sport_type == 104:
        return "run_treadmill"
    if sport_type in {800, 402}:
        return "strength"
    return "unknown"


def _session_class_from_row(row: Any, sport: str) -> SessionClass:
    train_kind = row["train_kind"] if "train_kind" in row.keys() else None
    if train_kind is None:
        legacy = row["train_type"] if "train_type" in row.keys() else None
        kind = kind_from_legacy_train_type(legacy)
        train_kind = kind.value if kind is not None else None
    key = str(train_kind or "").strip().lower()
    if key in {"base", "aerobic", "recovery"}:
        return SessionClass.EASY
    if key == "long_run":
        return SessionClass.LONG
    if key in {"threshold", "tempo"}:
        return SessionClass.TEMPO
    if key in {"interval", "vo2max", "anaerobic", "sprint"}:
        return SessionClass.INTERVAL
    if key == "race":
        return SessionClass.RACE
    if key == "strength":
        return SessionClass.STRENGTH
    if key in {"mobility", "yoga"}:
        return SessionClass.MOBILITY
    if sport == "strength":
        return SessionClass.STRENGTH
    if sport.startswith("run"):
        return SessionClass.EASY
    return SessionClass.UNKNOWN


def _as_speed_mps(value: Any) -> float | None:
    if value is None:
        return None
    try:
        speed = float(value)
    except (TypeError, ValueError):
        return None
    if speed <= 0:
        return None
    # Existing timeseries.speed stores pace in s/km. If a future adapter stores
    # m/s directly, keep small positive values as-is.
    return 1000.0 / speed if speed > 20 else speed


def _as_activity_distance_meters(value: Any) -> float | None:
    if value is None:
        return None
    try:
        distance = float(value)
    except (TypeError, ValueError):
        return None
    if distance <= 0:
        return None
    return distance


def _row_value(row: Any, key: str) -> Any:
    try:
        return row[key] if key in row.keys() else None
    except AttributeError:
        return row.get(key) if isinstance(row, dict) else None


def _activity_distance_from_db(db: Any, label_id: str) -> tuple[float | None, str | None, int | None]:
    rows = db.query(
        "SELECT distance_m, provider, sport_type FROM activities WHERE label_id = ? LIMIT 1",
        (label_id,),
    )
    if not rows:
        return None, None, None
    row = rows[0]
    sport_type = _row_value(row, "sport_type")
    try:
        sport_type_int = int(sport_type) if sport_type is not None else None
    except (TypeError, ValueError):
        sport_type_int = None
    return (
        _as_activity_distance_meters(_row_value(row, "distance_m")),
        _row_value(row, "provider"),
        sport_type_int,
    )


def _distance_scale_for_timeseries(
    rows: Sequence[Any],
    *,
    activity_distance_m: float | None,
    provider: str | None,
) -> float:
    distances: list[float] = []
    for row in rows:
        distance = _row_value(row, "distance")
        if distance is None:
            continue
        try:
            value = float(distance)
        except (TypeError, ValueError):
            continue
        if value > 0:
            distances.append(value)
    if not distances:
        return 1.0
    max_distance = max(distances)
    if activity_distance_m and activity_distance_m > 0:
        # Current DBs store timeseries distance in metres. Keep the ratio check
        # so pre-migration COROS centimetre rows remain readable.
        if max_distance / activity_distance_m > 20.0:
            return 0.01
        return 1.0
    if (provider or "").lower() == "coros" and max_distance > 10_000:
        return 0.01
    return 1.0


def _normalize_elapsed_seconds(rows: Iterable[Any]) -> tuple[float | None, ...]:
    raw: list[float | None] = []
    for row in rows:
        ts = row["timestamp"]
        if ts is None:
            raw.append(None)
            continue
        try:
            raw.append(float(ts))
        except (TypeError, ValueError):
            raw.append(None)
    present = [v for v in raw if v is not None]
    if not present:
        return tuple(raw)
    first = present[0]
    # Large first values are epoch-centiseconds (anchor to first sample); smaller
    # values are already activity-elapsed centiseconds and only need / 100.
    is_epoch_centiseconds = first > 1_000_000
    anchor = first if is_epoch_centiseconds else 0.0
    return tuple(
        None if v is None else round((v - anchor) / 100.0, 4)
        for v in raw
    )


def _fetch_samples(
    db: Any,
    label_id: str,
    *,
    provider: str | None = None,
    sport_type: int | None = None,
    activity_distance_m: float | None = None,
) -> tuple[ActivitySample, ...]:
    if activity_distance_m is None or provider is None or sport_type is None:
        db_distance_m, db_provider, db_sport_type = _activity_distance_from_db(db, label_id)
        activity_distance_m = activity_distance_m if activity_distance_m is not None else db_distance_m
        provider = provider if provider is not None else db_provider
        sport_type = sport_type if sport_type is not None else db_sport_type
    rows = db.query(
        """SELECT timestamp, distance, heart_rate, speed, altitude, power
           FROM timeseries WHERE label_id = ? ORDER BY id""",
        (label_id,),
    )
    elapsed = _normalize_elapsed_seconds(rows)
    distance_scale = _distance_scale_for_timeseries(
        rows,
        activity_distance_m=activity_distance_m,
        provider=provider,
    )
    samples: list[ActivitySample] = []
    for row, seconds in zip(rows, elapsed):
        distance = row["distance"]
        samples.append(
            ActivitySample(
                timestamp_s=seconds,
                elapsed_s=seconds,
                distance_m=float(distance) * distance_scale if distance is not None else None,
                heart_rate_bpm=float(row["heart_rate"]) if row["heart_rate"] is not None else None,
                speed_mps=_as_speed_mps(row["speed"]),
                altitude_m=float(row["altitude"]) if row["altitude"] is not None else None,
                power_w=float(row["power"]) if row["power"] is not None else None,
            )
        )
    return tuple(samples)


def _fetch_activity_rows(
    db: Any,
    *,
    start: date | None = None,
    end: date | None = None,
    label_ids: Sequence[str] | None = None,
) -> list[Any]:
    clauses: list[str] = []
    params: list[Any] = []
    if start is not None:
        clauses.append(f"{SHANGHAI_DAY_SQL} >= ?")
        params.append(start.isoformat())
    if end is not None:
        clauses.append(f"{SHANGHAI_DAY_SQL} <= ?")
        params.append(end.isoformat())
    if label_ids:
        placeholders = ",".join("?" for _ in label_ids)
        clauses.append(f"label_id IN ({placeholders})")
        params.extend(label_ids)
    where = "WHERE " + " AND ".join(clauses) if clauses else ""
    return db.query(f"SELECT * FROM activities {where} ORDER BY date, label_id", tuple(params))


def _mixed_date_bounds(
    day_sql: str,
    *,
    start: date | None = None,
    end: date | None = None,
) -> tuple[str, list[Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    if start is not None and end is not None:
        clauses.append(f"{day_sql} BETWEEN ? AND ?")
        params.extend([start.isoformat(), end.isoformat()])
    elif start is not None:
        clauses.append(f"{day_sql} >= ?")
        params.append(start.isoformat())
    elif end is not None:
        clauses.append(f"{day_sql} <= ?")
        params.append(end.isoformat())
    return (" WHERE " + " AND ".join(clauses) if clauses else "", params)


def _fetch_health_rows(db: Any, *, start: date | None = None, end: date | None = None) -> list[HealthRow]:
    day_sql = sqlite_mixed_date_expr("date")
    where, params = _mixed_date_bounds(day_sql, start=start, end=end)
    rows = db.query(f"SELECT *, {day_sql} AS normalized_date FROM daily_health{where} ORDER BY normalized_date", tuple(params))
    out: list[HealthRow] = []
    for row in rows:
        d = _parse_date(row["normalized_date"])
        if d is None:
            continue
        out.append(HealthRow(
            date=d,
            rhr=float(row["rhr"]) if row["rhr"] is not None else None,
            sleep_total_s=float(row["sleep_total_s"]) if "sleep_total_s" in row.keys() and row["sleep_total_s"] is not None else None,
            sleep_score=float(row["sleep_score"]) if "sleep_score" in row.keys() and row["sleep_score"] is not None else None,
        ))
    return out


def _fetch_hrv_rows(db: Any, *, start: date | None = None, end: date | None = None) -> list[HrvRow]:
    # Dedupe multi-provider rows per date (Garmin > COROS) so a dual-watch
    # user doesn't get both providers' values fed into the readiness model.
    day_sql = sqlite_mixed_date_expr("date")
    where, params = _mixed_date_bounds(day_sql, start=start, end=end)
    rows = db.query(
        "SELECT date, last_night_avg, status, "
        f"{day_sql} AS normalized_date FROM ({HRV_PREFERRED_PER_DATE_SQL})"
        f"{where} ORDER BY normalized_date",
        tuple(params),
    )
    out: list[HrvRow] = []
    for row in rows:
        d = _parse_date(row["normalized_date"])
        if d is None:
            continue
        out.append(HrvRow(
            date=d,
            last_night_avg=float(row["last_night_avg"]) if row["last_night_avg"] is not None else None,
            status=row["status"],
        ))
    return out


def _query_feedback_for_labels(db: Any, label_ids: Sequence[str]) -> list[Any]:
    out: list[Any] = []
    # SQLite caps host-parameter count (default 999 in older builds). Chunk
    # to keep multi-year recomputes safely below the limit.
    for i in range(0, len(label_ids), _IN_CLAUSE_CHUNK):
        chunk = label_ids[i : i + _IN_CLAUSE_CHUNK]
        placeholders = ",".join("?" for _ in chunk)
        out.extend(
            db.query(
                f"SELECT label_id, rpe FROM activity_feedback WHERE label_id IN ({placeholders})",
                tuple(chunk),
            )
        )
    return out


def _fetch_feedback_rows(db: Any, activity_rows: Sequence[Any]) -> list[FeedbackRow]:
    if not activity_rows:
        return []
    activity_dates = {row["label_id"]: _activity_shanghai_date(row["date"]) for row in activity_rows}
    duration_by_label = {
        row["label_id"]: (float(row["duration_s"]) / 60.0 if row["duration_s"] is not None else None)
        for row in activity_rows
    }
    rows = _query_feedback_for_labels(db, list(activity_dates.keys()))
    out: list[FeedbackRow] = []
    for row in rows:
        d = activity_dates.get(row["label_id"])
        if d is None:
            continue
        out.append(FeedbackRow(
            label_id=row["label_id"],
            activity_date=d,
            rpe=int(row["rpe"]) if row["rpe"] is not None else None,
            duration_minutes=duration_by_label.get(row["label_id"]),
        ))
    return out


def _last_persisted_daily_date(db: Any, *, before: date) -> date | None:
    """Date of the most recent persisted daily_training_load row strictly
    before ``before`` (None when none exists)."""
    row = db.fetch_previous_daily_training_load(before.isoformat())
    return _parse_date(row["date"]) if row is not None else None


def _load_prior_state(db: Any, series_start: date) -> PriorLoadState | None:
    """Read the last persisted daily_training_load row before series_start
    without inventing rest-day decay for dates whose coverage is unknown.
    """
    row = db.fetch_previous_daily_training_load(series_start.isoformat())
    if row is None:
        return None
    acute = float(row["acute_load"]) if row["acute_load"] is not None else 0.0
    chronic = float(row["chronic_load"]) if row["chronic_load"] is not None else 0.0
    return PriorLoadState(acute_load=acute, chronic_load=chronic)


def _build_activity_input(
    db: Any,
    row: Any,
    feedback_by_label: dict[str, Any] | None = None,
) -> ActivityLoadInput | None:
    activity_date = _activity_shanghai_date(row["date"])
    if activity_date is None:
        return None
    sport = _sport_from_row(row)
    if feedback_by_label is None:
        feedback = db.get_activity_feedback(row["label_id"])
    else:
        feedback = feedback_by_label.get(row["label_id"])
    rpe = feedback["rpe"] if feedback is not None and feedback["rpe"] is not None else None
    return ActivityLoadInput(
        label_id=row["label_id"],
        activity_date=activity_date,
        sport=sport,
        session_class=_session_class_from_row(row, sport),
        duration_s=float(row["duration_s"]) if row["duration_s"] is not None else None,
        distance_m=_as_activity_distance_meters(row["distance_m"]),
        ascent_m=float(row["ascent_m"]) if "ascent_m" in row.keys() and row["ascent_m"] is not None else None,
        descent_m=float(row["descent_m"]) if "descent_m" in row.keys() and row["descent_m"] is not None else None,
        avg_hr=float(row["avg_hr"]) if "avg_hr" in row.keys() and row["avg_hr"] is not None else None,
        max_hr=float(row["max_hr"]) if "max_hr" in row.keys() and row["max_hr"] is not None else None,
        avg_power=float(row["avg_power"]) if "avg_power" in row.keys() and row["avg_power"] is not None else None,
        calories_kcal=float(row["calories_kcal"]) if "calories_kcal" in row.keys() and row["calories_kcal"] is not None else None,
        samples=_fetch_samples(
            db,
            row["label_id"],
            provider=row["provider"] if "provider" in row.keys() else None,
            sport_type=int(row["sport_type"]) if row["sport_type"] is not None else None,
            activity_distance_m=_as_activity_distance_meters(row["distance_m"]),
        ),
        rpe=int(rpe) if rpe is not None else None,
    )


def _build_activity_inputs(db: Any, activity_rows: Sequence[Any]) -> list[ActivityLoadInput]:
    labels = [row["label_id"] for row in activity_rows]
    feedback_rows = _query_feedback_for_labels(db, labels) if labels else []
    feedback_by_label = {row["label_id"]: row for row in feedback_rows}
    return [
        activity
        for row in activity_rows
        if (activity := _build_activity_input(db, row, feedback_by_label)) is not None
    ]


def _stream_activity_results(
    db: Any,
    activity_rows: Sequence[Any],
    calibration: CalibrationSnapshot,
    *,
    progress: Callable[[int, int], None] | None = None,
) -> list[ActivityLoadResult]:
    """Compute each activity's load one at a time, releasing its samples before
    moving to the next row.

    Backfilling a full year would otherwise materialise every activity's
    timeseries at once (``_build_activity_inputs`` holds them all), spiking peak
    memory proportional to the whole corpus. Building one ``ActivityLoadInput``,
    computing the small ``ActivityLoadResult``, then dropping the input keeps
    peak memory bounded to a single activity's samples. Feedback is still
    batch-fetched (no N+1).
    """
    labels = [row["label_id"] for row in activity_rows]
    feedback_rows = _query_feedback_for_labels(db, labels) if labels else []
    feedback_by_label = {row["label_id"]: row for row in feedback_rows}

    total = len(activity_rows)
    results: list[Any] = []
    processed = 0
    for row in activity_rows:
        activity = _build_activity_input(db, row, feedback_by_label)
        processed += 1
        if activity is not None:
            results.append(compute_activity_load(activity, calibration))
        # Drop the input (and its samples) before the next iteration.
        del activity
        if progress is not None:
            progress(processed, total)
    return results



def _fetch_latest_calibration(
    db: Any, *, as_of_date: date | None = None
) -> CalibrationSnapshot | None:
    from stride_storage.sqlite.calibration_connector import SQLiteRunningCalibrationRepository

    repo = SQLiteRunningCalibrationRepository(db)
    repo.ensure_schema()
    snapshot = repo.fetch_latest(as_of_date=as_of_date)
    if snapshot is None:
        return None
    return CalibrationSnapshot(
        as_of_date=snapshot.as_of_date,
        rhr_baseline=snapshot.rhr_baseline,
        hrmax_estimate=snapshot.hrmax_estimate,
        threshold_hr=snapshot.threshold_hr,
        threshold_speed_mps=snapshot.threshold_speed_mps,
        critical_power_w=snapshot.critical_power_w,
        source=snapshot.source if isinstance(snapshot.source, dict) else {},
        id=int(snapshot.id) if snapshot.id is not None else None,
        algorithm_version=snapshot.algorithm_version,
    )


def refresh_training_load_calibration(
    db: Any,
    *,
    as_of_date: str | date | None = None,
    lookback_days: int = 180,
    persist: bool = True,
) -> CalibrationSnapshot:
    """Recompute thresholds via running_calibration module and persist to running_calibration_snapshot.

    `running_calibration.recompute_running_calibration` now computes
    `rhr_baseline` (P10/90d) and `critical_power_w` natively via
    `daily_health` + activity power. No manual augmentation needed.
    """
    from stride_core.running_calibration import recompute_running_calibration
    from stride_storage.sqlite.calibration_connector import SQLiteRunningCalibrationRepository

    as_of = _parse_date(as_of_date) or today_shanghai()
    repo = SQLiteRunningCalibrationRepository(db)
    summary = recompute_running_calibration(
        repo,
        as_of_date=as_of,
        lookback_days=lookback_days,
        persist=persist,
    )
    snap = summary.snapshot

    return CalibrationSnapshot(
        as_of_date=snap.as_of_date,
        rhr_baseline=snap.rhr_baseline,
        hrmax_estimate=snap.hrmax_estimate,
        threshold_hr=snap.threshold_hr,
        threshold_speed_mps=snap.threshold_speed_mps,
        critical_power_w=snap.critical_power_w,
        source=snap.source if isinstance(snap.source, dict) else {},
        id=snap.id,
        algorithm_version=snap.algorithm_version,
    )


def recompute_training_load(
    db: Any,
    *,
    start: str | date | None = None,
    end: str | date | None = None,
    label_ids: Sequence[str] | None = None,
    persist: bool = True,
    prior_state: PriorLoadState | None = None,
    calibration_override: CalibrationSnapshot | None = None,
    progress: Callable[[int, int], None] | None = None,
) -> TrainingLoadRunSummary:
    """Recompute objective activity and daily training-load rows.

    This is the DB adapter entry point for the current model; it does not alter
    vendor-provided training-load fields.

    When ``start`` is provided without an explicit ``prior_state``, the most
    recent persisted ``daily_training_load`` row before the window is loaded
    so the rolling ATL/CTL continues instead of restarting at zero.

    ``progress`` (if given) is called ``progress(processed, total)`` as each
    activity is computed so a worker can surface backfill progress. ``processed``
    is monotonic, ``total`` is stable across calls, and the final tick satisfies
    ``processed == total``.
    """
    start_date = _parse_date(start)
    end_date = _parse_date(end)
    labels = list(label_ids) if label_ids is not None else None
    activity_rows = _fetch_activity_rows(db, start=start_date, end=end_date, label_ids=labels)
    # Activity dates are derived from the row alone (no timeseries) — safe to
    # compute up front without materialising any samples.
    activity_dates = [
        d for row in activity_rows if (d := _activity_shanghai_date(row["date"])) is not None
    ]
    if not activity_dates:
        # An explicit calendar window can legitimately contain no activities.
        # Continue when a health row confirms rest or an earlier v2 PMC state
        # exists so an unknown-coverage placeholder can preserve the calendar
        # series without decaying ATL/CTL. A completely empty database still
        # has no evidence from which to manufacture a series.
        has_health_coverage = bool(
            start_date is not None
            and _fetch_health_rows(db, start=start_date, end=end_date)
        )
        has_prior_state = bool(
            start_date is not None
            and db.fetch_previous_daily_training_load(start_date.isoformat())
        )
        if start_date is None or not (has_health_coverage or has_prior_state):
            if progress is not None:
                progress(0, 0)
            return TrainingLoadRunSummary(0, 0, 0, None, start_date, end_date, persist)

    series_start = start_date or min(activity_dates)
    series_end = end_date or today_shanghai()

    # Gap-fill: when an explicit window begins more than one day after the last
    # persisted daily row, extend the window back to the day after that row so
    # the intervening rest days are written as zero-dose rows. Post-sync calls
    # recompute with start=end=<synced day>; a rest day that falls between two
    # sync batches is otherwise never inside any window and its daily row is
    # never written, leaving holes the charts skip (Dose/ATL-CTL/Form all gap).
    # Re-fetch over the widened window so any activity on the gap days is picked
    # up too, not just the originally-requested ones.
    if prior_state is None and start_date is not None:
        prior_date = _last_persisted_daily_date(db, before=series_start)
        if prior_date is not None and series_start - prior_date > timedelta(days=1):
            series_start = prior_date + timedelta(days=1)
            activity_rows = _fetch_activity_rows(db, start=series_start, end=series_end, label_ids=None)

    as_of = series_end
    calibration = calibration_override or _fetch_latest_calibration(db, as_of_date=as_of) or CalibrationSnapshot(
        as_of_date=as_of,
    )
    calibration_id = calibration.id
    # Stream per-activity: build one input (with samples), compute, release, so
    # a year-long backfill never holds every activity's timeseries at once.
    activity_results = _stream_activity_results(
        db, activity_rows, calibration, progress=progress
    )
    health_rows = _fetch_health_rows(db, start=series_start, end=series_end)
    hrv_rows = _fetch_hrv_rows(db, start=series_start, end=series_end)
    feedback_rows = _fetch_feedback_rows(db, activity_rows)
    if prior_state is None and start_date is not None:
        prior_state = _load_prior_state(db, series_start)
    daily_results = compute_daily_load_series(
        activity_results,
        health_rows,
        hrv_rows,
        feedback_rows,
        series_start,
        series_end,
        prior_state=prior_state,
    )
    if persist:
        # Upsert activity results and daily results within a single transaction
        # (commit=False), then one commit — a mid-backfill failure leaves no
        # half-written current-model daily rows behind.
        for result in activity_results:
            db.upsert_activity_training_load(result, commit=False)
        for result in daily_results:
            db.upsert_daily_training_load(result, commit=False)
        db.commit()
    return TrainingLoadRunSummary(
        activities_processed=len(activity_results),
        activity_rows_written=len(activity_results) if persist else 0,
        daily_rows_written=len(daily_results) if persist else 0,
        calibration_id=calibration_id,
        start=series_start,
        end=series_end,
        persist=persist,
    )


def backfill_training_load(
    db: Any,
    *,
    as_of_date: str | date | None = None,
    calibration_lookback_days: int = 180,
    load_lookback_days: int = 90,
    persist: bool = True,
) -> TrainingLoadBackfillSummary:
    as_of = _parse_date(as_of_date) or today_shanghai()
    calibration = refresh_training_load_calibration(
        db,
        as_of_date=as_of,
        lookback_days=calibration_lookback_days,
        persist=persist,
    )
    load_start = as_of - timedelta(days=max(0, load_lookback_days))
    # A full backfill (or algorithm upgrade) must rebuild the PMC series from a
    # zero prior state inside the window, never seed off an older algorithm's
    # canonical prior. Incremental recomputes still read the canonical prior.
    load = recompute_training_load(
        db,
        start=load_start,
        end=as_of,
        persist=persist,
        prior_state=PriorLoadState(),
        calibration_override=calibration,
    )
    # Mark backfill completion only on a verified full success: a real 365-day
    # (or longer) persisted window that actually wrote daily rows. A shorter
    # manual backfill (default 90d) must not claim the rollout is complete.
    if (
        persist
        and load_lookback_days >= 365
        and load.daily_rows_written > 0
    ):
        db.mark_training_load_backfill_complete(
            TRAINING_LOAD_MODEL_VERSION, as_of.isoformat()
        )
    return TrainingLoadBackfillSummary(
        calibration=calibration,
        load=load,
        calibration_lookback_days=calibration_lookback_days,
        load_lookback_days=load_lookback_days,
    )
