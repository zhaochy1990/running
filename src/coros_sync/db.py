"""SQLite database layer — schema creation, upserts, and queries."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from platformdirs import user_data_dir

from .models import ActivityDetail, DailyHealth, Dashboard, Lap, RacePrediction, TimeseriesPoint, Zone

DATA_DIR = Path(user_data_dir("coros-sync"))
DB_PATH = DATA_DIR / "coros.db"

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
USER_DATA_DIR = PROJECT_ROOT / "data"

SCHEMA = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS activities (
    label_id        TEXT PRIMARY KEY,
    name            TEXT,
    sport_type      INTEGER NOT NULL,
    sport_name      TEXT,
    date            TEXT NOT NULL,
    distance_m      REAL,
    duration_s      REAL,
    avg_pace_s_km   REAL,
    adjusted_pace   REAL,
    best_km_pace    REAL,
    max_pace        REAL,
    avg_hr          INTEGER,
    max_hr          INTEGER,
    avg_cadence     INTEGER,
    max_cadence     INTEGER,
    avg_power       INTEGER,
    max_power       INTEGER,
    avg_step_len_cm REAL,
    ascent_m        REAL,
    descent_m       REAL,
    calories_kcal   INTEGER,
    aerobic_effect  REAL,
    anaerobic_effect REAL,
    training_load   REAL,
    vo2max          REAL,
    performance     REAL,
    train_type      TEXT,
    temperature     REAL,
    humidity        REAL,
    feels_like      REAL,
    wind_speed      REAL,
    device          TEXT,
    synced_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS laps (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    label_id    TEXT NOT NULL REFERENCES activities(label_id),
    lap_index   INTEGER NOT NULL,
    lap_type    TEXT,
    distance_m  REAL,
    duration_s  REAL,
    avg_pace    REAL,
    adjusted_pace REAL,
    avg_hr      INTEGER,
    max_hr      INTEGER,
    avg_cadence INTEGER,
    avg_power   INTEGER,
    ascent_m    REAL,
    descent_m   REAL,
    exercise_type INTEGER,
    UNIQUE(label_id, lap_index, lap_type)
);

CREATE TABLE IF NOT EXISTS zones (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    label_id    TEXT NOT NULL REFERENCES activities(label_id),
    zone_type   TEXT NOT NULL,
    zone_index  INTEGER NOT NULL,
    range_min   REAL,
    range_max   REAL,
    range_unit  TEXT,
    duration_s  INTEGER,
    percent     REAL,
    UNIQUE(label_id, zone_type, zone_index)
);

CREATE TABLE IF NOT EXISTS timeseries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    label_id    TEXT NOT NULL REFERENCES activities(label_id),
    timestamp   INTEGER,
    distance    REAL,
    heart_rate  INTEGER,
    speed       REAL,
    adjusted_pace REAL,
    cadence     INTEGER,
    altitude    REAL,
    power       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_timeseries_label ON timeseries(label_id);

CREATE TABLE IF NOT EXISTS daily_health (
    date            TEXT PRIMARY KEY,
    ati             REAL,
    cti             REAL,
    rhr             INTEGER,
    distance_m      REAL,
    duration_s      REAL,
    training_load_ratio REAL,
    training_load_state TEXT,
    fatigue         REAL
);

CREATE TABLE IF NOT EXISTS dashboard (
    id                  INTEGER PRIMARY KEY CHECK(id = 1),
    running_level       REAL,
    aerobic_score       REAL,
    lactate_threshold_score REAL,
    anaerobic_endurance_score REAL,
    anaerobic_capacity_score REAL,
    rhr                 INTEGER,
    threshold_hr        INTEGER,
    threshold_pace_s_km REAL,
    recovery_pct        REAL,
    avg_sleep_hrv       REAL,
    hrv_normal_low      REAL,
    hrv_normal_high     REAL,
    weekly_distance_m   REAL,
    weekly_duration_s   REAL,
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS race_predictions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    race_type   TEXT NOT NULL UNIQUE,
    duration_s  REAL,
    avg_pace    REAL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_meta (
    key     TEXT PRIMARY KEY,
    value   TEXT
);
"""


