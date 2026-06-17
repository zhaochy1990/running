"""SQLite adapter for objective training-load recomputation."""

from __future__ import annotations

import json
import math
from datetime import date, timedelta
from typing import Any, Iterable, Sequence

from stride_core.db import HRV_PREFERRED_PER_DATE_SQL
from stride_core.normalize import kind_from_legacy_train_type
from stride_core.timefmt import SHANGHAI_DAY_SQL, today_shanghai, utc_iso_to_shanghai_iso

from .core import compute_activity_load, compute_daily_load_series
from .types import (
    ActivityLoadInput,
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


def _fetch_health_rows(db: Any, *, start: date | None = None, end: date | None = None) -> list[HealthRow]:
    # `daily_health.date` is stored as Shanghai-local YYYYMMDD on COROS-sourced
    # rows but ISO YYYY-MM-DD elsewhere. Lexicographic SQL `BETWEEN` cannot
    # safely compare both formats against an ISO bound, so normalize in Python
    # after a broad SELECT. The table is small (one row per user-day).
    rows = db.query("SELECT * FROM daily_health ORDER BY date")
    out: list[HealthRow] = []
    for row in rows:
        d = _parse_date(row["date"])
        if d is None:
            continue
        if start is not None and d < start:
            continue
        if end is not None and d > end:
            continue
        out.append(HealthRow(
            date=d,
            rhr=float(row["rhr"]) if row["rhr"] is not None else None,
            sleep_total_s=float(row["sleep_total_s"]) if "sleep_total_s" in row.keys() and row["sleep_total_s"] is not None else None,
            sleep_score=float(row["sleep_score"]) if "sleep_score" in row.keys() and row["sleep_score"] is not None else None,
        ))
    return out


def _fetch_hrv_rows(db: Any, *, start: date | None = None, end: date | None = None) -> list[HrvRow]:
    # daily_hrv shares the mixed YYYYMMDD/ISO storage convention; filter in
    # Python after parsing for the same reason as `_fetch_health_rows`.
    # Dedupe multi-provider rows per date (Garmin > COROS) so a dual-watch
    # user doesn't get both providers' values fed into the readiness model.
    rows = db.query(
        "SELECT date, last_night_avg, status "
        f"FROM ({HRV_PREFERRED_PER_DATE_SQL}) ORDER BY date"
    )
    out: list[HrvRow] = []
    for row in rows:
        d = _parse_date(row["date"])
        if d is None:
            continue
        if start is not None and d < start:
            continue
        if end is not None and d > end:
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


_K_ACUTE = 1.0 - math.exp(-1.0 / 7.0)
_K_CHRONIC = 1.0 - math.exp(-1.0 / 42.0)


def _last_persisted_daily_date(db: Any, *, before: date) -> date | None:
    """Date of the most recent persisted daily_training_load row strictly
    before ``before`` (None when none exists)."""
    rows = db.query(
        "SELECT date FROM daily_training_load WHERE date < ? ORDER BY date DESC LIMIT 1",
        (before.isoformat(),),
    )
    if not rows:
        return None
    return _parse_date(rows[0]["date"])


def _load_prior_state(db: Any, series_start: date) -> PriorLoadState | None:
    """Read the last persisted daily_training_load row before series_start
    and decay its ATL/CTL through any rest-day gap.

    Without this, a recompute starting N days after the last persisted row
    would seed the EWMA with values that are "too fresh" — the dose on day N
    would be applied to load state from day 0, skipping N-1 zero-dose decay
    steps. The decay loop here matches the recursion in
    `compute_daily_load_series` for a dose of 0.
    """
    rows = db.query(
        "SELECT date, acute_load, chronic_load FROM daily_training_load "
        "WHERE date < ? ORDER BY date DESC LIMIT 1",
        (series_start.isoformat(),),
    )
    if not rows:
        return None
    row = rows[0]
    acute = float(row["acute_load"]) if row["acute_load"] is not None else 0.0
    chronic = float(row["chronic_load"]) if row["chronic_load"] is not None else 0.0
    prior_date = _parse_date(row["date"])
    if prior_date is not None:
        gap_days = max(0, (series_start - prior_date).days - 1)
        for _ in range(gap_days):
            acute += _K_ACUTE * (0.0 - acute)
            chronic += _K_CHRONIC * (0.0 - chronic)
    return PriorLoadState(acute_load=acute, chronic_load=chronic)


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


def _json_dict(value: Any) -> dict[str, Any]:
    if not value:
        return {}
    try:
        data = json.loads(str(value))
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _calibration_from_running_snapshot_row(row: Any) -> CalibrationSnapshot:
    """Map a running_calibration_snapshot row to the training-load CalibrationSnapshot."""
    def _get(key: str) -> Any:
        try:
            return row[key]
        except (KeyError, IndexError):
            return None

    return CalibrationSnapshot(
        as_of_date=_parse_date(_get("as_of_date")) or today_shanghai(),
        rhr_baseline=float(_get("rhr_baseline")) if _get("rhr_baseline") is not None else None,
        hrmax_estimate=float(_get("hrmax_estimate")) if _get("hrmax_estimate") is not None else None,
        threshold_hr=float(_get("threshold_hr")) if _get("threshold_hr") is not None else None,
        threshold_speed_mps=float(_get("threshold_speed_mps")) if _get("threshold_speed_mps") is not None else None,
        critical_power_w=None,  # not tracked in running_calibration
        source=_json_dict(_get("source_json")),
        id=int(_get("id")) if _get("id") is not None else None,
        algorithm_version=int(_get("algorithm_version")) if _get("algorithm_version") is not None else 1,
    )


def _fetch_latest_calibration(db: Any) -> CalibrationSnapshot | None:
    from stride_core.running_calibration import RUNNING_CALIBRATION_MODEL_VERSION
    from stride_core.running_calibration.sqlite_connector import SQLiteRunningCalibrationRepository
    # Ensure the running_calibration_snapshot table exists (idempotent).
    SQLiteRunningCalibrationRepository(db).ensure_schema()
    rows = db.query(
        "SELECT * FROM running_calibration_snapshot "
        "WHERE algorithm_version = ? "
        "ORDER BY as_of_date DESC, id DESC LIMIT 1",
        (RUNNING_CALIBRATION_MODEL_VERSION,),
    )
    row = rows[0] if rows else None
    return _calibration_from_running_snapshot_row(row) if row is not None else None


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
    from stride_core.running_calibration.sqlite_connector import SQLiteRunningCalibrationRepository

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


def _defaulted_calibration(
    calibration: CalibrationSnapshot,
    activity_inputs: Sequence[ActivityLoadInput],
) -> CalibrationSnapshot:
    rhr = calibration.rhr_baseline
    hrmax = calibration.hrmax_estimate
    used_runtime_defaults = False
    if hrmax is None:
        max_values = [a.max_hr for a in activity_inputs if a.max_hr is not None]
        hrmax = max(max_values) if max_values else None
        used_runtime_defaults = hrmax is not None

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
            used_runtime_defaults = True
    return CalibrationSnapshot(
        as_of_date=calibration.as_of_date,
        rhr_baseline=rhr,
        hrmax_estimate=hrmax,
        threshold_hr=threshold_hr,
        threshold_speed_mps=threshold_speed,
        critical_power_w=calibration.critical_power_w,
        source=source,
        id=None if used_runtime_defaults else calibration.id,
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
    calibration_override: CalibrationSnapshot | None = None,
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
            activity_inputs = [
                a for row in activity_rows if (a := _build_activity_input(db, row)) is not None
            ]

    as_of = series_end
    calibration = calibration_override or _fetch_latest_calibration(db) or CalibrationSnapshot(
        as_of_date=as_of,
    )
    calibration = _defaulted_calibration(calibration, activity_inputs)
    calibration_id = calibration.id
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
    load = recompute_training_load(
        db,
        start=load_start,
        end=as_of,
        persist=persist,
        calibration_override=calibration,
    )
    return TrainingLoadBackfillSummary(
        calibration=calibration,
        load=load,
        calibration_lookback_days=calibration_lookback_days,
        load_lookback_days=load_lookback_days,
    )
