"""SQLite adapter for objective training-load recomputation."""

from __future__ import annotations

from datetime import date
from typing import Any, Iterable, Sequence

from stride_core.normalize import kind_from_legacy_train_type
from stride_core.timefmt import SHANGHAI_DAY_SQL, utc_iso_to_shanghai_iso

from .calibration import estimate_calibration
from .core import compute_activity_load, compute_daily_load_series
from .types import (
    ActivityLoadInput,
    ActivitySample,
    CalibrationActivity,
    CalibrationHealthRow,
    CalibrationSample,
    CalibrationSnapshot,
    FeedbackRow,
    HealthRow,
    HrvRow,
    PriorLoadState,
    SessionClass,
    TrainingLoadRunSummary,
)

_IN_CLAUSE_CHUNK = 500


def _parse_date(value: Any) -> date | None:
    if isinstance(value, date):
        return value
    if value is None:
        return None
    text = str(value).strip()
    if len(text) >= 10 and text[4] == "-":
        return date.fromisoformat(text[:10])
    if len(text) == 8 and text.isdigit():
        return date(int(text[:4]), int(text[4:6]), int(text[6:8]))
    return None


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
    # activities.distance_m is a legacy name. Current COROS/Garmin sync stores
    # activity distances in kilometers; older/local tests may still use meters.
    return distance * 1000.0 if distance < 500 else distance


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
        # COROS frequencyList stores distance in centimeters; Garmin details
        # stores meters. Compare against normalized activity distance so local
        # test fixtures that already use meters are preserved.
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


def _fetch_calibration_samples(
    db: Any,
    label_id: str,
    *,
    provider: str | None = None,
    sport_type: int | None = None,
    activity_distance_m: float | None = None,
) -> tuple[CalibrationSample, ...]:
    return tuple(
        _fetch_samples(
            db,
            label_id,
            provider=provider,
            sport_type=sport_type,
            activity_distance_m=activity_distance_m,
        )
    )


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


def _date_range_clause(
    start: date | None, end: date | None,
) -> tuple[str, tuple[str, ...]]:
    clauses: list[str] = []
    params: list[str] = []
    if start is not None:
        clauses.append("date >= ?")
        params.append(start.isoformat())
    if end is not None:
        clauses.append("date <= ?")
        params.append(end.isoformat())
    where = " WHERE " + " AND ".join(clauses) if clauses else ""
    return where, tuple(params)


def _fetch_health_rows(db: Any, *, start: date | None = None, end: date | None = None) -> list[HealthRow]:
    where, params = _date_range_clause(start, end)
    rows = db.query(f"SELECT * FROM daily_health{where} ORDER BY date", params)
    out: list[HealthRow] = []
    for row in rows:
        d = _parse_date(row["date"])
        if d is None:
            continue
        out.append(HealthRow(
            date=d,
            rhr=float(row["rhr"]) if row["rhr"] is not None else None,
            sleep_total_s=float(row["sleep_total_s"]) if "sleep_total_s" in row.keys() and row["sleep_total_s"] is not None else None,
            sleep_score=float(row["sleep_score"]) if "sleep_score" in row.keys() and row["sleep_score"] is not None else None,
        ))
    return out


def _fetch_calibration_health_rows(db: Any) -> list[CalibrationHealthRow]:
    rows = db.query("SELECT date, rhr FROM daily_health ORDER BY date")
    out: list[CalibrationHealthRow] = []
    for row in rows:
        d = _parse_date(row["date"])
        if d is not None:
            out.append(CalibrationHealthRow(date=d, rhr=float(row["rhr"]) if row["rhr"] is not None else None))
    return out


def _fetch_hrv_rows(db: Any, *, start: date | None = None, end: date | None = None) -> list[HrvRow]:
    where, params = _date_range_clause(start, end)
    rows = db.query(
        f"SELECT date, last_night_avg, status FROM daily_hrv{where} ORDER BY date",
        params,
    )
    out: list[HrvRow] = []
    for row in rows:
        d = _parse_date(row["date"])
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


def _load_prior_state(db: Any, series_start: date) -> PriorLoadState | None:
    """Read the last persisted daily_training_load row before series_start.

    Ensures partial-window recomputes continue EWMA from prior ATL/CTL instead
    of resetting to zero. Returns None when no earlier row exists.
    """
    rows = db.query(
        "SELECT acute_load, chronic_load FROM daily_training_load "
        "WHERE date < ? ORDER BY date DESC LIMIT 1",
        (series_start.isoformat(),),
    )
    if not rows:
        return None
    row = rows[0]
    return PriorLoadState(
        acute_load=float(row["acute_load"]) if row["acute_load"] is not None else 0.0,
        chronic_load=float(row["chronic_load"]) if row["chronic_load"] is not None else 0.0,
    )


def _build_activity_input(db: Any, row: Any) -> ActivityLoadInput | None:
    activity_date = _activity_shanghai_date(row["date"])
    if activity_date is None:
        return None
    sport = _sport_from_row(row)
    feedback = db.get_activity_feedback(row["label_id"])
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


