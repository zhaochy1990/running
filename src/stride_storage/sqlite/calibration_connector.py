"""SQLite repository connector for running calibration."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import replace
from datetime import date
from typing import Any, Sequence

from stride_core.timefmt import SHANGHAI_DAY_SQL, utc_iso_to_shanghai_iso

from stride_core.running_calibration.types import (
    CalibrationConfidence,
    CalibrationEvidence,
    HeartRateZone,
    PaceZone,
    RunningActivity,
    RunningCalibrationSnapshot,
    RunningHealthRow,
    RunningLap,
    RunningSample,
)
from stride_core.running_calibration.zones import compute_training_zones

RUNNING_CALIBRATION_SCHEMA = (
    """
    CREATE TABLE IF NOT EXISTS running_calibration_snapshot (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        as_of_date TEXT NOT NULL,
        algorithm_version INTEGER NOT NULL,
        threshold_hr REAL,
        threshold_speed_mps REAL,
        threshold_hr_confidence TEXT NOT NULL,
        threshold_speed_confidence TEXT NOT NULL,
        rhr_baseline REAL,
        observed_max_hr REAL,
        hrmax_estimate REAL,
        hrmax_confidence TEXT NOT NULL DEFAULT 'none',
        high_hr_reference REAL,
        critical_power_w REAL,
        critical_speed_mps REAL,
        d_prime_m REAL,
        riegel_k REAL,
        endurance_index REAL,
        speed_index REAL,
        speed_duration_confidence TEXT NOT NULL DEFAULT 'none',
        source_json TEXT,
        computed_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(as_of_date, algorithm_version)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS running_calibration_zone (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id INTEGER NOT NULL REFERENCES running_calibration_snapshot(id) ON DELETE CASCADE,
        zone_kind TEXT NOT NULL,
        name TEXT NOT NULL,
        min_value REAL,
        max_value REAL,
        min_speed_mps REAL,
        max_speed_mps REAL,
        confidence TEXT NOT NULL,
        UNIQUE(snapshot_id, zone_kind, name)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS running_calibration_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id INTEGER NOT NULL REFERENCES running_calibration_snapshot(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        label_id TEXT NOT NULL,
        activity_date TEXT NOT NULL,
        start_s REAL,
        end_s REAL,
        duration_s REAL,
        avg_speed_mps REAL,
        avg_hr REAL,
        confidence TEXT NOT NULL,
        source_json TEXT,
        UNIQUE(snapshot_id, kind, label_id, start_s, end_s)
    )
    """,
    """
    CREATE UNIQUE INDEX IF NOT EXISTS idx_running_calibration_evidence_unique_bounds
    ON running_calibration_evidence(
        snapshot_id,
        kind,
        label_id,
        coalesce(start_s, -1.0),
        coalesce(end_s, -1.0)
    )
    """,
)


class SQLiteRunningCalibrationRepository:
    def __init__(self, db: Any) -> None:
        self.db = db
        self._conn = _connection(db)
        self.ensure_schema()

    def ensure_schema(self) -> None:
        for stmt in RUNNING_CALIBRATION_SCHEMA:
            self._conn.execute(stmt)
        _ensure_columns(
            self._conn,
            "running_calibration_snapshot",
            {
                "observed_max_hr": "REAL",
                "hrmax_confidence": "TEXT NOT NULL DEFAULT 'none'",
                "high_hr_reference": "REAL",
                "critical_power_w": "REAL",
                "critical_speed_mps": "REAL",
                "d_prime_m": "REAL",
                "riegel_k": "REAL",
                "endurance_index": "REAL",
                "speed_index": "REAL",
                "speed_duration_confidence": "TEXT NOT NULL DEFAULT 'none'",
            },
        )
        self._conn.commit()

    def fetch_history(self, start: date, end: date) -> list[RunningActivity]:
        start_date = _parse_date(start)
        end_date = _parse_date(end)
        if start_date is None or end_date is None:
            raise ValueError("start and end must be ISO dates or date objects")
        rows = self._query(
            f"SELECT * FROM activities WHERE {SHANGHAI_DAY_SQL} >= ? AND {SHANGHAI_DAY_SQL} <= ? ORDER BY date, label_id",
            (start_date.isoformat(), end_date.isoformat()),
        )
        out: list[RunningActivity] = []
        for row in rows:
            activity = self._activity_from_row(row)
            if activity is not None:
                out.append(activity)
        return out

    def fetch_health_rows(self, start: date, end: date) -> list[RunningHealthRow]:
        """Read `daily_health.rhr` between [start, end] inclusive.

        `daily_health.date` is stored in YYYYMMDD (Shanghai-local) — see
        CLAUDE.md Timezone discipline whitelist. We convert each row's date
        to a Python `date` before returning. Rows with NULL `rhr` are skipped.
        """
        start_compact = start.strftime("%Y%m%d")
        end_compact = end.strftime("%Y%m%d")
        rows = self._conn.execute(
            "SELECT date, rhr FROM daily_health "
            "WHERE rhr IS NOT NULL AND date >= ? AND date <= ?",
            (start_compact, end_compact),
        ).fetchall()
        out: list[RunningHealthRow] = []
        for row in rows or []:
            date_str = str(_row_value(row, "date"))
            rhr_val = _row_value(row, "rhr")
            try:
                d = date(int(date_str[:4]), int(date_str[4:6]), int(date_str[6:8]))
            except (ValueError, IndexError):
                continue
            out.append(RunningHealthRow(date=d, rhr=float(rhr_val) if rhr_val is not None else None))
        return out

    def save_snapshot(self, snapshot: RunningCalibrationSnapshot) -> int:
        source_json = json.dumps(snapshot.source or {}, ensure_ascii=False, sort_keys=True)
        self._conn.execute(
            """INSERT INTO running_calibration_snapshot
               (as_of_date, algorithm_version, threshold_hr, threshold_speed_mps,
                threshold_hr_confidence, threshold_speed_confidence,
                rhr_baseline, observed_max_hr, hrmax_estimate, hrmax_confidence,
                high_hr_reference, critical_power_w,
                critical_speed_mps, d_prime_m, riegel_k, endurance_index,
                speed_index, speed_duration_confidence, source_json, computed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
               ON CONFLICT(as_of_date, algorithm_version) DO UPDATE SET
                   threshold_hr = excluded.threshold_hr,
                   threshold_speed_mps = excluded.threshold_speed_mps,
                   threshold_hr_confidence = excluded.threshold_hr_confidence,
                   threshold_speed_confidence = excluded.threshold_speed_confidence,
                   rhr_baseline = excluded.rhr_baseline,
                   observed_max_hr = excluded.observed_max_hr,
                   hrmax_estimate = excluded.hrmax_estimate,
                   hrmax_confidence = excluded.hrmax_confidence,
                   high_hr_reference = excluded.high_hr_reference,
                   critical_power_w = excluded.critical_power_w,
                   critical_speed_mps = excluded.critical_speed_mps,
                   d_prime_m = excluded.d_prime_m,
                   riegel_k = excluded.riegel_k,
                   endurance_index = excluded.endurance_index,
                   speed_index = excluded.speed_index,
                   speed_duration_confidence = excluded.speed_duration_confidence,
                   source_json = excluded.source_json,
                   computed_at = excluded.computed_at""",
            (
                snapshot.as_of_date.isoformat(),
                snapshot.algorithm_version,
                snapshot.threshold_hr,
                snapshot.threshold_speed_mps,
                snapshot.threshold_hr_confidence.value,
                snapshot.threshold_speed_confidence.value,
                snapshot.rhr_baseline,
                snapshot.observed_max_hr,
                snapshot.hrmax_estimate,
                snapshot.hrmax_confidence.value,
                snapshot.high_hr_reference,
                snapshot.critical_power_w,
                snapshot.critical_speed_mps,
                snapshot.d_prime_m,
                snapshot.riegel_k,
                snapshot.endurance_index,
                snapshot.speed_index,
                snapshot.speed_duration_confidence.value,
                source_json,
            ),
        )
        row = self._conn.execute(
            "SELECT id FROM running_calibration_snapshot WHERE as_of_date = ? AND algorithm_version = ?",
            (snapshot.as_of_date.isoformat(), snapshot.algorithm_version),
        ).fetchone()
        snapshot_id = int(row["id"] if _has_key(row, "id") else row[0])
        snapshot_with_id = replace(snapshot, id=snapshot_id)
        self._save_zones(snapshot_with_id)
        self._save_evidence(snapshot_with_id)
        self._conn.commit()
        return snapshot_id

    def fetch_latest(self, as_of_date: date | None = None) -> RunningCalibrationSnapshot | None:
        params: tuple[Any, ...]
        if as_of_date is None:
            sql = "SELECT * FROM running_calibration_snapshot ORDER BY as_of_date DESC, id DESC LIMIT 1"
            params = ()
        else:
            sql = "SELECT * FROM running_calibration_snapshot WHERE as_of_date <= ? ORDER BY as_of_date DESC, id DESC LIMIT 1"
            params = (as_of_date.isoformat(),)
        row = self._conn.execute(sql, params).fetchone()
        if row is None:
            return None
        return self._snapshot_from_row(row)

    def fetch_nearest_hrmax(self, as_of_date: date) -> RunningCalibrationSnapshot | None:
        """Return the nearest snapshot with HRmax for historical ability reads.

        Prefer the latest snapshot on or before ``as_of_date``. If none exists,
        use the earliest later snapshot with ``hrmax_estimate`` so backfills for
        dates before the first calibration run can still score real activities.
        """
        prior = self._fetch_hrmax_snapshot(
            "as_of_date <= ? ORDER BY as_of_date DESC, id DESC LIMIT 1",
            (as_of_date.isoformat(),),
        )
        if prior is not None:
            return prior
        return self._fetch_hrmax_snapshot(
            "as_of_date > ? ORDER BY as_of_date ASC, id ASC LIMIT 1",
            (as_of_date.isoformat(),),
        )

    def _fetch_hrmax_snapshot(
        self,
        where_and_order: str,
        params: tuple[Any, ...],
    ) -> RunningCalibrationSnapshot | None:
        row = self._conn.execute(
            "SELECT * FROM running_calibration_snapshot "
            "WHERE hrmax_estimate IS NOT NULL AND "
            f"{where_and_order}",
            params,
        ).fetchone()
        if row is None:
            return None
        return self._snapshot_from_row(row)

    def _snapshot_from_row(self, row: Any) -> RunningCalibrationSnapshot:
        snapshot_id = int(_row_value(row, "id"))
        evidence = self._fetch_evidence(snapshot_id)
        return RunningCalibrationSnapshot(
            id=snapshot_id,
            as_of_date=date.fromisoformat(str(_row_value(row, "as_of_date"))),
            algorithm_version=int(_row_value(row, "algorithm_version")),
            threshold_hr=_float_or_none(_row_value(row, "threshold_hr")),
            threshold_speed_mps=_float_or_none(_row_value(row, "threshold_speed_mps")),
            threshold_hr_confidence=CalibrationConfidence(str(_row_value(row, "threshold_hr_confidence"))),
            threshold_speed_confidence=CalibrationConfidence(str(_row_value(row, "threshold_speed_confidence"))),
            rhr_baseline=_float_or_none(_row_value(row, "rhr_baseline")),
            observed_max_hr=_float_or_none(_row_value(row, "observed_max_hr")),
            hrmax_estimate=_float_or_none(_row_value(row, "hrmax_estimate")),
            hrmax_confidence=CalibrationConfidence(str(_row_value(row, "hrmax_confidence") or CalibrationConfidence.NONE.value)),
            high_hr_reference=_float_or_none(_row_value(row, "high_hr_reference")),
            critical_power_w=_float_or_none(_row_value(row, "critical_power_w")),
            critical_speed_mps=_float_or_none(_row_value(row, "critical_speed_mps")),
            d_prime_m=_float_or_none(_row_value(row, "d_prime_m")),
            riegel_k=_float_or_none(_row_value(row, "riegel_k")),
            endurance_index=_float_or_none(_row_value(row, "endurance_index")),
            speed_index=_float_or_none(_row_value(row, "speed_index")),
            speed_duration_confidence=CalibrationConfidence(
                str(_row_value(row, "speed_duration_confidence") or CalibrationConfidence.NONE.value)
            ),
            source=_json_dict(_row_value(row, "source_json")),
            evidence=evidence,
        )

    def _activity_from_row(self, row: Any) -> RunningActivity | None:
        activity_date = _activity_shanghai_date(_row_value(row, "date"))
        if activity_date is None:
            return None
        sport = _sport_from_row(row)
        if not _is_running_sport(sport):
            return None
        label_id = str(_row_value(row, "label_id"))
        distance_m = _as_activity_distance_meters(_row_value(row, "distance_m"))
        provider = _row_value(row, "provider")
        sport_type = _int_or_none(_row_value(row, "sport_type"))
        return RunningActivity(
            label_id=label_id,
            activity_date=activity_date,
            sport=sport,
            duration_s=_float_or_none(_row_value(row, "duration_s")),
            distance_m=distance_m,
            avg_hr=_float_or_none(_row_value(row, "avg_hr")),
            max_hr=_float_or_none(_row_value(row, "max_hr")),
            avg_power_w=_float_or_none(_row_value(row, "avg_power")),
            samples=self._fetch_samples(label_id, provider=provider, activity_distance_m=distance_m),
            laps=self._fetch_laps(label_id),
            source=str(provider) if provider is not None else None,
        )

    def fetch_activity_samples(
        self,
        label_id: str,
        *,
        provider: Any = None,
        activity_distance_m: float | None = None,
    ) -> tuple[RunningSample, ...]:
        """Public: an activity's timeseries as unit-normalized RunningSample rows.

        Stable surface for callers outside calibration (e.g. the post-sync
        activity-zones handler) that need per-sample speed_mps / heart_rate_bpm /
        elapsed_s without re-implementing the unit conversions.
        """
        return self._fetch_samples(
            label_id, provider=provider, activity_distance_m=activity_distance_m
        )

    def _fetch_samples(
        self,
        label_id: str,
        *,
        provider: Any = None,
        activity_distance_m: float | None = None,
    ) -> tuple[RunningSample, ...]:
        rows = self._query(
            """SELECT timestamp, distance, heart_rate, speed, altitude, power
               FROM timeseries WHERE label_id = ? ORDER BY id""",
            (label_id,),
        )
        elapsed = _normalize_elapsed_seconds(rows)
        distance_scale = _distance_scale_for_timeseries(rows, activity_distance_m=activity_distance_m, provider=provider)
        samples: list[RunningSample] = []
        for row, seconds in zip(rows, elapsed):
            distance = _row_value(row, "distance")
            samples.append(
                RunningSample(
                    timestamp_s=seconds,
                    elapsed_s=seconds,
                    distance_m=float(distance) * distance_scale if distance is not None else None,
                    heart_rate_bpm=_float_or_none(_row_value(row, "heart_rate")),
                    speed_mps=_as_speed_mps(_row_value(row, "speed")),
                    altitude_m=_float_or_none(_row_value(row, "altitude")),
                    power_w=_float_or_none(_row_value(row, "power")),
                )
            )
        return tuple(samples)

    def _fetch_laps(self, label_id: str) -> tuple[RunningLap, ...]:
        rows = self._query(
            """SELECT lap_index, lap_type, distance_m, duration_s, avg_pace, avg_hr, max_hr, avg_power
               FROM laps WHERE label_id = ? ORDER BY lap_index""",
            (label_id,),
        )
        laps: list[RunningLap] = []
        for row in rows:
            avg_pace = _float_or_none(_row_value(row, "avg_pace"))
            laps.append(
                RunningLap(
                    lap_index=int(_row_value(row, "lap_index")),
                    lap_type=_row_value(row, "lap_type"),
                    distance_m=_as_activity_distance_meters(_row_value(row, "distance_m")),
                    duration_s=_float_or_none(_row_value(row, "duration_s")),
                    avg_speed_mps=_as_speed_mps(avg_pace),
                    avg_hr=_float_or_none(_row_value(row, "avg_hr")),
                    max_hr=_float_or_none(_row_value(row, "max_hr")),
                    avg_power_w=_float_or_none(_row_value(row, "avg_power")),
                )
            )
        return tuple(laps)

    def _save_zones(self, snapshot: RunningCalibrationSnapshot) -> None:
        self._conn.execute("DELETE FROM running_calibration_zone WHERE snapshot_id = ?", (snapshot.id,))
        zones = compute_training_zones(snapshot)
        for zone in zones.pace_zones:
            self._insert_pace_zone(snapshot.id, zone)
        for zone in zones.heart_rate_zones:
            self._insert_hr_zone(snapshot.id, zone)

    def _insert_pace_zone(self, snapshot_id: int | str | None, zone: PaceZone) -> None:
        self._conn.execute(
            """INSERT OR REPLACE INTO running_calibration_zone
               (snapshot_id, zone_kind, name, min_value, max_value, min_speed_mps, max_speed_mps, confidence)
               VALUES (?, 'pace', ?, ?, ?, ?, ?, ?)""",
            (
                snapshot_id,
                zone.name,
                zone.min_pace_s_per_km,
                zone.max_pace_s_per_km,
                zone.min_speed_mps,
                zone.max_speed_mps,
                zone.confidence.value,
            ),
        )

    def _insert_hr_zone(self, snapshot_id: int | str | None, zone: HeartRateZone) -> None:
        self._conn.execute(
            """INSERT OR REPLACE INTO running_calibration_zone
               (snapshot_id, zone_kind, name, min_value, max_value, min_speed_mps, max_speed_mps, confidence)
               VALUES (?, 'heart_rate', ?, ?, ?, NULL, NULL, ?)""",
            (snapshot_id, zone.name, zone.min_bpm, zone.max_bpm, zone.confidence.value),
        )

    def _save_evidence(self, snapshot: RunningCalibrationSnapshot) -> None:
        self._conn.execute("DELETE FROM running_calibration_evidence WHERE snapshot_id = ?", (snapshot.id,))
        for item in snapshot.evidence:
            self._conn.execute(
                """INSERT OR REPLACE INTO running_calibration_evidence
                   (snapshot_id, kind, label_id, activity_date, start_s, end_s, duration_s,
                    avg_speed_mps, avg_hr, confidence, source_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    snapshot.id,
                    item.kind,
                    item.label_id,
                    item.activity_date.isoformat(),
                    item.start_s,
                    item.end_s,
                    item.duration_s,
                    item.avg_speed_mps,
                    item.avg_hr,
                    item.confidence.value,
                    json.dumps(item.source or {}, ensure_ascii=False, sort_keys=True),
                ),
            )

    def _fetch_evidence(self, snapshot_id: int) -> tuple[CalibrationEvidence, ...]:
        rows = self._conn.execute(
            "SELECT * FROM running_calibration_evidence WHERE snapshot_id = ? ORDER BY id",
            (snapshot_id,),
        ).fetchall()
        return tuple(
            CalibrationEvidence(
                kind=str(_row_value(row, "kind")),
                label_id=str(_row_value(row, "label_id")),
                activity_date=date.fromisoformat(str(_row_value(row, "activity_date"))),
                start_s=_float_or_none(_row_value(row, "start_s")),
                end_s=_float_or_none(_row_value(row, "end_s")),
                duration_s=_float_or_none(_row_value(row, "duration_s")),
                avg_speed_mps=_float_or_none(_row_value(row, "avg_speed_mps")),
                avg_hr=_float_or_none(_row_value(row, "avg_hr")),
                confidence=CalibrationConfidence(str(_row_value(row, "confidence"))),
                source=_json_dict(_row_value(row, "source_json")),
            )
            for row in rows
        )

    def _query(self, sql: str, params: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
        query = getattr(self.db, "query", None)
        if callable(query):
            return list(query(sql, params))
        return list(self._conn.execute(sql, params).fetchall())


def _connection(db: Any) -> sqlite3.Connection:
    conn = getattr(db, "_conn", None)
    if conn is None:
        if isinstance(db, sqlite3.Connection):
            conn = db
        else:
            raise TypeError("SQLiteRunningCalibrationRepository requires Database or sqlite3.Connection")
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_columns(conn: sqlite3.Connection, table: str, columns: dict[str, str]) -> None:
    existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
    for name, definition in columns.items():
        if name not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")


def _parse_date(value: str | date | None) -> date | None:
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
    sport = _row_value(row, "sport")
    if isinstance(sport, str) and sport.strip():
        return sport.strip()
    sport_type = _int_or_none(_row_value(row, "sport_type"))
    if sport_type in {100, 8001}:
        return "run_outdoor"
    if sport_type in {101, 104, 8002, 8003}:
        return "run_indoor"
    if sport_type in {102, 8005}:
        return "run_trail"
    if sport_type in {103, 8004}:
        return "run_track"
    return "unknown"


def _is_running_sport(sport: str) -> bool:
    sport = (sport or "").lower()
    return sport == "run" or sport.startswith("run_") or sport.startswith("running")


def _row_value(row: Any, key: str) -> Any:
    if isinstance(row, sqlite3.Row):
        return row[key] if key in row.keys() else None
    try:
        return row[key] if key in row.keys() else None
    except AttributeError:
        return row.get(key) if isinstance(row, dict) else None


def _has_key(row: Any, key: str) -> bool:
    try:
        return key in row.keys()
    except AttributeError:
        return False


def _float_or_none(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _int_or_none(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _json_dict(value: Any) -> dict[str, Any]:
    if not value:
        return {}
    try:
        parsed = json.loads(str(value))
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _as_speed_mps(value: Any) -> float | None:
    speed = _float_or_none(value)
    if speed is None or speed <= 0:
        return None
    return 1000.0 / speed if speed > 20 else speed


def _as_activity_distance_meters(value: Any) -> float | None:
    distance = _float_or_none(value)
    if distance is None or distance <= 0:
        return None
    return distance * 1000.0 if distance < 500 else distance


def _normalize_elapsed_seconds(rows: Sequence[Any]) -> tuple[float | None, ...]:
    raw: list[float | None] = []
    for row in rows:
        raw.append(_float_or_none(_row_value(row, "timestamp")))
    present = [(i, value) for i, value in enumerate(raw) if value is not None]
    if not present:
        return tuple(raw)
    first = present[0][1]
    is_epoch_centiseconds = first > 1_000_000
    out: list[float | None] = []
    for value in raw:
        if value is None:
            out.append(None)
            continue
        elapsed = (value - first) / 100.0 if is_epoch_centiseconds else value / 100.0
        out.append(round(elapsed, 4))
    return tuple(out)


def _distance_scale_for_timeseries(
    rows: Sequence[Any], *, activity_distance_m: float | None, provider: Any,
) -> float:
    distances: list[float] = []
    for row in rows:
        value = _float_or_none(_row_value(row, "distance"))
        if value is not None and value > 0:
            distances.append(value)
    if not distances:
        return 1.0
    max_distance = max(distances)
    if activity_distance_m and activity_distance_m > 0:
        if max_distance / activity_distance_m > 20.0:
            return 0.01
        return 1.0
    # TODO: extend this fallback as provider-specific distance units are added.
    if str(provider or "").lower() == "coros" and max_distance > 10_000:
        return 0.01
    return 1.0
