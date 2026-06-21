"""SQLite database layer — schema creation, upserts, and queries."""

from __future__ import annotations

import json
import math
import re as _re
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

_WEEK_FOLDER_RE = _re.compile(r"^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})")


def _parse_week_folder_dates(folder: str) -> tuple[str, str] | None:
    """Parse week_folder 'YYYY-MM-DD_MM-DD(...)' -> (start_iso, end_iso) or None.

    Used by ``upsert_planned_sessions`` / ``upsert_planned_nutrition`` to
    delete by date range rather than week_folder string match, which sweeps
    away orphan rows from earlier reparse runs that used a different
    week_folder spelling for the same calendar week.
    """
    m = _WEEK_FOLDER_RE.match(folder)
    if not m:
        return None
    year, smonth, sday, emonth, eday = m.groups()
    start = f"{year}-{smonth}-{sday}"
    # End date: same year, end MM-DD. Handle year wrap (e.g.
    # 2026-12-29_01-04) by checking if end month < start month.
    end_year = int(year) + (1 if int(emonth) < int(smonth) else 0)
    end = f"{end_year:04d}-{emonth}-{eday}"
    return (start, end)

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
-- Functional index on the Shanghai-day expression so queries that compare
-- `activities.date` (UTC ISO) in the Shanghai calendar via SHANGHAI_DAY_SQL
-- (see stride_core/timefmt.py) avoid a full table scan. Must match the
-- exact expression text in SHANGHAI_DAY_SQL for SQLite to use it.
CREATE INDEX IF NOT EXISTS idx_activities_shanghai_day
    ON activities(date(datetime(date, '+8 hours')));
-- Plain index on the raw UTC `date` column for queries that don't go through
-- SHANGHAI_DAY_SQL — `ORDER BY date DESC` (team feed, weeks list) and
-- last-sync probes (`SELECT MAX(date) FROM activities`).
CREATE INDEX IF NOT EXISTS idx_activities_date
    ON activities(date);

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
    power       INTEGER,
    ground_contact_time_ms  REAL,
    vertical_oscillation_mm REAL,
    vertical_ratio_pct      REAL,
    cadence_length_cm       REAL,
    slope                   INTEGER,
    heart_level             INTEGER,
    -- WGS84 GPS, decimal degrees. NULL when device had no fix or for
    -- indoor activities. Older rows synced before this column existed
    -- also stay NULL (organic backfill on next resync).
    gps_lat                 REAL,
    gps_lon                 REAL
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

