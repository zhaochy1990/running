"""SQLite database layer — schema creation, upserts, and queries."""

from __future__ import annotations

import json
import shutil
import sqlite3
import tempfile
from pathlib import Path

from platformdirs import user_data_dir

from .models import (
    ActivityDetail, BodyCompositionScan, BodySegment, DailyHealth, DailyHrv,
    Dashboard, Lap, RacePrediction, TimeseriesPoint, Zone,
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
    -- Provider-agnostic normalized enums written by the adapter; legacy
    -- columns (sport_type/train_type/feel_type) stay populated as the
    -- COROS-original source-of-truth used by ability.py and existing readers.
    sport           TEXT,
    train_kind      TEXT,
    feel            TEXT,
    provider        TEXT NOT NULL DEFAULT 'coros',
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
    fatigue         REAL,
    provider        TEXT NOT NULL DEFAULT 'coros'
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
    provider            TEXT NOT NULL DEFAULT 'coros',
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

-- Phase 3: per-day HRV detail (separate table because the row is heavier
-- than daily_health and not all providers populate it).
CREATE TABLE IF NOT EXISTS daily_hrv (
    date                       TEXT PRIMARY KEY,
    weekly_avg                 INTEGER,
    last_night_avg             INTEGER,
    last_night_5min_high       INTEGER,
    status                     TEXT,    -- 'BALANCED' | 'UNBALANCED' | 'POOR' | 'LOW' | 'NO_STATUS'
    baseline_low_upper         INTEGER,
    baseline_balanced_low      INTEGER,
    baseline_balanced_upper    INTEGER,
    feedback_phrase            TEXT,
    provider                   TEXT NOT NULL DEFAULT 'coros'
);

CREATE TABLE IF NOT EXISTS scheduled_workout (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    date                  TEXT NOT NULL,                          -- ISO YYYY-MM-DD
    kind                  TEXT NOT NULL,                          -- 'run' | 'strength'
    name                  TEXT NOT NULL,                          -- '[STRIDE] Easy 10K'
    spec_json             TEXT NOT NULL,                          -- NormalizedRunWorkout / NormalizedStrengthWorkout JSON
    status                TEXT NOT NULL DEFAULT 'draft',          -- 'draft' | 'pushed' | 'completed' | 'skipped'
    provider              TEXT,                                   -- after push: 'coros' | 'garmin'
    provider_workout_id   TEXT,                                   -- after push: watch-side ID
    pushed_at             TEXT,
    completed_label_id    TEXT REFERENCES activities(label_id),
    note                  TEXT,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_scheduled_workout_date ON scheduled_workout(date);
CREATE INDEX IF NOT EXISTS idx_scheduled_workout_status ON scheduled_workout(status);

-- Structured weekly-plan layer (derived from weekly_plan.content_md via LLM
-- reverse parsing). Date-keyed; session_index disambiguates double-session
-- days. spec_json carries either a NormalizedRunWorkout or
-- NormalizedStrengthWorkout payload (the same one the push pipeline uses) —
-- or NULL for aspirational sessions / rest / cross / note.
CREATE TABLE IF NOT EXISTS planned_session (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    week_folder           TEXT NOT NULL,                          -- '2026-04-20_04-26(W0)'
    date                  TEXT NOT NULL,                          -- ISO YYYY-MM-DD
    session_index         INTEGER NOT NULL DEFAULT 0,
    kind                  TEXT NOT NULL,                          -- 'run' | 'strength' | 'rest' | 'cross' | 'note'
    summary               TEXT NOT NULL,
    spec_json             TEXT,                                   -- nullable; null = aspirational / non-pushable
    notes_md              TEXT,
    total_distance_m      REAL,
    total_duration_s      REAL,
    scheduled_workout_id  INTEGER REFERENCES scheduled_workout(id),
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(date, session_index)
);
CREATE INDEX IF NOT EXISTS idx_planned_session_week ON planned_session(week_folder);
CREATE INDEX IF NOT EXISTS idx_planned_session_date ON planned_session(date);

CREATE TABLE IF NOT EXISTS planned_nutrition (
    date            TEXT PRIMARY KEY,                             -- ISO YYYY-MM-DD
    week_folder     TEXT NOT NULL,
    kcal_target     REAL,
    carbs_g         REAL,
    protein_g       REAL,
    fat_g           REAL,
    water_ml        REAL,
    meals_json      TEXT,                                         -- JSON list[Meal]
    notes_md        TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_planned_nutrition_week ON planned_nutrition(week_folder);

-- Multi-variant weekly plans (Step 1, post-spike fallback design):
-- a parallel storage area for unselected variants. The `weekly_plan` row
-- remains the canonical source of truth; selection promotes a variant's
-- content_md + structured_json into `weekly_plan` + `planned_session` +
-- `planned_nutrition` and stamps `weekly_plan.selected_variant_id`.
-- Append-only: re-running the same model on the same week supersedes the
-- prior row (UPDATE superseded_at = now) and INSERTs a new row, so the
-- ratings attached to old content remain attributable to that exact text.
CREATE TABLE IF NOT EXISTS weekly_plan_variant (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    week_folder              TEXT NOT NULL,                       -- '2026-05-04_05-10(P1W2)'
    model_id                 TEXT NOT NULL,                       -- 'claude-opus-4-7' / 'gpt-5-codex' / 'gemini-2.5-pro' / etc.
    schema_version           INTEGER NOT NULL DEFAULT 1,          -- matches plan_spec.SUPPORTED_SCHEMA_VERSION at write time
    content_md               TEXT NOT NULL,                       -- the variant's markdown
    structured_json          TEXT,                                -- WeeklyPlan.to_dict() JSON; NULL when parse_failed
    variant_parse_status     TEXT NOT NULL DEFAULT 'fresh',       -- 'fresh' | 'parse_failed'
    parsed_from_md_hash      TEXT,
    generation_metadata_json TEXT,                                -- optional audit blob (prompt_version, latency, etc.)
    superseded_at            TEXT,                                -- non-NULL = no longer selectable
    generated_at             TEXT NOT NULL DEFAULT (datetime('now')),
    created_at               TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_weekly_plan_variant_week ON weekly_plan_variant(week_folder);
CREATE INDEX IF NOT EXISTS idx_weekly_plan_variant_active ON weekly_plan_variant(week_folder, superseded_at);
-- Active-row uniqueness (only one active variant per model per week).
-- Partial index on superseded_at IS NULL — superseded rows are unrestricted.
CREATE UNIQUE INDEX IF NOT EXISTS idx_weekly_plan_variant_active_unique
    ON weekly_plan_variant(week_folder, model_id)
    WHERE superseded_at IS NULL;

-- Per-variant ratings, normalized so we can aggregate across variants /
-- models / dimensions later. CASCADE on DELETE is a silent no-op since
-- this codebase has PRAGMA foreign_keys=OFF; `delete_weekly_plan_variants`
-- does the cleanup explicitly in two steps.
CREATE TABLE IF NOT EXISTS weekly_plan_variant_rating (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    weekly_plan_variant_id   INTEGER NOT NULL REFERENCES weekly_plan_variant(id) ON DELETE CASCADE,
    dimension                TEXT NOT NULL,                       -- 'suitability' | 'structure' | 'nutrition' | 'difficulty' | 'overall'
    score                    INTEGER NOT NULL,                    -- 1..5
    comment                  TEXT,
    rated_by                 TEXT NOT NULL,                       -- user_id (UUID); permits multi-user rating
    rated_at                 TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(weekly_plan_variant_id, dimension, rated_by)
);
CREATE INDEX IF NOT EXISTS idx_weekly_plan_variant_rating_variant
    ON weekly_plan_variant_rating(weekly_plan_variant_id);
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
        # Structured-plan layer status. Tracks whether the JSON sibling
        # (planned_session + planned_nutrition) is in sync with content_md.
        # 'fresh' / 'stale' / 'parse_failed' / 'backfilled' / 'none' / NULL.
        _add("weekly_plan", "structured_status", "TEXT")
        _add("weekly_plan", "structured_parsed_at", "TEXT")
        _add("weekly_plan", "parsed_from_md_hash", "TEXT")
        _add("weekly_plan", "structured_source", "TEXT")
        # v1 multi-provider migration: tag every existing row with the
        # current sole provider so multi-provider routing works without a
        # backfill pass. Defaults to 'coros' since that's the only existing
        # data source; a future Garmin user starts with these rows empty.
        _add("activities", "provider", "TEXT NOT NULL DEFAULT 'coros'")
        _add("daily_health", "provider", "TEXT NOT NULL DEFAULT 'coros'")
        _add("dashboard", "provider", "TEXT NOT NULL DEFAULT 'coros'")
        # Step D: normalized enum columns. Existing rows get NULL — they're
        # backfilled organically as users sync (each upsert overwrites).
        # Frontend should treat these as the preferred source where present
        # and fall back to sport_type / train_type / feel_type otherwise.
        _add("activities", "sport", "TEXT")
        _add("activities", "train_kind", "TEXT")
        _add("activities", "feel", "TEXT")
        # Phase 3: Garmin-rich extras. NULL for COROS rows (no equivalent
        # source data). Running form metrics on activities.
        _add("activities", "vertical_oscillation_mm", "REAL")
        _add("activities", "ground_contact_time_ms", "REAL")
        _add("activities", "vertical_ratio_pct", "REAL")
        # Daily wellness extras (Body Battery, stress, sleep stages).
        _add("daily_health", "body_battery_high", "INTEGER")
        _add("daily_health", "body_battery_low", "INTEGER")
        _add("daily_health", "stress_avg", "INTEGER")
        _add("daily_health", "sleep_total_s", "INTEGER")
        _add("daily_health", "sleep_deep_s", "INTEGER")
        _add("daily_health", "sleep_light_s", "INTEGER")
        _add("daily_health", "sleep_rem_s", "INTEGER")
        _add("daily_health", "sleep_awake_s", "INTEGER")
        _add("daily_health", "sleep_score", "INTEGER")
        _add("daily_health", "respiration_avg", "REAL")
        _add("daily_health", "spo2_avg", "REAL")
        # Multi-variant weekly plans (Step 1, post-spike fallback design):
        # selection pointers on weekly_plan + abandoned-marker on
        # scheduled_workout for orphans created by promote.
        _add("weekly_plan", "selected_variant_id", "INTEGER")
        _add("weekly_plan", "selected_at", "TEXT")
        _add("scheduled_workout", "abandoned_by_promote_at", "TEXT")
        # The two new variant tables are created via SCHEMA above (idempotent
        # CREATE TABLE IF NOT EXISTS). Older DBs that ran SCHEMA before these
        # tables existed will not have them yet, so re-run the targeted
        # CREATE statements here as a safety net.
        for stmt in (
            "CREATE TABLE IF NOT EXISTS weekly_plan_variant ("
            "    id INTEGER PRIMARY KEY AUTOINCREMENT,"
            "    week_folder TEXT NOT NULL,"
            "    model_id TEXT NOT NULL,"
            "    schema_version INTEGER NOT NULL DEFAULT 1,"
            "    content_md TEXT NOT NULL,"
            "    structured_json TEXT,"
            "    variant_parse_status TEXT NOT NULL DEFAULT 'fresh',"
            "    parsed_from_md_hash TEXT,"
            "    generation_metadata_json TEXT,"
            "    superseded_at TEXT,"
            "    generated_at TEXT NOT NULL DEFAULT (datetime('now')),"
            "    created_at TEXT NOT NULL DEFAULT (datetime('now')),"
            "    updated_at TEXT NOT NULL DEFAULT (datetime('now'))"
            ")",
            "CREATE INDEX IF NOT EXISTS idx_weekly_plan_variant_week "
            "ON weekly_plan_variant(week_folder)",
            "CREATE INDEX IF NOT EXISTS idx_weekly_plan_variant_active "
            "ON weekly_plan_variant(week_folder, superseded_at)",
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_weekly_plan_variant_active_unique "
            "ON weekly_plan_variant(week_folder, model_id) "
            "WHERE superseded_at IS NULL",
            "CREATE TABLE IF NOT EXISTS weekly_plan_variant_rating ("
            "    id INTEGER PRIMARY KEY AUTOINCREMENT,"
            "    weekly_plan_variant_id INTEGER NOT NULL REFERENCES weekly_plan_variant(id) ON DELETE CASCADE,"
            "    dimension TEXT NOT NULL,"
            "    score INTEGER NOT NULL,"
            "    comment TEXT,"
            "    rated_by TEXT NOT NULL,"
            "    rated_at TEXT NOT NULL DEFAULT (datetime('now')),"
            "    UNIQUE(weekly_plan_variant_id, dimension, rated_by)"
            ")",
            "CREATE INDEX IF NOT EXISTS idx_weekly_plan_variant_rating_variant "
            "ON weekly_plan_variant_rating(weekly_plan_variant_id)",
        ):
            self._conn.execute(stmt)

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> Database:
        return self

    def __exit__(self, *args) -> None:
        self.close()

    # --- Activities ---

    def upsert_activity(self, a: ActivityDetail, *, provider: str = "coros") -> None:
        self._conn.execute(
            """INSERT OR REPLACE INTO activities
            (label_id, name, sport_type, sport_name, date, distance_m, duration_s,
             avg_pace_s_km, adjusted_pace, best_km_pace, max_pace,
             avg_hr, max_hr, avg_cadence, max_cadence, avg_power, max_power,
             avg_step_len_cm, ascent_m, descent_m, calories_kcal,
             aerobic_effect, anaerobic_effect, training_load, vo2max, performance, train_type,
             temperature, humidity, feels_like, wind_speed, feel_type, sport_note,
             sport, train_kind, feel,
             vertical_oscillation_mm, ground_contact_time_ms, vertical_ratio_pct,
             provider)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (a.label_id, a.name, a.sport_type, a.sport_name, a.date,
             a.distance_m, a.duration_s, a.avg_pace_s_km, a.adjusted_pace,
             a.best_km_pace, a.max_pace, a.avg_hr, a.max_hr,
             a.avg_cadence, a.max_cadence, a.avg_power, a.max_power,
             a.avg_step_len_cm, a.ascent_m, a.descent_m, a.calories_kcal,
             a.aerobic_effect, a.anaerobic_effect, a.training_load,
             a.vo2max, a.performance, a.train_type,
             a.temperature, a.humidity, a.feels_like, a.wind_speed,
             a.feel_type, a.sport_note,
             a.sport, a.train_kind, a.feel,
             a.vertical_oscillation_mm, a.ground_contact_time_ms, a.vertical_ratio_pct,
             provider),
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

    def upsert_daily_health(self, h: DailyHealth, *, provider: str = "coros") -> None:
        self._conn.execute(
            """INSERT OR REPLACE INTO daily_health
            (date, ati, cti, rhr, distance_m, duration_s, training_load_ratio,
             training_load_state, fatigue,
             body_battery_high, body_battery_low, stress_avg,
             sleep_total_s, sleep_deep_s, sleep_light_s, sleep_rem_s, sleep_awake_s, sleep_score,
             respiration_avg, spo2_avg,
             provider)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (h.date, h.ati, h.cti, h.rhr, h.distance_m, h.duration_s,
             h.training_load_ratio, h.training_load_state, h.fatigue,
             h.body_battery_high, h.body_battery_low, h.stress_avg,
             h.sleep_total_s, h.sleep_deep_s, h.sleep_light_s, h.sleep_rem_s,
             h.sleep_awake_s, h.sleep_score,
             h.respiration_avg, h.spo2_avg,
             provider),
        )
        self._conn.commit()

    def upsert_daily_hrv(self, h: DailyHrv, *, provider: str = "garmin") -> None:
        """Upsert a per-day HRV detail row (Garmin-rich, COROS-empty for v1)."""
        self._conn.execute(
            """INSERT OR REPLACE INTO daily_hrv
            (date, weekly_avg, last_night_avg, last_night_5min_high, status,
             baseline_low_upper, baseline_balanced_low, baseline_balanced_upper,
             feedback_phrase, provider)
            VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (h.date, h.weekly_avg, h.last_night_avg, h.last_night_5min_high, h.status,
             h.baseline_low_upper, h.baseline_balanced_low, h.baseline_balanced_upper,
             h.feedback_phrase, provider),
        )
        self._conn.commit()

    def upsert_dashboard(self, d: Dashboard, *, provider: str = "coros") -> None:
        self._conn.execute(
            """INSERT OR REPLACE INTO dashboard
            (id, running_level, aerobic_score, lactate_threshold_score,
             anaerobic_endurance_score, anaerobic_capacity_score,
             rhr, threshold_hr, threshold_pace_s_km, recovery_pct,
             avg_sleep_hrv, hrv_normal_low, hrv_normal_high,
             weekly_distance_m, weekly_duration_s, provider)
            VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (d.running_level, d.aerobic_score, d.lactate_threshold_score,
             d.anaerobic_endurance_score, d.anaerobic_capacity_score,
             d.rhr, d.threshold_hr, d.threshold_pace_s_km, d.recovery_pct,
             d.avg_sleep_hrv, d.hrv_normal_low, d.hrv_normal_high,
             d.weekly_distance_m, d.weekly_duration_s, provider),
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
            "SELECT week, content_md, generated_by, generated_at, created_at, updated_at, "
            "       structured_status, structured_parsed_at, parsed_from_md_hash, "
            "       selected_variant_id, selected_at "
            "FROM weekly_plan WHERE week = ?",
            (week,),
        ).fetchone()

    def upsert_weekly_plan(
        self, week: str, content_md: str, *, generated_by: str | None = None,
        commit: bool = True, conn: sqlite3.Connection | None = None,
    ) -> None:
        c = conn or self._conn
        c.execute(
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
        if commit:
            c.commit()

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

    # --- Scheduled workouts (provider-agnostic structured calendar) ---
    #
    # Authored locally as `NormalizedRunWorkout` / `NormalizedStrengthWorkout`,
    # serialized as JSON in `spec_json`. The lifecycle is:
    #   draft  → user is editing
    #   pushed → adapter has translated + sent to the watch (provider/id stamped)
    #   completed → matched to a synced activity (label_id stamped)
    #   skipped → user explicitly cancelled / missed
    # The DB doesn't enforce transitions; callers move state forward via the
    # `mark_*` helpers below.

    def create_scheduled_workout(
        self,
        *,
        date: str,
        kind: str,
        name: str,
        spec_json: str,
        status: str = "draft",
        note: str | None = None,
    ) -> int:
        cur = self._conn.execute(
            """INSERT INTO scheduled_workout
               (date, kind, name, spec_json, status, note)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (date, kind, name, spec_json, status, note),
        )
        self._conn.commit()
        return cur.lastrowid

    def get_scheduled_workout(self, workout_id: int) -> sqlite3.Row | None:
        return self._conn.execute(
            "SELECT * FROM scheduled_workout WHERE id = ?", (workout_id,)
        ).fetchone()

    def list_scheduled_workouts(
        self,
        *,
        start: str | None = None,
        end: str | None = None,
        kind: str | None = None,
        status: str | None = None,
    ) -> list[sqlite3.Row]:
        clauses: list[str] = []
        params: list = []
        if start is not None:
            clauses.append("date >= ?")
            params.append(start)
        if end is not None:
            clauses.append("date <= ?")
            params.append(end)
        if kind is not None:
            clauses.append("kind = ?")
            params.append(kind)
        if status is not None:
            clauses.append("status = ?")
            params.append(status)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        return self._conn.execute(
            f"SELECT * FROM scheduled_workout {where} ORDER BY date, id",
            tuple(params),
        ).fetchall()

    def update_scheduled_workout_spec(
        self,
        workout_id: int,
        *,
        spec_json: str | None = None,
        name: str | None = None,
        note: str | None = None,
    ) -> None:
        sets: list[str] = []
        params: list = []
        if spec_json is not None:
            sets.append("spec_json = ?")
            params.append(spec_json)
        if name is not None:
            sets.append("name = ?")
            params.append(name)
        if note is not None:
            sets.append("note = ?")
            params.append(note)
        if not sets:
            return
        sets.append("updated_at = datetime('now')")
        params.append(workout_id)
        self._conn.execute(
            f"UPDATE scheduled_workout SET {', '.join(sets)} WHERE id = ?",
            tuple(params),
        )
        self._conn.commit()

    def mark_scheduled_workout_pushed(
        self, workout_id: int, *, provider: str, provider_workout_id: str
    ) -> None:
        self._conn.execute(
            """UPDATE scheduled_workout
               SET status = 'pushed',
                   provider = ?,
                   provider_workout_id = ?,
                   pushed_at = datetime('now'),
                   updated_at = datetime('now')
               WHERE id = ?""",
            (provider, provider_workout_id, workout_id),
        )
        self._conn.commit()

    def mark_scheduled_workout_completed(
        self, workout_id: int, *, label_id: str
    ) -> None:
        self._conn.execute(
            """UPDATE scheduled_workout
               SET status = 'completed',
                   completed_label_id = ?,
                   updated_at = datetime('now')
               WHERE id = ?""",
            (label_id, workout_id),
        )
        self._conn.commit()

    def mark_scheduled_workout_skipped(self, workout_id: int) -> None:
        self._conn.execute(
            """UPDATE scheduled_workout
               SET status = 'skipped', updated_at = datetime('now')
               WHERE id = ?""",
            (workout_id,),
        )
        self._conn.commit()

    def delete_scheduled_workout(self, workout_id: int) -> bool:
        cur = self._conn.execute(
            "DELETE FROM scheduled_workout WHERE id = ?", (workout_id,)
        )
        self._conn.commit()
        return cur.rowcount > 0

    # --- Structured weekly plan (planned_session / planned_nutrition) ---
    #
    # The markdown in weekly_plan.content_md is the canonical source of truth.
    # This layer is a derived JSON cache produced by the LLM reverse parser.
    # Helpers here are intentionally idempotent — every upsert wipes the
    # existing rows for the affected week before reinserting, so a re-parse
    # never leaves stale rows behind.

    def upsert_planned_sessions(
        self, week_folder: str, sessions: list, *, commit: bool = True,
        conn: sqlite3.Connection | None = None,
    ) -> list[int]:
        """Replace all planned_session rows for a week.

        ``sessions`` is a list of ``stride_core.plan_spec.PlannedSession``.
        Returns the list of newly-assigned row ids in input order so callers
        can stitch them into other tables (e.g. push pipeline).
        Pass ``commit=False`` to defer the commit to the caller (used by
        ``apply_weekly_plan`` so all writes land atomically inside one
        ``with db._conn:`` block). Pass ``conn=`` to redirect writes onto a
        dedicated immediate-txn connection (used by promote/select).
        """
        import json as _json

        c = conn or self._conn
        cur = c.execute(
            "DELETE FROM planned_session WHERE week_folder = ?", (week_folder,)
        )
        ids: list[int] = []
        for s in sessions:
            spec_json = _json.dumps(s.spec.to_dict()) if s.spec is not None else None
            row = c.execute(
                """INSERT INTO planned_session
                (week_folder, date, session_index, kind, summary, spec_json,
                 notes_md, total_distance_m, total_duration_s,
                 scheduled_workout_id, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?, datetime('now'))""",
                (
                    week_folder, s.date, s.session_index, s.kind.value, s.summary,
                    spec_json, s.notes_md, s.total_distance_m, s.total_duration_s,
                    s.scheduled_workout_id,
                ),
            )
            ids.append(row.lastrowid)
        if commit:
            c.commit()
        _ = cur  # silence unused-var; kept for clarity that DELETE precedes INSERTs
        return ids

    def upsert_planned_nutrition(
        self, week_folder: str, nutrition: list, *, commit: bool = True,
        conn: sqlite3.Connection | None = None,
    ) -> None:
        """Replace all planned_nutrition rows for a week.

        ``nutrition`` is a list of ``stride_core.plan_spec.PlannedNutrition``.
        Pass ``commit=False`` to defer the commit to the caller. Pass
        ``conn=`` to redirect writes onto a dedicated immediate-txn
        connection (used by promote/select).
        """
        import json as _json

        c = conn or self._conn
        c.execute(
            "DELETE FROM planned_nutrition WHERE week_folder = ?", (week_folder,)
        )
        for n in nutrition:
            meals_json = _json.dumps([m.to_dict() for m in n.meals])
            c.execute(
                """INSERT INTO planned_nutrition
                (date, week_folder, kcal_target, carbs_g, protein_g, fat_g,
                 water_ml, meals_json, notes_md, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?, datetime('now'))""",
                (
                    n.date, week_folder, n.kcal_target, n.carbs_g, n.protein_g,
                    n.fat_g, n.water_ml, meals_json, n.notes_md,
                ),
            )
        if commit:
            c.commit()

    def get_planned_sessions(
        self, *, date_from: str | None = None, date_to: str | None = None,
        week_folder: str | None = None,
        conn: sqlite3.Connection | None = None,
    ) -> list[sqlite3.Row]:
        clauses: list[str] = []
        params: list = []
        if week_folder is not None:
            clauses.append("week_folder = ?")
            params.append(week_folder)
        if date_from is not None:
            clauses.append("date >= ?")
            params.append(date_from)
        if date_to is not None:
            clauses.append("date <= ?")
            params.append(date_to)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        c = conn or self._conn
        return c.execute(
            f"SELECT * FROM planned_session {where} ORDER BY date, session_index, id",
            tuple(params),
        ).fetchall()

    def get_planned_nutrition(
        self, *, date_from: str | None = None, date_to: str | None = None,
        week_folder: str | None = None,
    ) -> list[sqlite3.Row]:
        clauses: list[str] = []
        params: list = []
        if week_folder is not None:
            clauses.append("week_folder = ?")
            params.append(week_folder)
        if date_from is not None:
            clauses.append("date >= ?")
            params.append(date_from)
        if date_to is not None:
            clauses.append("date <= ?")
            params.append(date_to)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        return self._conn.execute(
            f"SELECT * FROM planned_nutrition {where} ORDER BY date",
            tuple(params),
        ).fetchall()

    def set_weekly_plan_structured_status(
        self, week: str, *, status: str, parsed_from_md_hash: str | None = None,
        commit: bool = True, conn: sqlite3.Connection | None = None,
    ) -> None:
        """Record the structured-layer state on the parent weekly_plan row.
        Pass ``commit=False`` to defer the commit to the caller. Pass
        ``conn=`` to redirect onto a dedicated immediate-txn connection.
        """
        c = conn or self._conn
        c.execute(
            """UPDATE weekly_plan
               SET structured_status = ?,
                   structured_source = ?,
                   structured_parsed_at = datetime('now'),
                   parsed_from_md_hash = COALESCE(?, parsed_from_md_hash),
                   updated_at = datetime('now')
               WHERE week = ?""",
            (status, status, parsed_from_md_hash, week),
        )
        if commit:
            c.commit()

    def mark_plan_parse_failed(self, week: str) -> None:
        self.set_weekly_plan_structured_status(week, status="parse_failed")

    def set_planned_session_scheduled_workout(
        self, planned_session_id: int, scheduled_workout_id: int,
        *, commit: bool = True, conn: sqlite3.Connection | None = None,
    ) -> None:
        c = conn or self._conn
        c.execute(
            """UPDATE planned_session
               SET scheduled_workout_id = ?, updated_at = datetime('now')
               WHERE id = ?""",
            (scheduled_workout_id, planned_session_id),
        )
        if commit:
            c.commit()

    def open_immediate_txn(self) -> sqlite3.Connection:
        """Open a fresh sqlite3 connection in manual-commit mode and acquire
        the SQLite write lock immediately via ``BEGIN IMMEDIATE``.

        The returned connection is owned by the caller, who is responsible
        for ``commit()``/``rollback()`` and ``close()``. Failing to close
        leaks the write lock.

        Sets ``busy_timeout`` to 100 ms so concurrent select-variant attempts
        surface a clean ``database is locked`` error (translatable to HTTP
        409 retry-after) instead of an immediate hard failure on transient
        races.
        """
        conn = sqlite3.connect(str(self._path), isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 100")
        conn.execute("BEGIN IMMEDIATE")
        return conn

    def get_planned_session(self, planned_session_id: int) -> sqlite3.Row | None:
        return self._conn.execute(
            "SELECT * FROM planned_session WHERE id = ?", (planned_session_id,)
        ).fetchone()

    def get_planned_session_by_date_index(
        self, date: str, session_index: int,
    ) -> sqlite3.Row | None:
        return self._conn.execute(
            "SELECT * FROM planned_session WHERE date = ? AND session_index = ?",
            (date, session_index),
        ).fetchone()

    # ─────────────────────────────────────────────────────────────────
    # Multi-variant weekly plans (Step 1, post-spike fallback design)
    # ─────────────────────────────────────────────────────────────────
    #
    # `weekly_plan_variant` is an append-only side table: re-running the
    # same model on the same week supersedes the prior row (sets
    # `superseded_at`) and INSERTs a new row, so ratings attached to old
    # content stay attributable to that exact text.
    #
    # `select_weekly_plan_variant` runs the FALLBACK promote design (per
    # Step 0 spike Phase B exp 2 — hit-rate 73.7% < 90% gate, so re-stitch
    # is not implemented). All entries in `prior_map` (the previously
    # pushed scheduled_workout ids for this week) are marked
    # `abandoned_by_promote_at`; the new planned_session rows have
    # `scheduled_workout_id = NULL` and the UI must guide the user to
    # delete the orphans on COROS before pushing again.

    def insert_weekly_plan_variant(
        self,
        week_folder: str,
        model_id: str,
        content_md: str,
        structured_json: str | None,
        *,
        schema_version: int = 1,
        variant_parse_status: str = "fresh",
        parsed_from_md_hash: str | None = None,
        generation_metadata_json: str | None = None,
    ) -> int:
        """Append-only insert. If the active row for ``(week_folder, model_id)``
        exists, its ``superseded_at`` is set to ``now`` first (in the same
        transaction), then the new row is INSERTed and its id returned.
        """
        with self._conn:
            self._conn.execute(
                """UPDATE weekly_plan_variant
                       SET superseded_at = datetime('now'),
                           updated_at    = datetime('now')
                     WHERE week_folder = ?
                       AND model_id    = ?
                       AND superseded_at IS NULL""",
                (week_folder, model_id),
            )
            cur = self._conn.execute(
                """INSERT INTO weekly_plan_variant
                   (week_folder, model_id, schema_version, content_md,
                    structured_json, variant_parse_status,
                    parsed_from_md_hash, generation_metadata_json,
                    generated_at, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,
                           datetime('now'), datetime('now'), datetime('now'))""",
                (
                    week_folder, model_id, schema_version, content_md,
                    structured_json, variant_parse_status,
                    parsed_from_md_hash, generation_metadata_json,
                ),
            )
            return cur.lastrowid

    def get_weekly_plan_variants(
        self, week_folder: str, *, include_superseded: bool = False,
    ) -> list[sqlite3.Row]:
        """List variants for a week (oldest first, by ``generated_at``).

        ``variant_index`` is implicit — the order in the returned list IS
        the index. Callers/UI can attach it.
        """
        if include_superseded:
            return self._conn.execute(
                """SELECT * FROM weekly_plan_variant
                       WHERE week_folder = ?
                       ORDER BY generated_at, id""",
                (week_folder,),
            ).fetchall()
        return self._conn.execute(
            """SELECT * FROM weekly_plan_variant
                   WHERE week_folder = ? AND superseded_at IS NULL
                   ORDER BY generated_at, id""",
            (week_folder,),
        ).fetchall()

    def get_weekly_plan_variant(self, variant_id: int) -> sqlite3.Row | None:
        return self._conn.execute(
            "SELECT * FROM weekly_plan_variant WHERE id = ?", (variant_id,),
        ).fetchone()

    def delete_weekly_plan_variants(self, week_folder: str) -> int:
        """Explicit two-step delete (CASCADE is a silent no-op without
        ``PRAGMA foreign_keys=ON`` which this project doesn't enable
        globally). Returns the count of deleted ``weekly_plan_variant``
        rows. Both DELETEs run inside a single transaction so a crash
        between them can't leave orphan ratings.
        """
        with self._conn:
            self._conn.execute(
                """DELETE FROM weekly_plan_variant_rating
                   WHERE weekly_plan_variant_id IN (
                       SELECT id FROM weekly_plan_variant WHERE week_folder = ?
                   )""",
                (week_folder,),
            )
            cur = self._conn.execute(
                "DELETE FROM weekly_plan_variant WHERE week_folder = ?",
                (week_folder,),
            )
            return cur.rowcount

    def upsert_variant_rating(
        self,
        variant_id: int,
        dimension: str,
        score: int,
        *,
        comment: str | None = None,
        rated_by: str,
    ) -> None:
        """UPSERT keyed by (variant_id, dimension, rated_by). Re-rating
        the same dimension by the same user replaces the prior score.
        """
        if not (1 <= score <= 5):
            raise ValueError(f"score must be 1..5, got {score}")
        self._conn.execute(
            """INSERT INTO weekly_plan_variant_rating
               (weekly_plan_variant_id, dimension, score, comment, rated_by, rated_at)
               VALUES (?,?,?,?,?, datetime('now'))
               ON CONFLICT(weekly_plan_variant_id, dimension, rated_by)
               DO UPDATE SET
                   score    = excluded.score,
                   comment  = excluded.comment,
                   rated_at = excluded.rated_at""",
            (variant_id, dimension, score, comment, rated_by),
        )
        self._conn.commit()

    def get_variant_ratings(self, variant_id: int) -> list[sqlite3.Row]:
        """Return all ratings for a variant. Caller decides how to
        aggregate (e.g., per-dimension mean across users vs. just one
        user's view)."""
        return self._conn.execute(
            """SELECT * FROM weekly_plan_variant_rating
                   WHERE weekly_plan_variant_id = ?
                   ORDER BY dimension, rated_by""",
            (variant_id,),
        ).fetchall()

    def select_weekly_plan_variant(
        self,
        user: str,
        week_folder: str,
        variant_id: int,
        *,
        force: bool = False,
    ) -> dict[str, Any]:
        """Promote a variant to canonical (FALLBACK design).

        Wraps the full select-promote sequence in a single dedicated
        immediate-txn connection. On any failure, rolls back; on success,
        commits and returns metadata.

        Returns one of:
          - ``{"ok": True, "selected_variant_id": int, "no_change": True}`` —
            already selected, no DB writes done.
          - ``{"ok": True, "selected_variant_id": int, "no_change": False,
                "dropped_scheduled_workout_ids": [int, ...]}`` — promoted.
          - ``{"ok": False, "error": "selection_conflict",
                "already_pushed_count": int}`` — `force=False` and
            ``prior_map`` non-empty. (HTTP layer renders this 409.)
          - ``{"ok": False, "error": "variant_schema_outdated",
                "variant_version": int, "server_version": int}`` —
            (HTTP layer renders 426.)
          - ``{"ok": False, "error": "variant_not_found"}``,
            ``"variant_wrong_week"``, ``"variant_parse_failed"``,
            ``"variant_superseded"`` — invalid variant; (400 each).

        Per Step 0 spike Phase B exp 2 (hit-rate 73.7% < 90% gate):
        re-stitch is NOT attempted. ALL entries in ``prior_map`` are
        marked ``abandoned_by_promote_at``; the new ``planned_session``
        rows have ``scheduled_workout_id = NULL``. The UI must guide
        the user to delete orphan [STRIDE] entries on COROS before the
        next push.
        """
        # Lazy import to avoid circular dep:
        # stride_server.coach_agent.agent imports stride_core.db.Database.
        from stride_server.coach_agent.agent import apply_weekly_plan
        from stride_core.plan_spec import (
            SUPPORTED_SCHEMA_VERSION, WeeklyPlan,
        )
        import json as _json

        # 1. Open dedicated immediate-txn connection.
        txn = self.open_immediate_txn()
        try:
            # 2. Validate variant.
            variant = txn.execute(
                "SELECT * FROM weekly_plan_variant WHERE id = ?",
                (variant_id,),
            ).fetchone()
            if variant is None:
                txn.execute("ROLLBACK")
                return {"ok": False, "error": "variant_not_found",
                        "variant_id": variant_id}
            if variant["week_folder"] != week_folder:
                txn.execute("ROLLBACK")
                return {"ok": False, "error": "variant_wrong_week",
                        "variant_id": variant_id,
                        "expected_week": week_folder,
                        "actual_week": variant["week_folder"]}
            if variant["superseded_at"] is not None:
                txn.execute("ROLLBACK")
                return {"ok": False, "error": "variant_superseded",
                        "variant_id": variant_id}
            if variant["variant_parse_status"] != "fresh":
                txn.execute("ROLLBACK")
                return {"ok": False, "error": "variant_parse_failed",
                        "variant_id": variant_id,
                        "variant_parse_status": variant["variant_parse_status"]}
            if variant["schema_version"] != SUPPORTED_SCHEMA_VERSION:
                txn.execute("ROLLBACK")
                return {"ok": False, "error": "variant_schema_outdated",
                        "variant_version": variant["schema_version"],
                        "server_version": SUPPORTED_SCHEMA_VERSION}

            # 3. Idempotent check: if this variant is already selected,
            # do nothing.
            wp = txn.execute(
                "SELECT selected_variant_id FROM weekly_plan WHERE week = ?",
                (week_folder,),
            ).fetchone()
            if wp is not None and wp["selected_variant_id"] == variant_id:
                txn.execute("ROLLBACK")  # nothing to commit
                return {"ok": True, "selected_variant_id": variant_id,
                        "no_change": True}

            # 4. Snapshot prior_map = list of scheduled_workout_ids that
            # currently back planned_session rows for this week. We
            # collect just the ids (FALLBACK design — no re-stitch, no
            # need for the (date, idx, kind) tuple).
            rows = txn.execute(
                """SELECT scheduled_workout_id FROM planned_session
                       WHERE week_folder = ?
                         AND scheduled_workout_id IS NOT NULL""",
                (week_folder,),
            ).fetchall()
            prior_sw_ids = [r["scheduled_workout_id"] for r in rows]

            # 5. Conflict check.
            if prior_sw_ids and not force:
                txn.execute("ROLLBACK")
                return {"ok": False, "error": "selection_conflict",
                        "already_pushed_count": len(prior_sw_ids),
                        "hint": ("传 force=true 二次确认 — 已 push session "
                                 "将被标 abandoned,需手动到 COROS 删除")}

            # 6. Deserialize structured plan.
            if variant["structured_json"] is None:
                # parse_failed variants have already been rejected above,
                # but defend in depth.
                txn.execute("ROLLBACK")
                return {"ok": False, "error": "variant_parse_failed",
                        "variant_id": variant_id}
            plan = WeeklyPlan.from_dict(_json.loads(variant["structured_json"]))

            # 7. apply_weekly_plan inside the dedicated txn.
            apply_weekly_plan(
                user=user,
                folder=week_folder,
                content=variant["content_md"],
                generated_by=variant["model_id"],
                structured=plan,
                structured_source="fresh",
                commit=False,
                conn=txn,
            )

            # 8. FALLBACK: mark ALL prior scheduled_workout ids abandoned.
            # New planned_session rows already have scheduled_workout_id=NULL
            # (apply_weekly_plan REPLACE; variant blob's sessions never
            # carry scheduled_workout_id).
            if prior_sw_ids:
                placeholders = ",".join("?" * len(prior_sw_ids))
                txn.execute(
                    f"UPDATE scheduled_workout "
                    f"SET abandoned_by_promote_at = datetime('now'), "
                    f"    updated_at = datetime('now') "
                    f"WHERE id IN ({placeholders})",
                    prior_sw_ids,
                )

            # 9. Stamp the selection on weekly_plan. apply_weekly_plan
            # already wrote/UPSERTed the weekly_plan row in the same txn,
            # so a plain UPDATE is sufficient.
            txn.execute(
                """UPDATE weekly_plan
                       SET selected_variant_id = ?,
                           selected_at = datetime('now'),
                           updated_at = datetime('now')
                       WHERE week = ?""",
                (variant_id, week_folder),
            )

            # 10. Commit.
            txn.execute("COMMIT")
            return {
                "ok": True,
                "selected_variant_id": variant_id,
                "no_change": False,
                "dropped_scheduled_workout_ids": list(prior_sw_ids),
            }
        except Exception:
            try:
                txn.execute("ROLLBACK")
            except sqlite3.Error:
                # txn already rolled back / closed by some earlier path.
                pass
            raise
        finally:
            txn.close()

    # --- Query helpers for analysis ---

    def query(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        return self._conn.execute(sql, params).fetchall()
