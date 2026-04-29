"""SQLite database layer — schema creation, upserts, and queries."""

from __future__ import annotations

import json
import shutil
import sqlite3
import tempfile
from pathlib import Path

from platformdirs import user_data_dir

from .models import (
    ActivityDetail, BodyCompositionScan, BodySegment, DailyHealth, Dashboard,
    Lap, RacePrediction, TimeseriesPoint, Zone,
)

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
    feel_type       INTEGER,
    sport_note      TEXT,
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
    exercise_name_key TEXT,
    mode            INTEGER,
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

CREATE TABLE IF NOT EXISTS activity_commentary (
    label_id        TEXT PRIMARY KEY REFERENCES activities(label_id),
    commentary      TEXT NOT NULL,
    generated_by    TEXT,
    generated_at    TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS weekly_feedback (
    week            TEXT PRIMARY KEY,
    content_md      TEXT NOT NULL,
    generated_by    TEXT,
    generated_at    TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS weekly_plan (
    week            TEXT PRIMARY KEY,
    content_md      TEXT NOT NULL,
    generated_by    TEXT,
    generated_at    TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inbody_scan (
    scan_date           TEXT PRIMARY KEY,
    jpg_path            TEXT,
    weight_kg           REAL NOT NULL,
    body_fat_pct        REAL NOT NULL,
    smm_kg              REAL NOT NULL,
    fat_mass_kg         REAL NOT NULL,
    visceral_fat_level  INTEGER NOT NULL,
    bmr_kcal            INTEGER,
    protein_kg          REAL,
    water_l             REAL,
    smi                 REAL,
    inbody_score        INTEGER,
    ingested_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inbody_segment (
    scan_date               TEXT NOT NULL REFERENCES inbody_scan(scan_date) ON DELETE CASCADE,
    segment                 TEXT NOT NULL,
    lean_mass_kg            REAL NOT NULL,
    fat_mass_kg             REAL NOT NULL,
    lean_pct_of_standard    REAL,
    fat_pct_of_standard     REAL,
    PRIMARY KEY (scan_date, segment)
);

CREATE TABLE IF NOT EXISTS ability_snapshot (
    date                    TEXT NOT NULL,
    level                   TEXT NOT NULL,
    dimension               TEXT NOT NULL,
    value                   REAL,
    evidence_activity_ids   TEXT,
    computed_at             TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (date, level, dimension)
);
CREATE INDEX IF NOT EXISTS idx_ability_snapshot_date ON ability_snapshot(date);

CREATE TABLE IF NOT EXISTS activity_ability (
    label_id        TEXT PRIMARY KEY REFERENCES activities(label_id),
    l1_quality      REAL,
    l1_breakdown    TEXT,
    contribution    TEXT,
    computed_at     TEXT NOT NULL DEFAULT (datetime('now'))
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

        # Workaround for Azure Files SMB: the SCHEMA's `PRAGMA
        # journal_mode=WAL` transition deadlocks on first init when the
        # DB lives on an SMB-mounted share, leaving a 0-byte file and
        # subsequent retries failing with "database is locked".
        # For brand-new DBs, build the schema + WAL state in a local
        # tmp directory (regular FS), then move the fully-formed file
        # into place. After that, all writes are row-level INSERT/UPDATE
        # which work fine over SMB. Existing DBs are opened directly.
        seeded = self._seed_if_needed()

        self._conn = sqlite3.connect(str(self._path))
        self._conn.row_factory = sqlite3.Row
        if seeded:
            # SCHEMA was already applied during the seed; just run the
            # idempotent column-add migrations on the live connection.
            self._migrate()
        else:
            self._init_schema()

    def _seed_if_needed(self) -> bool:
        """Create a fresh schema-applied SQLite file in a local tmp dir
        and move it into place if no usable DB exists at ``self._path``.

        Returns ``True`` if a seed happened (caller skips re-running
        SCHEMA on the moved file), ``False`` if an existing DB was
        already present.
        """
        if self._path.exists() and self._path.stat().st_size > 0:
            return False

        with tempfile.TemporaryDirectory() as tmp:
            seed = Path(tmp) / "coros.db"
            conn = sqlite3.connect(str(seed))
            try:
                conn.executescript(SCHEMA)
                conn.commit()
                # Checkpoint so the moved file is self-contained — no
                # leftover -wal / -shm sidecars to chase.
                conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            finally:
                conn.close()
            if self._path.exists():
                # Replace any 0-byte placeholder left over from a prior
                # failed in-place open.
                self._path.unlink()
            # shutil.move handles cross-device (tmp on local FS, target
            # on SMB share) by falling back to copy + delete.
            shutil.move(str(seed), str(self._path))
        return True

    def _init_schema(self) -> None:
        self._conn.executescript(SCHEMA)
        self._migrate()

    def _migrate(self) -> None:
        """Add columns that may be missing from older databases.

        Each ALTER is wrapped to swallow "duplicate column" errors — this makes
        the migration idempotent under concurrent connections (two requests
        racing to add the same column would otherwise 500 one of them).
        """
        def _add(table: str, column: str, coltype: str) -> None:
            try:
                cols = {r[1] for r in self._conn.execute(f"PRAGMA table_info({table})").fetchall()}
                if not cols:
                    return  # table doesn't exist yet; SCHEMA script will have the column
                if column in cols:
                    return
                self._conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {coltype}")
            except sqlite3.OperationalError as e:
                # Race condition: another connection added it between PRAGMA and ALTER.
                if "duplicate column" not in str(e).lower():
                    raise

        _add("laps", "exercise_type", "INTEGER")
        _add("laps", "exercise_name_key", "TEXT")
        _add("laps", "mode", "INTEGER")
        _add("activities", "temperature", "REAL")
        _add("activities", "humidity", "REAL")
        _add("activities", "feels_like", "REAL")
        _add("activities", "wind_speed", "REAL")
        _add("activities", "feel_type", "INTEGER")
        _add("activities", "sport_note", "TEXT")
        _add("inbody_segment", "fat_pct_of_standard", "REAL")
        _add("activity_commentary", "generated_by", "TEXT")
        _add("activity_commentary", "generated_at", "TEXT")
        _add("weekly_feedback", "generated_by", "TEXT")
        _add("weekly_feedback", "generated_at", "TEXT")
        _add("weekly_plan", "generated_by", "TEXT")
        _add("weekly_plan", "generated_at", "TEXT")

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
             temperature, humidity, feels_like, wind_speed, feel_type, sport_note)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (a.label_id, a.name, a.sport_type, a.sport_name, a.date,
             a.distance_m, a.duration_s, a.avg_pace_s_km, a.adjusted_pace,
             a.best_km_pace, a.max_pace, a.avg_hr, a.max_hr,
             a.avg_cadence, a.max_cadence, a.avg_power, a.max_power,
             a.avg_step_len_cm, a.ascent_m, a.descent_m, a.calories_kcal,
             a.aerobic_effect, a.anaerobic_effect, a.training_load,
             a.vo2max, a.performance, a.train_type,
             a.temperature, a.humidity, a.feels_like, a.wind_speed,
             a.feel_type, a.sport_note),
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
             avg_hr, max_hr, avg_cadence, avg_power, ascent_m, descent_m, exercise_type, exercise_name_key, mode)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (label_id, lap.lap_index, lap.lap_type, lap.distance_m, lap.duration_s,
             lap.avg_pace, lap.adjusted_pace, lap.avg_hr, lap.max_hr,
             lap.avg_cadence, lap.avg_power, lap.ascent_m, lap.descent_m, lap.exercise_type,
             lap.exercise_name_key, lap.mode),
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

    # --- Activity commentary (AI coach notes) ---

    def get_activity_commentary(self, label_id: str) -> str | None:
        row = self._conn.execute(
            "SELECT commentary FROM activity_commentary WHERE label_id = ?",
            (label_id,),
        ).fetchone()
        return row["commentary"] if row else None

    def get_activity_commentary_row(self, label_id: str) -> sqlite3.Row | None:
        """Full row including generated_by / generated_at."""
        return self._conn.execute(
            "SELECT label_id, commentary, generated_by, generated_at, created_at, updated_at "
            "FROM activity_commentary WHERE label_id = ?",
            (label_id,),
        ).fetchone()

    def activity_commentary_exists(self, label_id: str) -> bool:
        return self._conn.execute(
            "SELECT 1 FROM activity_commentary WHERE label_id = ?", (label_id,)
        ).fetchone() is not None

    def upsert_activity_commentary(
        self, label_id: str, commentary: str, *, generated_by: str | None = None,
    ) -> None:
        self._conn.execute(
            """INSERT INTO activity_commentary
               (label_id, commentary, generated_by, generated_at, updated_at)
               VALUES (?, ?, ?, datetime('now'), datetime('now'))
               ON CONFLICT(label_id) DO UPDATE SET
                   commentary   = excluded.commentary,
                   generated_by = excluded.generated_by,
                   generated_at = excluded.generated_at,
                   updated_at   = excluded.updated_at""",
            (label_id, commentary, generated_by),
        )
        self._conn.commit()

    # --- Weekly feedback (rich-text, edited via UI) ---

    def get_weekly_feedback_row(self, week: str) -> sqlite3.Row | None:
        return self._conn.execute(
            "SELECT week, content_md, generated_by, generated_at, created_at, updated_at "
            "FROM weekly_feedback WHERE week = ?",
            (week,),
        ).fetchone()

    def upsert_weekly_feedback(
        self, week: str, content_md: str, *, generated_by: str | None = None,
    ) -> None:
        self._conn.execute(
            """INSERT INTO weekly_feedback
               (week, content_md, generated_by, generated_at, updated_at)
               VALUES (?, ?, ?, datetime('now'), datetime('now'))
               ON CONFLICT(week) DO UPDATE SET
                   content_md   = excluded.content_md,
                   generated_by = excluded.generated_by,
                   generated_at = excluded.generated_at,
                   updated_at   = excluded.updated_at""",
            (week, content_md, generated_by),
        )
        self._conn.commit()

    # --- Weekly plan overrides (rich-text, generated/edited via API) ---

    def get_weekly_plan_row(self, week: str) -> sqlite3.Row | None:
        return self._conn.execute(
            "SELECT week, content_md, generated_by, generated_at, created_at, updated_at "
            "FROM weekly_plan WHERE week = ?",
            (week,),
        ).fetchone()

    def upsert_weekly_plan(
        self, week: str, content_md: str, *, generated_by: str | None = None,
    ) -> None:
        self._conn.execute(
            """INSERT INTO weekly_plan
               (week, content_md, generated_by, generated_at, updated_at)
               VALUES (?, ?, ?, datetime('now'), datetime('now'))
               ON CONFLICT(week) DO UPDATE SET
                   content_md   = excluded.content_md,
                   generated_by = excluded.generated_by,
                   generated_at = excluded.generated_at,
                   updated_at   = excluded.updated_at""",
            (week, content_md, generated_by),
        )
        self._conn.commit()

    # --- InBody body-composition scans ---

    def upsert_inbody_scan(self, scan: BodyCompositionScan) -> None:
        self._conn.execute(
            """INSERT OR REPLACE INTO inbody_scan
            (scan_date, jpg_path, weight_kg, body_fat_pct, smm_kg, fat_mass_kg,
             visceral_fat_level, bmr_kcal, protein_kg, water_l, smi, inbody_score,
             ingested_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))""",
            (scan.scan_date, scan.jpg_path, scan.weight_kg, scan.body_fat_pct,
             scan.smm_kg, scan.fat_mass_kg, scan.visceral_fat_level,
             scan.bmr_kcal, scan.protein_kg, scan.water_l, scan.smi, scan.inbody_score),
        )
        # Replace all segments for this scan
        self._conn.execute("DELETE FROM inbody_segment WHERE scan_date = ?", (scan.scan_date,))
        for seg in scan.segments:
            self._conn.execute(
                """INSERT INTO inbody_segment
                (scan_date, segment, lean_mass_kg, fat_mass_kg, lean_pct_of_standard, fat_pct_of_standard)
                VALUES (?,?,?,?,?,?)""",
                (scan.scan_date, seg.segment, seg.lean_mass_kg, seg.fat_mass_kg,
                 seg.lean_pct_of_standard, seg.fat_pct_of_standard),
            )
        self._conn.commit()

    def list_inbody_scans(self, days: int | None = None) -> list[sqlite3.Row]:
        if days is not None:
            return self._conn.execute(
                "SELECT * FROM inbody_scan WHERE scan_date >= date('now', ?) "
                "ORDER BY scan_date DESC",
                (f"-{days} days",),
            ).fetchall()
        return self._conn.execute(
            "SELECT * FROM inbody_scan ORDER BY scan_date DESC"
        ).fetchall()

    def get_inbody_scan(self, scan_date: str) -> sqlite3.Row | None:
        return self._conn.execute(
            "SELECT * FROM inbody_scan WHERE scan_date = ?", (scan_date,)
        ).fetchone()

    def get_inbody_segments(self, scan_date: str) -> list[sqlite3.Row]:
        return self._conn.execute(
            "SELECT * FROM inbody_segment WHERE scan_date = ? ORDER BY segment",
            (scan_date,),
        ).fetchall()

    def latest_inbody_scan(self) -> sqlite3.Row | None:
        return self._conn.execute(
            "SELECT * FROM inbody_scan ORDER BY scan_date DESC LIMIT 1"
        ).fetchone()

    # --- Ability score (custom running ability system) ---

    def upsert_ability_snapshot(
        self,
        date: str,
        level: str,
        dimension: str,
        value: float | None,
        evidence_activity_ids: list[str] | None = None,
    ) -> None:
        evidence_json = json.dumps(evidence_activity_ids or [])
        self._conn.execute(
            """INSERT OR REPLACE INTO ability_snapshot
               (date, level, dimension, value, evidence_activity_ids, computed_at)
               VALUES (?, ?, ?, ?, ?, datetime('now'))""",
            (date, level, dimension, value, evidence_json),
        )
        self._conn.commit()

    def upsert_activity_ability(
        self,
        label_id: str,
        l1_quality: float | None,
        l1_breakdown: dict | None = None,
        contribution: dict | None = None,
    ) -> None:
        self._conn.execute(
            """INSERT OR REPLACE INTO activity_ability
               (label_id, l1_quality, l1_breakdown, contribution, computed_at)
               VALUES (?, ?, ?, ?, datetime('now'))""",
            (
                label_id,
                l1_quality,
                json.dumps(l1_breakdown or {}),
                json.dumps(contribution or {}),
            ),
        )
        self._conn.commit()

    def fetch_ability_history(self, days: int = 90) -> list[sqlite3.Row]:
        """Return ability_snapshot rows within the last `days` days.

        Dates are stored as YYYY-MM-DD (local Shanghai date semantics upstream);
        filtering uses SQLite's date arithmetic on the `date` column directly.
        """
        return self._conn.execute(
            """SELECT date, level, dimension, value, evidence_activity_ids, computed_at
               FROM ability_snapshot
               WHERE date >= date('now', ?)
               ORDER BY date DESC, level, dimension""",
            (f"-{days} days",),
        ).fetchall()

    def fetch_activity_ability(self, label_id: str) -> sqlite3.Row | None:
        return self._conn.execute(
            """SELECT label_id, l1_quality, l1_breakdown, contribution, computed_at
               FROM activity_ability WHERE label_id = ?""",
            (label_id,),
        ).fetchone()

    # --- Query helpers for analysis ---

    def query(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        return self._conn.execute(sql, params).fetchall()
