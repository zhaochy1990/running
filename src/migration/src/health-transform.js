// health-transform.js — pure, dependency-free mapping from a user's local
// coros.db SQLite rows to the health-domain MySQL rows read by the Go worker.
//
// Everything here is deterministic and side-effect free so it can be unit-tested
// without touching SQLite or MySQL (see test/health-transform.test.js). The
// output is designed to match the Go worker's GORM models so a migrated row is
// indistinguishable from one the Go sync would write/read
// (src/go/internal/storage/watch_models.go):
//   - daily_health     (DailyHealth)     PK (user_id, date)
//   - daily_hrv        (DailyHRV)        PK (user_id, date, provider)
//   - dashboard        (Dashboard)       PK (user_id)          — SQLite singleton id=1
//   - race_predictions (RacePrediction)  PK (user_id, race_type)
//
// Column shapes are 1:1 with the SQLite source except:
//   - a `user_id` (the app UUID) is injected as the tenant key;
//   - the SQLite `dashboard.id` (always 1) and `race_predictions.id` (autoinc)
//     surrogate keys are dropped;
//   - `dashboard`/`race_predictions` `updated_at` is stamped with the shared run
//     time (a wall-clock write time, not synced data — the Go worker overwrites
//     it on its next sync, and reconcile excludes it), NOT the SQLite value.
//
// Dates pass through verbatim so they stay byte-comparable with what the Go sync
// writes: daily_health.date is `YYYYMMDD` (Shanghai calendar day) and
// daily_hrv.date is ISO `YYYY-MM-DD` — exactly the two formats the Go worker
// already stores, so an upsert updates the same PK instead of duplicating it.

/** Raised for a per-record problem; the CLI records it and keeps going. */
export class HealthTransformError extends Error {}

// Target column order for each table. The MySQL upsert binds a row's values in
// this exact order, and it is the authoritative list the transforms populate.
// Byte-for-byte the Go models' columns (watch_models.go).
export const DAILY_HEALTH_COLUMNS = [
  "user_id",
  "date",
  "ati",
  "cti",
  "rhr",
  "distance_m",
  "duration_s",
  "training_load_ratio",
  "training_load_state",
  "fatigue",
  "body_battery_high",
  "body_battery_low",
  "stress_avg",
  "sleep_total_s",
  "sleep_deep_s",
  "sleep_light_s",
  "sleep_rem_s",
  "sleep_awake_s",
  "sleep_score",
  "respiration_avg",
  "spo2_avg",
  "provider",
];

export const DAILY_HRV_COLUMNS = [
  "user_id",
  "date",
  "provider",
  "weekly_avg",
  "last_night_avg",
  "last_night_5min_high",
  "status",
  "baseline_low_upper",
  "baseline_balanced_low",
  "baseline_balanced_upper",
  "feedback_phrase",
];

export const DASHBOARD_COLUMNS = [
  "user_id",
  "running_level",
  "aerobic_score",
  "lactate_threshold_score",
  "anaerobic_endurance_score",
  "anaerobic_capacity_score",
  "rhr",
  "threshold_hr",
  "threshold_pace_s_km",
  "recovery_pct",
  "avg_sleep_hrv",
  "hrv_normal_low",
  "hrv_normal_high",
  "weekly_distance_m",
  "weekly_duration_s",
  "provider",
  "updated_at",
];

export const RACE_PREDICTIONS_COLUMNS = [
  "user_id",
  "race_type",
  "duration_s",
  "avg_pace",
  "updated_at",
];

/**
 * Build a `daily_health` row from one SQLite daily_health row.
 * @param {string} userId canonical app UUID
 * @param {object} src SQLite row (keys == source columns)
 */
export function dailyHealthRow(userId, src) {
  const date = requireKey(src, "date", "daily_health");
  return {
    user_id: userId,
    date,
    ati: numOrNull(src.ati),
    cti: numOrNull(src.cti),
    rhr: intOrNull(src.rhr),
    distance_m: numOrNull(src.distance_m),
    duration_s: numOrNull(src.duration_s),
    training_load_ratio: numOrNull(src.training_load_ratio),
    training_load_state: strOrNull(src.training_load_state),
    fatigue: numOrNull(src.fatigue),
    body_battery_high: intOrNull(src.body_battery_high),
    body_battery_low: intOrNull(src.body_battery_low),
    stress_avg: intOrNull(src.stress_avg),
    sleep_total_s: intOrNull(src.sleep_total_s),
    sleep_deep_s: intOrNull(src.sleep_deep_s),
    sleep_light_s: intOrNull(src.sleep_light_s),
    sleep_rem_s: intOrNull(src.sleep_rem_s),
    sleep_awake_s: intOrNull(src.sleep_awake_s),
    sleep_score: intOrNull(src.sleep_score),
    respiration_avg: numOrNull(src.respiration_avg),
    spo2_avg: numOrNull(src.spo2_avg),
    provider: providerOrDefault(src.provider),
  };
}