class Database:
    def __init__(self, db_path: Path | str | None = None, user: str | None = None):
        if db_path:
            self._path = Path(db_path)
        elif user:
            self._path = USER_DATA_DIR / user / "coros.db"
        else:
            self._path = DB_PATH
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self._path))
        self._conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self) -> None:
        self._conn.executescript(SCHEMA)
        self._migrate()

    def _migrate(self) -> None:
        """Add columns that may be missing from older databases."""
        cols = {r[1] for r in self._conn.execute("PRAGMA table_info(laps)").fetchall()}
        if "exercise_type" not in cols:
            self._conn.execute("ALTER TABLE laps ADD COLUMN exercise_type INTEGER")
        act_cols = {r[1] for r in self._conn.execute("PRAGMA table_info(activities)").fetchall()}
        if "temperature" not in act_cols:
            self._conn.execute("ALTER TABLE activities ADD COLUMN temperature REAL")
        if "humidity" not in act_cols:
            self._conn.execute("ALTER TABLE activities ADD COLUMN humidity REAL")
        if "feels_like" not in act_cols:
            self._conn.execute("ALTER TABLE activities ADD COLUMN feels_like REAL")
        if "wind_speed" not in act_cols:
            self._conn.execute("ALTER TABLE activities ADD COLUMN wind_speed REAL")

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> Database:
        return self

    def __exit__(self, *args) -> None:
        self.close()

    # --- Activities ---

    def upsert_activity(self, a: ActivityDetail) -> None:
        self._conn.execute(
            """INSERT OR REPLACE INTO activities
            (label_id, name, sport_type, sport_name, date, distance_m, duration_s,
             avg_pace_s_km, adjusted_pace, best_km_pace, max_pace,
             avg_hr, max_hr, avg_cadence, max_cadence, avg_power, max_power,
             avg_step_len_cm, ascent_m, descent_m, calories_kcal,
             aerobic_effect, anaerobic_effect, training_load, vo2max, performance, train_type,
             temperature, humidity, feels_like, wind_speed)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (a.label_id, a.name, a.sport_type, a.sport_name, a.date,
             a.distance_m, a.duration_s, a.avg_pace_s_km, a.adjusted_pace,
             a.best_km_pace, a.max_pace, a.avg_hr, a.max_hr,
             a.avg_cadence, a.max_cadence, a.avg_power, a.max_power,
             a.avg_step_len_cm, a.ascent_m, a.descent_m, a.calories_kcal,
             a.aerobic_effect, a.anaerobic_effect, a.training_load,
             a.vo2max, a.performance, a.train_type,
             a.temperature, a.humidity, a.feels_like, a.wind_speed),
        )
        # Upsert child records
        for lap in a.laps:
            self._upsert_lap(a.label_id, lap)
        for zone in a.zones:
            self._upsert_zone(a.label_id, zone)
        self._insert_timeseries(a.label_id, a.timeseries)
        self._conn.commit()

    def _upsert_lap(self, label_id: str, lap: Lap) -> None:
        self._conn.execute(
            """INSERT OR REPLACE INTO laps
            (label_id, lap_index, lap_type, distance_m, duration_s, avg_pace, adjusted_pace,
             avg_hr, max_hr, avg_cadence, avg_power, ascent_m, descent_m, exercise_type)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (label_id, lap.lap_index, lap.lap_type, lap.distance_m, lap.duration_s,
             lap.avg_pace, lap.adjusted_pace, lap.avg_hr, lap.max_hr,
             lap.avg_cadence, lap.avg_power, lap.ascent_m, lap.descent_m, lap.exercise_type),
        )

    def _upsert_zone(self, label_id: str, zone: Zone) -> None:
        self._conn.execute(
            """INSERT OR REPLACE INTO zones
            (label_id, zone_type, zone_index, range_min, range_max, range_unit, duration_s, percent)
            VALUES (?,?,?,?,?,?,?,?)""",
            (label_id, zone.zone_type, zone.zone_index, zone.range_min, zone.range_max,
             zone.range_unit, zone.duration_s, zone.percent),
        )

    def _insert_timeseries(self, label_id: str, points: list[TimeseriesPoint]) -> None:
        # Delete existing timeseries for this activity before reinserting
        self._conn.execute("DELETE FROM timeseries WHERE label_id = ?", (label_id,))
        self._conn.executemany(
            """INSERT INTO timeseries
            (label_id, timestamp, distance, heart_rate, speed, adjusted_pace, cadence, altitude, power)
            VALUES (?,?,?,?,?,?,?,?,?)""",
            [(label_id, p.timestamp, p.distance, p.heart_rate, p.speed,
              p.adjusted_pace, p.cadence, p.altitude, p.power) for p in points],
        )

    def activity_exists(self, label_id: str) -> bool:
        row = self._conn.execute(
            "SELECT 1 FROM activities WHERE label_id = ?", (label_id,)
        ).fetchone()
        return row is not None

    def get_activity_count(self) -> int:
        row = self._conn.execute("SELECT count(*) FROM activities").fetchone()
        return row[0]

    def get_total_distance_km(self) -> float:
        row = self._conn.execute("SELECT coalesce(sum(distance_m), 0) FROM activities").fetchone()
        return round(row[0] / 1000, 1)

    def get_latest_activity_date(self) -> str | None:
        row = self._conn.execute("SELECT max(date) FROM activities").fetchone()
        return row[0] if row else None

    # --- Health ---

    def upsert_daily_health(self, h: DailyHealth) -> None:
        self._conn.execute(
            """INSERT OR REPLACE INTO daily_health
            (date, ati, cti, rhr, distance_m, duration_s, training_load_ratio, training_load_state, fatigue)
            VALUES (?,?,?,?,?,?,?,?,?)""",
            (h.date, h.ati, h.cti, h.rhr, h.distance_m, h.duration_s,
             h.training_load_ratio, h.training_load_state, h.fatigue),
        )
        self._conn.commit()

    def upsert_dashboard(self, d: Dashboard) -> None:
        self._conn.execute(
            """INSERT OR REPLACE INTO dashboard
            (id, running_level, aerobic_score, lactate_threshold_score,
             anaerobic_endurance_score, anaerobic_capacity_score,
             rhr, threshold_hr, threshold_pace_s_km, recovery_pct,
             avg_sleep_hrv, hrv_normal_low, hrv_normal_high,
             weekly_distance_m, weekly_duration_s)
            VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (d.running_level, d.aerobic_score, d.lactate_threshold_score,
             d.anaerobic_endurance_score, d.anaerobic_capacity_score,
             d.rhr, d.threshold_hr, d.threshold_pace_s_km, d.recovery_pct,
             d.avg_sleep_hrv, d.hrv_normal_low, d.hrv_normal_high,
             d.weekly_distance_m, d.weekly_duration_s),
        )
        for pred in d.race_predictions:
            self._conn.execute(
                """INSERT OR REPLACE INTO race_predictions
                (race_type, duration_s, avg_pace) VALUES (?,?,?)""",
                (pred.race_type, pred.duration_s, pred.avg_pace),
            )
        self._conn.commit()

    # --- Sync metadata ---

    def get_meta(self, key: str) -> str | None:
        row = self._conn.execute("SELECT value FROM sync_meta WHERE key = ?", (key,)).fetchone()
        return row[0] if row else None

    def set_meta(self, key: str, value: str) -> None:
        self._conn.execute(
            "INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)", (key, value)
        )
        self._conn.commit()

    # --- Query helpers for analysis ---

    def query(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        return self._conn.execute(sql, params).fetchall()