def _build_calibration_history(db: Any) -> list[CalibrationActivity]:
    rows = db.query("SELECT * FROM activities ORDER BY date")
    out: list[CalibrationActivity] = []
    for row in rows:
        activity_date = _activity_shanghai_date(row["date"])
        if activity_date is None:
            continue
        out.append(CalibrationActivity(
            label_id=row["label_id"],
            activity_date=activity_date,
            sport=_sport_from_row(row),
            duration_s=float(row["duration_s"]) if row["duration_s"] is not None else None,
            distance_m=_as_activity_distance_meters(row["distance_m"]),
            avg_hr=float(row["avg_hr"]) if "avg_hr" in row.keys() and row["avg_hr"] is not None else None,
            max_hr=float(row["max_hr"]) if "max_hr" in row.keys() and row["max_hr"] is not None else None,
            avg_power=float(row["avg_power"]) if "avg_power" in row.keys() and row["avg_power"] is not None else None,
            samples=_fetch_calibration_samples(
                db,
                row["label_id"],
                provider=row["provider"] if "provider" in row.keys() else None,
                sport_type=int(row["sport_type"]) if row["sport_type"] is not None else None,
                activity_distance_m=_as_activity_distance_meters(row["distance_m"]),
            ),
        ))
    return out


def _defaulted_calibration(
    calibration: CalibrationSnapshot,
    activity_inputs: Sequence[ActivityLoadInput],
) -> CalibrationSnapshot:
    rhr = calibration.rhr_baseline
    hrmax = calibration.hrmax_estimate
    if hrmax is None:
        max_values = [a.max_hr for a in activity_inputs if a.max_hr is not None]
        hrmax = max(max_values) if max_values else None

    threshold_hr = calibration.threshold_hr
    threshold_speed = calibration.threshold_speed_mps
    source = dict(calibration.source)
    if threshold_speed is None:
        speeds: list[float] = []
        for activity in activity_inputs:
            if activity.duration_s and activity.distance_m and activity.duration_s > 0 and activity.distance_m > 500:
                speeds.append(activity.distance_m / activity.duration_s)
            speeds.extend(s.speed_mps for s in activity.samples if s.speed_mps is not None and s.speed_mps > 0)
        if speeds:
            threshold_speed = max(speeds)
            source.setdefault("adapter_defaults", {"used": True})
    return CalibrationSnapshot(
        as_of_date=calibration.as_of_date,
        rhr_baseline=rhr,
        hrmax_estimate=hrmax,
        threshold_hr=threshold_hr,
        threshold_speed_mps=threshold_speed,
        critical_power_w=calibration.critical_power_w,
        source=source,
        id=calibration.id,
        algorithm_version=calibration.algorithm_version,
    )


def recompute_training_load(
    db: Any,
    *,
    start: str | date | None = None,
    end: str | date | None = None,
    label_ids: Sequence[str] | None = None,
    persist: bool = True,
    prior_state: PriorLoadState | None = None,
) -> TrainingLoadRunSummary:
    """Recompute objective activity and daily training-load rows.

    This is the only DB adapter entry point for v1; it does not hook into sync
    and does not alter vendor-provided training-load fields.

    When ``start`` is provided without an explicit ``prior_state``, the most
    recent persisted ``daily_training_load`` row before the window is loaded
    so the rolling ATL/CTL continues instead of restarting at zero.
    """
    start_date = _parse_date(start)
    end_date = _parse_date(end)
    labels = list(label_ids) if label_ids is not None else None
    activity_rows = _fetch_activity_rows(db, start=start_date, end=end_date, label_ids=labels)
    activity_inputs = [a for row in activity_rows if (a := _build_activity_input(db, row)) is not None]
    if not activity_inputs:
        return TrainingLoadRunSummary(0, 0, 0, None, start_date, end_date, persist)

    series_start = start_date or min(a.activity_date for a in activity_inputs)
    series_end = end_date or max(a.activity_date for a in activity_inputs)
    as_of = series_end
    calibration = estimate_calibration(
        _build_calibration_history(db),
        as_of_date=as_of,
        health_rows=_fetch_calibration_health_rows(db),
    )
    calibration = _defaulted_calibration(calibration, activity_inputs)
    calibration_id = (
        db.upsert_training_load_calibration(calibration, commit=False) if persist else None
    )
    if calibration_id is not None:
        calibration = CalibrationSnapshot(
            as_of_date=calibration.as_of_date,
            rhr_baseline=calibration.rhr_baseline,
            hrmax_estimate=calibration.hrmax_estimate,
            threshold_hr=calibration.threshold_hr,
            threshold_speed_mps=calibration.threshold_speed_mps,
            critical_power_w=calibration.critical_power_w,
            source=calibration.source,
            id=calibration_id,
            algorithm_version=calibration.algorithm_version,
        )
    activity_results = [compute_activity_load(activity, calibration) for activity in activity_inputs]
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