CREATE TABLE IF NOT EXISTS activity_feedback (
    label_id    TEXT PRIMARY KEY,
    rpe         INTEGER,
    mood_tags   TEXT,
    note        TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
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

CREATE TABLE IF NOT EXISTS body_composition_scan (
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

CREATE TABLE IF NOT EXISTS body_composition_segment (
    scan_date               TEXT NOT NULL REFERENCES body_composition_scan(scan_date) ON DELETE CASCADE,
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

-- v7 PB-memory channel for VO2max. One row per (race_type x source
-- activity); current PB per race_type is MAX(vdot). Read by
-- stride_core.ability when computing the L3 VO2max dimension.
CREATE TABLE IF NOT EXISTS vo2max_pb (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    race_type       TEXT NOT NULL,
    distance_m      REAL NOT NULL,
    duration_s      REAL NOT NULL,
    vdot            REAL NOT NULL,
    pb_date         TEXT NOT NULL,
    label_id        TEXT NOT NULL,
    even_paced      INTEGER NOT NULL DEFAULT 1,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(race_type, label_id)
);
CREATE INDEX IF NOT EXISTS idx_vo2max_pb_vdot ON vo2max_pb(race_type, vdot DESC);

-- Persisted segment-matched personal bests — one row per display distance
-- (1K/3K/5K/10K/HM/FM). Populated post-sync by
-- stride_core.pb_records.persist_personal_bests, which caches the expensive
-- detect_personal_bests chronological scan. The SINGLE source read by the /pbs
-- route, the coach get_pbs tool, AND the master-plan generator so none of them
-- recompute ~7s of best-effort matching per call. ``entry_json`` holds the full
-- detector entry (history progression + segment offsets) so fetch returns a
-- byte-identical shape to a live scan; the scalar columns stay queryable.
-- Distinct from vo2max_pb (COROS VDOT memory) — this is the achieved-time PB.
CREATE TABLE IF NOT EXISTS personal_bests (
    distance     TEXT PRIMARY KEY,   -- '1K'|'3K'|'5K'|'10K'|'HM'|'FM'
    pb_time_sec  REAL NOT NULL,
    achieved_at  TEXT,               -- Shanghai YYYY-MM-DD the PB was run
    source       TEXT,               -- 'segment' | 'activity'
    entry_json   TEXT NOT NULL,      -- full detect_personal_bests entry (JSON)
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Phase 3: per-day HRV detail (separate table because the row is heavier
-- than daily_health and not all providers populate it). Composite PK so
-- a dual-watch user (e.g. COROS night + Garmin night for the same date)
-- can keep both rows — readers dedupe with a provider-priority order.
CREATE TABLE IF NOT EXISTS daily_hrv (
    date                       TEXT NOT NULL,
    weekly_avg                 INTEGER,
    last_night_avg             INTEGER,
    last_night_5min_high       INTEGER,
    status                     TEXT,    -- 'BALANCED' | 'UNBALANCED' | 'POOR' | 'LOW' | 'NO_STATUS'
    baseline_low_upper         INTEGER,
    baseline_balanced_low      INTEGER,
    baseline_balanced_upper    INTEGER,
    feedback_phrase            TEXT,
    provider                   TEXT NOT NULL DEFAULT 'coros',
    PRIMARY KEY (date, provider)
);

-- Objective training-load v1. Vendor black-box fields stay in activities /
-- daily_health; these tables hold STRIDE-computed TSS-like load. Mapping:
-- cardio_load_raw = Banister TRIMP; external_tss = rTSS/RSS/power TSS;
-- acute_load = ATL; chronic_load = CTL; form = TSB.
CREATE TABLE IF NOT EXISTS activity_training_load (
    label_id                 TEXT PRIMARY KEY REFERENCES activities(label_id),
    activity_date            TEXT NOT NULL,
    sport                    TEXT,
    session_class            TEXT,
    algorithm_version        INTEGER NOT NULL,
    calibration_id           INTEGER REFERENCES running_calibration_snapshot(id),
    cardio_load_raw          REAL,
    cardio_tss               REAL,
    external_tss             REAL,
    mechanical_load          REAL,
    subjective_internal_load REAL,
    training_dose            REAL,
    load_confidence          TEXT,
    excluded_from_pmc        INTEGER NOT NULL DEFAULT 1,
    reasons_json             TEXT,
    computed_at              TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_training_load_date ON activity_training_load(activity_date);

CREATE TABLE IF NOT EXISTS daily_training_load (
    date                    TEXT NOT NULL,
    algorithm_version       INTEGER NOT NULL,
    calibration_id          INTEGER REFERENCES running_calibration_snapshot(id),
    training_dose           REAL NOT NULL DEFAULT 0,
    acute_load              REAL,
    chronic_load            REAL,
    form                    REAL,
    load_ratio              REAL,
    readiness_gate          TEXT,
    readiness_reasons_json  TEXT,
    computed_at             TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(date, algorithm_version)
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
    UNIQUE(week_folder, date, session_index)
);
CREATE INDEX IF NOT EXISTS idx_planned_session_week ON planned_session(week_folder);
CREATE INDEX IF NOT EXISTS idx_planned_session_date ON planned_session(date);

CREATE TABLE IF NOT EXISTS planned_nutrition (
    week_folder     TEXT NOT NULL,
    date            TEXT NOT NULL,                                -- ISO YYYY-MM-DD
    kcal_target     REAL,
    carbs_g         REAL,
    protein_g       REAL,
    fat_g           REAL,
    water_ml        REAL,
    meals_json      TEXT,                                         -- JSON list[Meal]
    notes_md        TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (week_folder, date)
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

-- App-side structured post-activity feedback (D7 screen).
-- Separate from activities.sport_note which is the COROS-synced raw note.
-- label_id matches activities.label_id but no FK constraint (PRAGMA FK=OFF).
CREATE TABLE IF NOT EXISTS activity_feedback (
    label_id    TEXT PRIMARY KEY,
    rpe         INTEGER,          -- 1-10
    mood_tags   TEXT,             -- JSON array, e.g. ["腿酸","状态好","天气热"]
    note        TEXT,             -- user one-liner, nullable
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
);
"""


# Pick one daily_hrv row per date when a user has multiple providers writing
# the same calendar day. Garmin first because it populates more fields
# (weekly_avg, last_night_5min_high, feedback_phrase) than the COROS adapter
# can extract from /dashboard/query. Falls through alphabetically for unknown
# providers so adding a third source (Apple, Fitbit, ...) is non-breaking.
# Wrap this string as an inner subquery, e.g.:
#   SELECT date, last_night_avg FROM ({HRV_PREFERRED_PER_DATE_SQL}) ORDER BY date DESC
HRV_PREFERRED_PER_DATE_SQL = """
    SELECT * FROM daily_hrv WHERE rowid IN (
        SELECT rowid FROM daily_hrv h1
        WHERE provider = (
            SELECT provider FROM daily_hrv h2
            WHERE h2.date = h1.date
            ORDER BY CASE provider
                WHEN 'garmin' THEN 1
                WHEN 'coros' THEN 2
                ELSE 3
            END, provider
            LIMIT 1
        )
    )
"""


_THUMB_TARGET_POINTS = 60
_THUMB_VIEWBOX = 100
_THUMB_PADDING = 5
_THUMB_MIN_GPS_SAMPLES = 10
_THUMB_REPEATED_ROUTE_MIN_PATH_M = 1_200
_THUMB_REPEATED_ROUTE_MAX_BBOX_M = 600
_THUMB_REPEATED_ROUTE_MIN_BBOX_M = 20
_THUMB_REPEATED_ROUTE_PATH_TO_PERIMETER = 3.0
_THUMB_REPEATED_ROUTE_MIN_ANGLE_COVERAGE = 0.75
_THUMB_REPEATED_ROUTE_MAX_CENTER_DENSITY = 0.08


def _distance(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot(b[0] - a[0], b[1] - a[1])


def _polyline_length(points: list[tuple[float, float]]) -> float:
    return sum(_distance(a, b) for a, b in zip(points, points[1:]))


def _project_gps_to_local_meters(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Project ``(lon, lat)`` degrees to approximate local meter offsets."""
    mean_lat_rad = math.radians(sum(lat for _, lat in points) / len(points))
    meters_per_lon = 111_000 * math.cos(mean_lat_rad)
    meters_per_lat = 111_000
    origin_lon, origin_lat = points[0]
    return [
        ((lon - origin_lon) * meters_per_lon, (lat - origin_lat) * meters_per_lat)
        for lon, lat in points
    ]


def _is_repeated_compact_route(points: list[tuple[float, float]]) -> bool:
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    width = max(xs) - min(xs)
    height = max(ys) - min(ys)
    if width <= 0 or height <= 0:
        return False
    if max(width, height) > _THUMB_REPEATED_ROUTE_MAX_BBOX_M:
        return False
    if min(width, height) < _THUMB_REPEATED_ROUTE_MIN_BBOX_M:
        return False

    cx = (min(xs) + max(xs)) / 2
    cy = (min(ys) + max(ys)) / 2
    angle_bins = 24
    occupied_angles = set()
    for x, y in points:
        angle = (math.atan2(y - cy, x - cx) + 2 * math.pi) % (2 * math.pi)
        occupied_angles.add(min(int(angle / (2 * math.pi) * angle_bins), angle_bins - 1))
    angle_coverage = len(occupied_angles) / angle_bins
    if angle_coverage < _THUMB_REPEATED_ROUTE_MIN_ANGLE_COVERAGE:
        return False

    half_width = width / 2
    half_height = height / 2
    center_count = sum(
        math.hypot((x - cx) / half_width, (y - cy) / half_height) < 0.6
        for x, y in points
    )
    if center_count / len(points) > _THUMB_REPEATED_ROUTE_MAX_CENTER_DENSITY:
        return False

    path_length = _polyline_length(points)
    bbox_perimeter = 2 * (width + height)
    return (
        path_length >= _THUMB_REPEATED_ROUTE_MIN_PATH_M
        and path_length / bbox_perimeter >= _THUMB_REPEATED_ROUTE_PATH_TO_PERIMETER
    )


def _downsample_by_distance(
    points: list[tuple[float, float]],
    target: int,
) -> list[tuple[float, float]]:
    if len(points) <= target:
        return list(points)

    total = _polyline_length(points)
    if total <= 0:
        return list(points[:target])

    interval = total / (target - 1)
    out = [points[0]]
    next_distance = interval
    walked = 0.0
    prev = points[0]

    for curr in points[1:]:
        segment = _distance(prev, curr)
        while segment > 0 and walked + segment >= next_distance and len(out) < target - 1:
            ratio = (next_distance - walked) / segment
            out.append((
                prev[0] + (curr[0] - prev[0]) * ratio,
                prev[1] + (curr[1] - prev[1]) * ratio,
            ))
            next_distance += interval
        walked += segment
        prev = curr

    if out[-1] != points[-1]:
        out.append(points[-1])
    return out


def _loop_footprint(points: list[tuple[float, float]], target: int) -> list[tuple[float, float]]:
    """Collapse repeated compact loops into one ordered footprint."""
    cx = sum(x for x, _ in points) / len(points)
    cy = sum(y for _, y in points) / len(points)
    bin_count = max(12, target - 1)
    buckets: list[list[tuple[float, float]]] = [[] for _ in range(bin_count)]

    for x, y in points:
        angle = (math.atan2(y - cy, x - cx) + 2 * math.pi) % (2 * math.pi)
        index = min(int(angle / (2 * math.pi) * bin_count), bin_count - 1)
        buckets[index].append((x, y))

    start_x, start_y = points[0]
    start_angle = (math.atan2(start_y - cy, start_x - cx) + 2 * math.pi) % (2 * math.pi)
    start_index = min(int(start_angle / (2 * math.pi) * bin_count), bin_count - 1)
    ordered_buckets = buckets[start_index:] + buckets[:start_index]

    footprint = [
        (sum(x for x, _ in bucket) / len(bucket), sum(y for _, y in bucket) / len(bucket))
        for bucket in ordered_buckets
        if bucket
    ]
    if len(footprint) < 12:
        return _downsample_by_distance(points, target)
    footprint.append(footprint[0])
    return footprint


def _normalize_thumbnail_points(points: list[tuple[float, float]]) -> list[list[float]] | None:
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    range_x = max_x - min_x
    range_y = max_y - min_y
    span = max(range_x, range_y)
    if span <= 0:
        return None

    scale = (_THUMB_VIEWBOX - 2 * _THUMB_PADDING) / span
    cx = (min_x + max_x) / 2
    cy = (min_y + max_y) / 2
    half = _THUMB_VIEWBOX / 2

    out: list[list[float]] = []
    for x, y in points:
        nx = round((x - cx) * scale + half, 1)
        # Flip Y so north lands at the top of the SVG.
        ny = round(half - (y - cy) * scale, 1)
        out.append([nx, ny])
    return out


def compute_route_thumbnail(timeseries: list[TimeseriesPoint] | list[dict]) -> str | None:
    """Build a downsampled, normalized polyline for activity-list thumbnails.

    Returns a JSON string ``[[x,y],...]`` with x/y rounded to one decimal,
    fitting in a ``[0, 100]`` viewport with 5 px padding. GPS is first projected
    into approximate local meters so aspect ratio is preserved. Y axis is
    flipped (south at bottom) so the polyline can drop straight into ``<svg>``
    without further math.

    Compact repeated routes, especially track-mode activities, are collapsed
    into one ordered loop footprint. Uniformly sampling the full time-ordered
    trace aliases multi-lap tracks into long infield chords at thumbnail size.

    Returns ``None`` when fewer than 10 valid GPS samples are present
    (indoor, treadmill, GPS-failed activities).

    Accepts either a list of ``TimeseriesPoint`` dataclasses or a list of
    dict rows with ``gps_lat`` / ``gps_lon`` keys, so the same helper
    works in both the live sync path and the offline backfill script.
    """
    pts: list[tuple[float, float]] = []
    for p in timeseries:
        if isinstance(p, dict):
            lat = p.get("gps_lat")
            lon = p.get("gps_lon")
        else:
            lat = getattr(p, "gps_lat", None)
            lon = getattr(p, "gps_lon", None)
        if lat is None or lon is None:
            continue
        pts.append((lon, lat))

    if len(pts) < _THUMB_MIN_GPS_SAMPLES:
        return None

    projected = _project_gps_to_local_meters(pts)
    if _is_repeated_compact_route(projected):
        sampled = _loop_footprint(projected, _THUMB_TARGET_POINTS)
    else:
        sampled = _downsample_by_distance(projected, _THUMB_TARGET_POINTS)

    out = _normalize_thumbnail_points(sampled)
    if out is None:
        return None

    return json.dumps(out, separators=(",", ":"))


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

    def _pre_rename_legacy_tables(self) -> None:
        """Rename legacy brand-named tables before SCHEMA runs.

        SCHEMA contains only the new names (body_composition_*). If the old
        names exist and the new names don't, rename them first so SCHEMA's
        ``CREATE TABLE IF NOT EXISTS`` is a no-op (table already exists) and
        the existing data is preserved in place.
        """
        try:
            existing = {
                r[0] for r in self._conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }
            # Parent before child so SQLite rewrites internal FK reference text.
            for old, new in (
                ("inbody_scan",    "body_composition_scan"),
                ("inbody_segment", "body_composition_segment"),
            ):
                if old in existing and new not in existing:
                    self._conn.execute(f"ALTER TABLE {old} RENAME TO {new}")
            self._conn.commit()
        except sqlite3.OperationalError as e:
            # Tolerate name-collision race only — re-raise anything else.
            if "already exists" not in str(e).lower():
                raise

    def _init_schema(self) -> None:
        self._pre_rename_legacy_tables()
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
        _add("body_composition_segment", "fat_pct_of_standard", "REAL")
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
        # COROS frequencyList per-second running-form channels (added when
        # we discovered the API returns these alongside the already-parsed
        # heart/speed/cadence/altitude/power). Unit-suffixed names mirror
        # the per-activity summary columns above. NULL for Garmin rows
        # (Garmin running dynamics live elsewhere) and for older COROS
        # rows synced before this column existed.
        _add("timeseries", "ground_contact_time_ms", "REAL")
        _add("timeseries", "vertical_oscillation_mm", "REAL")
        _add("timeseries", "vertical_ratio_pct", "REAL")
        _add("timeseries", "cadence_length_cm", "REAL")
        _add("timeseries", "slope", "INTEGER")
        _add("timeseries", "heart_level", "INTEGER")
        # WGS84 GPS lat/lng (decimal degrees), parsed from frequencyList.
        # See `project_coros_gps_coordinate_system` memory for verification.
        _add("timeseries", "gps_lat", "REAL")
        _add("timeseries", "gps_lon", "REAL")
        # Pause intervals as JSON list of {start_ts, end_ts, type} objects.
        # Frontend cuts the route polyline at these boundaries (decision A,
        # gap-style). NULL on legacy rows / activities with no pauses.
        _add("activities", "pauses", "TEXT")
        # Pre-computed downsampled + normalized route polyline for activity
        # list thumbnails. JSON: '[[x,y],...]' with x/y in [0,100] (SVG
        # viewport-ready). NULL for indoor/strength/no-GPS activities.
        # Sized for ~60 points × ~10 B/pt = ~600 B per row.
        _add("activities", "route_thumb_json", "TEXT")
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

        def _rename(old: str, new: str) -> None:
            """Rename table if old exists and new doesn't. Idempotent."""
            try:
                existing = {
                    r[0] for r in self._conn.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'"
                    ).fetchall()
                }
                if old in existing and new not in existing:
                    self._conn.execute(f"ALTER TABLE {old} RENAME TO {new}")
            except sqlite3.OperationalError as e:
                # Tolerate name-collision race only — re-raise anything else.
                if "already exists" not in str(e).lower():
                    raise

        # Parent before child so SQLite rewrites FK reference text.
        _rename("inbody_scan",    "body_composition_scan")
        _rename("inbody_segment", "body_composition_segment")
        self._conn.commit()

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
            "CREATE TABLE IF NOT EXISTS activity_training_load ("
            "    label_id TEXT PRIMARY KEY REFERENCES activities(label_id),"
            "    activity_date TEXT NOT NULL,"
            "    sport TEXT,"
            "    session_class TEXT,"
            "    algorithm_version INTEGER NOT NULL,"
            "    calibration_id INTEGER REFERENCES running_calibration_snapshot(id),"
            "    cardio_load_raw REAL,"
            "    cardio_tss REAL,"
            "    external_tss REAL,"
            "    mechanical_load REAL,"
            "    subjective_internal_load REAL,"
            "    training_dose REAL,"
            "    load_confidence TEXT,"
            "    excluded_from_pmc INTEGER NOT NULL DEFAULT 1,"
            "    reasons_json TEXT,"
            "    computed_at TEXT NOT NULL DEFAULT (datetime('now'))"
            ")",
            "CREATE INDEX IF NOT EXISTS idx_activity_training_load_date "
            "ON activity_training_load(activity_date)",
            "CREATE TABLE IF NOT EXISTS daily_training_load ("
            "    date TEXT NOT NULL,"
            "    algorithm_version INTEGER NOT NULL,"
            "    calibration_id INTEGER REFERENCES running_calibration_snapshot(id),"
            "    training_dose REAL NOT NULL DEFAULT 0,"
            "    acute_load REAL,"
            "    chronic_load REAL,"
            "    form REAL,"
            "    load_ratio REAL,"
            "    readiness_gate TEXT,"
            "    readiness_reasons_json TEXT,"
            "    computed_at TEXT NOT NULL DEFAULT (datetime('now')),"
            "    PRIMARY KEY(date, algorithm_version)"
            ")",
        ):
            self._conn.execute(stmt)

        # Migrate planned_session UNIQUE constraint from (date, session_index) to
        # (week_folder, date, session_index). Required because the narrower
        # constraint blocks legitimate cross-week reparse when stale rows from a
        # previous failed parse occupy the same (date, session_index).
        # Idempotent: only rebuilds when the old constraint is detected.
        sql_row = self._conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='planned_session'"
        ).fetchone()
        if sql_row is not None:
            table_sql = sql_row[0] or ""
            needs_rebuild = (
                "UNIQUE(date, session_index)" in table_sql
                and "UNIQUE(week_folder, date, session_index)" not in table_sql
            )
            if needs_rebuild:
                # SQLite cannot ALTER UNIQUE constraints; rebuild the table.
                # Dedupe by keeping the latest row (MAX(id)) per
                # (week_folder, date, session_index) tuple to survive prod's
                # half-applied state from earlier crashed reparses.
                self._conn.executescript("""
                    CREATE TABLE planned_session_new (
                        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
                        week_folder           TEXT NOT NULL,
                        date                  TEXT NOT NULL,
                        session_index         INTEGER NOT NULL DEFAULT 0,
                        kind                  TEXT NOT NULL,
                        summary               TEXT NOT NULL,
                        spec_json             TEXT,
                        notes_md              TEXT,
                        total_distance_m      REAL,
                        total_duration_s      REAL,
                        scheduled_workout_id  INTEGER REFERENCES scheduled_workout(id),
                        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
                        updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
                        UNIQUE(week_folder, date, session_index)
                    );
                    INSERT INTO planned_session_new
                    SELECT * FROM planned_session
                    WHERE id IN (
                        SELECT MAX(id) FROM planned_session
                        GROUP BY week_folder, date, session_index
                    );
                    DROP TABLE planned_session;
                    ALTER TABLE planned_session_new RENAME TO planned_session;
                    CREATE INDEX IF NOT EXISTS idx_planned_session_week ON planned_session(week_folder);
                    CREATE INDEX IF NOT EXISTS idx_planned_session_date ON planned_session(date);
                """)
                self._conn.commit()

        # Migrate planned_nutrition PRIMARY KEY from (date) to (week_folder, date).
        # Same root cause + fix as the planned_session migration above: the
        # narrower constraint blocks legitimate cross-week reparse when stale
        # rows from a previous failed parse occupy the same date.
        nutrition_sql_row = self._conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='planned_nutrition'"
        ).fetchone()
        if nutrition_sql_row is not None:
            nutrition_table_sql = nutrition_sql_row[0] or ""
            needs_nutrition_rebuild = (
                "date            TEXT PRIMARY KEY" in nutrition_table_sql
                or ("PRIMARY KEY" in nutrition_table_sql
                    and "PRIMARY KEY (week_folder, date)" not in nutrition_table_sql)
            )
            if needs_nutrition_rebuild:
                self._conn.executescript("""
                    CREATE TABLE planned_nutrition_new (
                        week_folder     TEXT NOT NULL,
                        date            TEXT NOT NULL,
                        kcal_target     REAL,
                        carbs_g         REAL,
                        protein_g       REAL,
                        fat_g           REAL,
                        water_ml        REAL,
                        meals_json      TEXT,
                        notes_md        TEXT,
                        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                        updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
                        PRIMARY KEY (week_folder, date)
                    );
                    -- Dedup by keeping the row with the latest updated_at per
                    -- (week_folder, date) tuple. ``rowid`` tiebreak so the
                    -- migration is deterministic.
                    INSERT INTO planned_nutrition_new
                    SELECT week_folder, date, kcal_target, carbs_g, protein_g, fat_g,
                           water_ml, meals_json, notes_md, created_at, updated_at
                    FROM planned_nutrition
                    WHERE rowid IN (
                        SELECT MAX(rowid) FROM planned_nutrition
                        GROUP BY week_folder, date
                    );
                    DROP TABLE planned_nutrition;
                    ALTER TABLE planned_nutrition_new RENAME TO planned_nutrition;
                    CREATE INDEX IF NOT EXISTS idx_planned_nutrition_week ON planned_nutrition(week_folder);
                """)
                self._conn.commit()

        # Thresholds moved to running_calibration_snapshot; drop the legacy table.
        if self._conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='training_load_calibration'"
        ).fetchone():
            self._conn.execute("DROP TABLE training_load_calibration")
            self._conn.commit()

        # Migrate daily_hrv PRIMARY KEY from (date) to (date, provider). The
        # original single-column PK silently let a COROS upsert overwrite a
        # Garmin row for the same date (or vice versa), losing data for any
        # dual-watch user. Composite PK isolates by provider; readers dedupe
        # with a Garmin-first priority because Garmin populates more fields.
        hrv_sql_row = self._conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='daily_hrv'"
        ).fetchone()
        if hrv_sql_row is not None:
            hrv_table_sql = hrv_sql_row[0] or ""
            needs_hrv_rebuild = (
                "date                       TEXT PRIMARY KEY" in hrv_table_sql
                or "date TEXT PRIMARY KEY" in hrv_table_sql
                or ("PRIMARY KEY" in hrv_table_sql
                    and "PRIMARY KEY (date, provider)" not in hrv_table_sql)
            )
            if needs_hrv_rebuild:
                self._conn.executescript("""
                    CREATE TABLE daily_hrv_new (
                        date                       TEXT NOT NULL,
                        weekly_avg                 INTEGER,
                        last_night_avg             INTEGER,
                        last_night_5min_high       INTEGER,
                        status                     TEXT,
                        baseline_low_upper         INTEGER,
                        baseline_balanced_low      INTEGER,
                        baseline_balanced_upper    INTEGER,
                        feedback_phrase            TEXT,
                        provider                   TEXT NOT NULL DEFAULT 'coros',
                        PRIMARY KEY (date, provider)
                    );
                    -- Preserve every existing row. Pre-migration the PK was
                    -- (date) alone, so there's at most one row per date; no
                    -- dedup needed here.
                    INSERT INTO daily_hrv_new
                    SELECT date, weekly_avg, last_night_avg, last_night_5min_high,
                           status, baseline_low_upper, baseline_balanced_low,
                           baseline_balanced_upper, feedback_phrase, provider
                    FROM daily_hrv;
                    DROP TABLE daily_hrv;
                    ALTER TABLE daily_hrv_new RENAME TO daily_hrv;
                """)
                self._conn.commit()

        # Rebuild vo2max_pb from v1 (race_type PRIMARY KEY) to v2 (autoinc id
        # + UNIQUE(race_type, label_id)) so we can keep a row per source
        # activity instead of clobbering on race_type.
        self._migrate_vo2max_pb_to_v2()

    def _migrate_vo2max_pb_to_v2(self) -> None:
        """Migrate ``vo2max_pb`` from v1 (race_type PRIMARY KEY) to v2
        (autoinc ``id`` + UNIQUE(race_type, label_id) + index on vdot DESC).

        Idempotent: detects v2 via presence of the ``id`` column.
        Atomic: full table rebuild inside a single transaction.
        """
        cols = [r[1] for r in self._conn.execute("PRAGMA table_info(vo2max_pb)")]
        if not cols:
            return  # table doesn't exist yet; the SCHEMA CREATE will produce v2
        if "id" in cols:
            return  # already v2

        with self._conn:
            self._conn.execute(
                """CREATE TABLE vo2max_pb_new (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    race_type    TEXT NOT NULL,
                    distance_m   REAL NOT NULL,
                    duration_s   REAL NOT NULL,
                    vdot         REAL NOT NULL,
                    pb_date      TEXT NOT NULL,
                    label_id     TEXT NOT NULL,
                    even_paced   INTEGER NOT NULL DEFAULT 1,
                    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
                    UNIQUE(race_type, label_id)
                )"""
            )
            self._conn.execute(
                """INSERT INTO vo2max_pb_new
                   (race_type, distance_m, duration_s, vdot, pb_date,
                    label_id, even_paced, updated_at)
                   SELECT race_type, distance_m, duration_s, vdot, pb_date,
                          label_id, even_paced, updated_at
                   FROM vo2max_pb"""
            )
            self._conn.execute("DROP TABLE vo2max_pb")
            self._conn.execute("ALTER TABLE vo2max_pb_new RENAME TO vo2max_pb")
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_vo2max_pb_vdot "
                "ON vo2max_pb(race_type, vdot DESC)"
            )

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> Database:
        return self

    def __exit__(self, *args) -> None:
        self.close()

    # --- Activities ---

    def upsert_activity(self, a: ActivityDetail, *, provider: str = "coros") -> None:
        # JSON-encode pauses as `[{"start_ts":..., "end_ts":..., "type":...}]`.
        # Empty/None → NULL so the column stays sparse for the common case.
        pauses_json = (
            json.dumps(
                [{"start_ts": p.start_ts, "end_ts": p.end_ts, "type": p.type} for p in a.pauses],
                separators=(",", ":"),
            )
            if a.pauses else None
        )
        # Pre-compute the activity-list thumbnail polyline so reads of the
        # list API stay one-table. NULL when no GPS (indoor/strength).
        route_thumb_json = compute_route_thumbnail(a.timeseries)
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
             pauses, route_thumb_json, provider)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
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
             pauses_json, route_thumb_json, provider),
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
            (label_id, timestamp, distance, heart_rate, speed, adjusted_pace, cadence, altitude, power,
             ground_contact_time_ms, vertical_oscillation_mm, vertical_ratio_pct,
             cadence_length_cm, slope, heart_level, gps_lat, gps_lon)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            [(label_id, p.timestamp, p.distance, p.heart_rate, p.speed,
              p.adjusted_pace, p.cadence, p.altitude, p.power,
              p.ground_contact_time_ms, p.vertical_oscillation_mm, p.vertical_ratio_pct,
              p.cadence_length_cm, p.slope, p.heart_level, p.gps_lat, p.gps_lon) for p in points],
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

    # --- Activity feedback (structured RPE + mood_tags, written by mobile app) ---

    def upsert_activity_feedback(
        self,
        label_id: str,
        rpe: int | None,
        mood_tags: list[str] | None,
        note: str | None,
    ) -> None:
        import json as _json
        tags_json = _json.dumps(mood_tags, ensure_ascii=False) if mood_tags is not None else None
        self._conn.execute(
            """INSERT INTO activity_feedback (label_id, rpe, mood_tags, note, updated_at)
               VALUES (?, ?, ?, ?, datetime('now'))
               ON CONFLICT(label_id) DO UPDATE SET
                   rpe        = excluded.rpe,
                   mood_tags  = excluded.mood_tags,
                   note       = excluded.note,
                   updated_at = excluded.updated_at""",
            (label_id, rpe, tags_json, note),
        )
        self._conn.commit()

    def get_activity_feedback(self, label_id: str) -> sqlite3.Row | None:
        return self._conn.execute(
            "SELECT label_id, rpe, mood_tags, note, created_at, updated_at "
            "FROM activity_feedback WHERE label_id = ?",
            (label_id,),
        ).fetchone()

    # --- Objective training load (STRIDE-computed, TSS-like scale) ---

    def commit(self) -> None:
        """Flush pending writes on the underlying sqlite3 connection."""
        self._conn.commit()

    def upsert_activity_training_load(self, result, *, commit: bool = True) -> None:
        reasons_json = json.dumps(result.reasons or [], ensure_ascii=False)
        self._conn.execute(
            """INSERT INTO activity_training_load
               (label_id, activity_date, sport, session_class, algorithm_version,
                calibration_id, cardio_load_raw, cardio_tss, external_tss,
                mechanical_load, subjective_internal_load, training_dose,
                load_confidence, excluded_from_pmc, reasons_json, computed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
               ON CONFLICT(label_id) DO UPDATE SET
                   activity_date = excluded.activity_date,
                   sport = excluded.sport,
                   session_class = excluded.session_class,
                   algorithm_version = excluded.algorithm_version,
                   calibration_id = excluded.calibration_id,
                   cardio_load_raw = excluded.cardio_load_raw,
                   cardio_tss = excluded.cardio_tss,
                   external_tss = excluded.external_tss,
                   mechanical_load = excluded.mechanical_load,
                   subjective_internal_load = excluded.subjective_internal_load,
                   training_dose = excluded.training_dose,
                   load_confidence = excluded.load_confidence,
                   excluded_from_pmc = excluded.excluded_from_pmc,
                   reasons_json = excluded.reasons_json,
                   computed_at = excluded.computed_at""",
            (
                result.label_id,
                result.activity_date.isoformat(),
                result.sport,
                result.session_class.value,
                result.algorithm_version,
                result.calibration_id,
                result.cardio_load_raw,
                result.cardio_tss,
                result.external_tss,
                result.mechanical_load,
                result.subjective_internal_load,
                result.training_dose,
                result.load_confidence.value,
                1 if result.excluded_from_pmc else 0,
                reasons_json,
            ),
        )
        if commit:
            self._conn.commit()

    def upsert_daily_training_load(self, result, *, commit: bool = True) -> None:
        reasons_json = json.dumps(result.readiness_reasons or [], ensure_ascii=False)
        self._conn.execute(
            """INSERT INTO daily_training_load
               (date, algorithm_version, calibration_id, training_dose, acute_load,
                chronic_load, form, load_ratio, readiness_gate,
                readiness_reasons_json, computed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
               ON CONFLICT(date, algorithm_version) DO UPDATE SET
                   calibration_id = excluded.calibration_id,
                   training_dose = excluded.training_dose,
                   acute_load = excluded.acute_load,
                   chronic_load = excluded.chronic_load,
                   form = excluded.form,
                   load_ratio = excluded.load_ratio,
                   readiness_gate = excluded.readiness_gate,
                   readiness_reasons_json = excluded.readiness_reasons_json,
                   computed_at = excluded.computed_at""",
            (
                result.date.isoformat(),
                result.algorithm_version,
                result.calibration_id,
                result.training_dose,
                result.acute_load,
                result.chronic_load,
                result.form,
                result.load_ratio,
                result.readiness_gate,
                reasons_json,
            ),
        )
        if commit:
            self._conn.commit()

    def fetch_activity_training_load(self, label_id: str) -> sqlite3.Row | None:
        return self._conn.execute(
            "SELECT * FROM activity_training_load WHERE label_id = ?",
            (label_id,),
        ).fetchone()

    def fetch_daily_training_load(
        self, start: str | None = None, end: str | None = None,
    ) -> list[sqlite3.Row]:
        clauses: list[str] = []
        params: list[str] = []
        if start is not None:
            clauses.append("date >= ?")
            params.append(start)
        if end is not None:
            clauses.append("date <= ?")
            params.append(end)
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        return self._conn.execute(
            "SELECT * FROM daily_training_load" + where + " ORDER BY date",
            tuple(params),
        ).fetchall()

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

    # --- Body-composition scans ---

    def upsert_body_composition_scan(self, scan: BodyCompositionScan) -> None:
        self._conn.execute(
            """INSERT OR REPLACE INTO body_composition_scan
            (scan_date, jpg_path, weight_kg, body_fat_pct, smm_kg, fat_mass_kg,
             visceral_fat_level, bmr_kcal, protein_kg, water_l, smi, inbody_score,
             ingested_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))""",
            (scan.scan_date, scan.jpg_path, scan.weight_kg, scan.body_fat_pct,
             scan.smm_kg, scan.fat_mass_kg, scan.visceral_fat_level,
             scan.bmr_kcal, scan.protein_kg, scan.water_l, scan.smi, scan.inbody_score),
        )
        # Replace segments only when the caller actually provided them.
        # An upsert from a main-metrics-only edit (e.g. the web form) sends
        # an empty list; preserving the existing breakdown avoids a silent
        # destructive update.
        if scan.segments:
            self._conn.execute("DELETE FROM body_composition_segment WHERE scan_date = ?", (scan.scan_date,))
            for seg in scan.segments:
                self._conn.execute(
                    """INSERT INTO body_composition_segment
                    (scan_date, segment, lean_mass_kg, fat_mass_kg, lean_pct_of_standard, fat_pct_of_standard)
                    VALUES (?,?,?,?,?,?)""",
                    (scan.scan_date, seg.segment, seg.lean_mass_kg, seg.fat_mass_kg,
                     seg.lean_pct_of_standard, seg.fat_pct_of_standard),
                )
        self._conn.commit()

    def list_body_composition_scans(self, days: int | None = None) -> list[sqlite3.Row]:
        if days is not None:
            return self._conn.execute(
                "SELECT * FROM body_composition_scan WHERE scan_date >= date('now', ?) "
                "ORDER BY scan_date DESC",
                (f"-{days} days",),
            ).fetchall()
        return self._conn.execute(
            "SELECT * FROM body_composition_scan ORDER BY scan_date DESC"
        ).fetchall()

    def get_body_composition_scan(self, scan_date: str) -> sqlite3.Row | None:
        return self._conn.execute(
            "SELECT * FROM body_composition_scan WHERE scan_date = ?", (scan_date,)
        ).fetchone()

    def get_body_composition_segments(self, scan_date: str) -> list[sqlite3.Row]:
        return self._conn.execute(
            "SELECT * FROM body_composition_segment WHERE scan_date = ? ORDER BY segment",
            (scan_date,),
        ).fetchall()

    def latest_body_composition_scan(self) -> sqlite3.Row | None:
        return self._conn.execute(
            "SELECT * FROM body_composition_scan ORDER BY scan_date DESC LIMIT 1"
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

    # --- VO2max PB channel (v7) ---

    def upsert_vo2max_pb(
        self,
        *,
        race_type: str,
        distance_m: float,
        duration_s: float,
        vdot: float,
        pb_date: str,
        label_id: str,
        even_paced: bool = True,
    ) -> bool:
        """Insert or update a per-activity PB row.

        Keyed on (race_type, label_id) — multiple activities yield multiple
        rows per race_type, forming PB history. On conflict, updates only if
        the incoming vdot strictly exceeds the stored value (e.g., algorithm
        recomputed and got higher), otherwise no-ops. Returns True iff a row
        was inserted or updated.
        """
        cursor = self._conn.execute(
            """INSERT INTO vo2max_pb
               (race_type, distance_m, duration_s, vdot, pb_date, label_id,
                even_paced, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
               ON CONFLICT(race_type, label_id) DO UPDATE SET
                 distance_m = excluded.distance_m,
                 duration_s = excluded.duration_s,
                 vdot = excluded.vdot,
                 pb_date = excluded.pb_date,
                 even_paced = excluded.even_paced,
                 updated_at = datetime('now')
               WHERE excluded.vdot > vo2max_pb.vdot""",
            (
                race_type, float(distance_m), float(duration_s), float(vdot),
                pb_date, label_id, 1 if even_paced else 0,
            ),
        )
        self._conn.commit()
        return cursor.rowcount > 0

    def fetch_vo2max_pbs(self) -> list[sqlite3.Row]:
        return self._conn.execute(
            """SELECT race_type, distance_m, duration_s, vdot, pb_date,
                      label_id, even_paced, updated_at
               FROM vo2max_pb ORDER BY race_type"""
        ).fetchall()

    def delete_vo2max_pbs(self) -> None:
        """Test/backfill helper — wipe the PB table."""
        self._conn.execute("DELETE FROM vo2max_pb")
        self._conn.commit()

    def fetch_timeseries(self, label_id: str) -> list[sqlite3.Row]:
        """Read (timestamp, distance) rows for one activity, ordered by
        timestamp ASC, skipping NULL distance rows. Returns [] for unknown
        label_id or activity with no timeseries.

        Units are NOT normalized here — see
        `stride_core.pb_records.normalize_timeseries_units` for the PB segment
        scanner's provider-tolerant conversion.
        """
        return list(self._conn.execute(
            "SELECT timestamp, distance FROM timeseries "
            "WHERE label_id = ? AND distance IS NOT NULL "
            "ORDER BY timestamp ASC",
            (str(label_id),),
        ))

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
        # Cross-week cleanup: delete any rows in this week's date range,
        # regardless of week_folder. This handles orphans from earlier
        # reparse runs that used a different week_folder spelling.
        # Falls back to week_folder match if folder name doesn't parse.
        date_range = _parse_week_folder_dates(week_folder)
        if date_range is not None:
            start, end = date_range
            cur = c.execute(
                "DELETE FROM planned_session WHERE date BETWEEN ? AND ?",
                (start, end),
            )
        else:
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
        # Cross-week cleanup: delete any rows in this week's date range,
        # regardless of week_folder. This handles orphans from earlier
        # reparse runs that used a different week_folder spelling.
        # Falls back to week_folder match if folder name doesn't parse.
        date_range = _parse_week_folder_dates(week_folder)
        if date_range is not None:
            start, end = date_range
            c.execute(
                "DELETE FROM planned_nutrition WHERE date BETWEEN ? AND ?",
                (start, end),
            )
        else:
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
        # plan_parser.persistence imports stride_core.db.Database.
        from plan_parser import apply_weekly_plan
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