/**
 * Build a `daily_hrv` row from one SQLite daily_hrv row.
 * @param {string} userId canonical app UUID
 * @param {object} src SQLite row
 */
export function dailyHrvRow(userId, src) {
  const date = requireKey(src, "date", "daily_hrv");
  return {
    user_id: userId,
    date,
    provider: providerOrDefault(src.provider),
    weekly_avg: intOrNull(src.weekly_avg),
    last_night_avg: intOrNull(src.last_night_avg),
    last_night_5min_high: intOrNull(src.last_night_5min_high),
    status: strOrNull(src.status),
    baseline_low_upper: intOrNull(src.baseline_low_upper),
    baseline_balanced_low: intOrNull(src.baseline_balanced_low),
    baseline_balanced_upper: intOrNull(src.baseline_balanced_upper),
    feedback_phrase: strOrNull(src.feedback_phrase),
  };
}

/**
 * Build a `dashboard` row from the SQLite singleton dashboard row (id=1). The
 * surrogate `id` is dropped and `updated_at` is the shared run time.
 * @param {string} userId canonical app UUID
 * @param {object} src SQLite row
 * @param {string} now MySQL datetime(6) UTC string for updated_at
 */
export function dashboardRow(userId, src, now) {
  return {
    user_id: userId,
    running_level: numOrNull(src.running_level),
    aerobic_score: numOrNull(src.aerobic_score),
    lactate_threshold_score: numOrNull(src.lactate_threshold_score),
    anaerobic_endurance_score: numOrNull(src.anaerobic_endurance_score),
    anaerobic_capacity_score: numOrNull(src.anaerobic_capacity_score),
    rhr: intOrNull(src.rhr),
    threshold_hr: intOrNull(src.threshold_hr),
    threshold_pace_s_km: numOrNull(src.threshold_pace_s_km),
    recovery_pct: numOrNull(src.recovery_pct),
    avg_sleep_hrv: numOrNull(src.avg_sleep_hrv),
    hrv_normal_low: numOrNull(src.hrv_normal_low),
    hrv_normal_high: numOrNull(src.hrv_normal_high),
    weekly_distance_m: numOrNull(src.weekly_distance_m),
    weekly_duration_s: numOrNull(src.weekly_duration_s),
    provider: providerOrDefault(src.provider),
    updated_at: now,
  };
}

/**
 * Build a `race_predictions` row from one SQLite race_predictions row. The
 * surrogate `id` is dropped and `updated_at` is the shared run time.
 * @param {string} userId canonical app UUID
 * @param {object} src SQLite row
 * @param {string} now MySQL datetime(6) UTC string for updated_at
 */
export function racePredictionRow(userId, src, now) {
  const raceType = requireKey(src, "race_type", "race_predictions");
  return {
    user_id: userId,
    race_type: String(raceType),
    duration_s: numOrNull(src.duration_s),
    avg_pace: numOrNull(src.avg_pace),
    updated_at: now,
  };
}

// The per-table (transform, target columns) registry the CLI iterates. `now`
// is threaded through so dashboard/race_predictions can stamp updated_at.
export const HEALTH_TABLES = ["daily_health", "daily_hrv", "dashboard", "race_predictions"];

export function transformRow(table, userId, src, now) {
  switch (table) {
    case "daily_health":
      return dailyHealthRow(userId, src);
    case "daily_hrv":
      return dailyHrvRow(userId, src);
    case "dashboard":
      return dashboardRow(userId, src, now);
    case "race_predictions":
      return racePredictionRow(userId, src, now);
    default:
      throw new HealthTransformError(`unknown health table: ${table}`);
  }
}

// ── coercers ─────────────────────────────────────────────────────────────────

/** SQL NULL/absent -> null; else the integer value (BigInt-safe, truncated). */
function intOrNull(v) {
  if (v == null) return null;
  if (typeof v === "bigint") return Number(v);
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** SQL NULL/absent -> null; else the numeric value. */
function numOrNull(v) {
  if (v == null) return null;
  if (typeof v === "bigint") return Number(v);
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** SQL NULL/absent -> null; else the string value. */
function strOrNull(v) {
  if (v == null) return null;
  return typeof v === "string" ? v : String(v);
}

/** A blank/absent provider defaults to "coros" (the SQLite column default). */
function providerOrDefault(v) {
  const s = v == null ? "" : String(v).trim();
  return s === "" ? "coros" : s;
}

/** Return src[key] as a non-empty value or throw (a NOT NULL primary-key part). */
function requireKey(src, key, table) {
  const v = src?.[key];
  if (v == null || String(v).trim() === "") {
    throw new HealthTransformError(`${table} row missing ${key}`);
  }
  return typeof v === "string" ? v : String(v);
}
