import assert from "node:assert/strict";
import test from "node:test";

import {
  DAILY_HEALTH_COLUMNS,
  DAILY_HRV_COLUMNS,
  DASHBOARD_COLUMNS,
  RACE_PREDICTIONS_COLUMNS,
  dailyHealthRow,
  dailyHrvRow,
  dashboardRow,
  HealthTransformError,
  racePredictionRow,
  transformRow,
} from "../src/health-transform.js";

const UUID = "f10bc353-01ab-4db1-af9f-d9305ea9a532";
const NOW = "2026-08-03 04:45:30.000000";

test("dailyHealthRow maps every column 1:1 and injects user_id", () => {
  const row = dailyHealthRow(UUID, {
    date: "20260802",
    ati: 165,
    cti: 160,
    rhr: 52,
    distance_m: 0,
    duration_s: 0,
    training_load_ratio: 1.03,
    training_load_state: "Very High",
    fatigue: 47,
    provider: "coros",
    body_battery_high: null,
    body_battery_low: null,
    stress_avg: null,
    sleep_total_s: null,
    sleep_deep_s: null,
    sleep_light_s: null,
    sleep_rem_s: null,
    sleep_awake_s: null,
    sleep_score: null,
    respiration_avg: null,
    spo2_avg: null,
  });
  assert.equal(row.user_id, UUID);
  assert.equal(row.date, "20260802"); // Shanghai YYYYMMDD preserved verbatim
  assert.equal(row.rhr, 52);
  assert.equal(row.distance_m, 0); // zero preserved, not coerced to null
  assert.equal(row.training_load_state, "Very High");
  assert.equal(row.provider, "coros");
  assert.equal(row.sleep_total_s, null);
  // exactly the target columns, no stray `id`/extras
  assert.deepEqual(Object.keys(row).sort(), [...DAILY_HEALTH_COLUMNS].sort());
});

test("dailyHealthRow keeps Garmin sleep stages when present", () => {
  const row = dailyHealthRow(UUID, {
    date: "20260715",
    sleep_total_s: 18780,
    sleep_deep_s: 3540,
    sleep_light_s: 11580,
    sleep_rem_s: 3660,
    sleep_awake_s: 2220,
    sleep_score: 63,
    provider: "garmin",
  });
  assert.equal(row.sleep_total_s, 18780);
  assert.equal(row.sleep_score, 63);
  assert.equal(row.provider, "garmin");
  assert.equal(row.ati, null); // absent source column -> null
});

test("dailyHealthRow defaults a blank provider to coros", () => {
  assert.equal(dailyHealthRow(UUID, { date: "20260101" }).provider, "coros");
  assert.equal(
    dailyHealthRow(UUID, { date: "20260101", provider: "" }).provider,
    "coros",
  );
});

test("dailyHealthRow throws on a missing date (PK part)", () => {
  assert.throws(() => dailyHealthRow(UUID, { rhr: 50 }), HealthTransformError);
});

test("dailyHrvRow maps columns and carries provider into the PK", () => {
  const row = dailyHrvRow(UUID, {
    date: "2026-08-02",
    provider: "coros",
    weekly_avg: 30,
    last_night_avg: 26,
    last_night_5min_high: 40,
    status: "BALANCED",
    baseline_low_upper: 20,
    baseline_balanced_low: 25,
    baseline_balanced_upper: 33,
    feedback_phrase: null,
  });
  assert.equal(row.user_id, UUID);
  assert.equal(row.date, "2026-08-02"); // ISO preserved verbatim
  assert.equal(row.provider, "coros");
  assert.equal(row.status, "BALANCED");
  assert.equal(row.last_night_avg, 26);
  assert.deepEqual(Object.keys(row).sort(), [...DAILY_HRV_COLUMNS].sort());
});

test("dashboardRow drops the singleton id and stamps updated_at = now", () => {
  const row = dashboardRow(
    UUID,
    {
      id: 1,
      running_level: 91.9,
      aerobic_score: 89.8,
      lactate_threshold_score: 94.8,
      anaerobic_endurance_score: 94.5,
      anaerobic_capacity_score: 93.4,
      rhr: 46,
      threshold_hr: 166,
      threshold_pace_s_km: 236,
      recovery_pct: 71,
      avg_sleep_hrv: 26,
      hrv_normal_low: 25,
      hrv_normal_high: 33,
      weekly_distance_m: null,
      weekly_duration_s: null,
      updated_at: "2026-08-02 14:39:05", // source value is NOT carried over
      provider: "coros",
    },
    NOW,
  );
  assert.equal(row.user_id, UUID);
  assert.equal(row.running_level, 91.9);
  assert.equal(row.threshold_hr, 166);
  assert.equal(row.updated_at, NOW);
  assert.ok(!("id" in row));
  assert.deepEqual(Object.keys(row).sort(), [...DASHBOARD_COLUMNS].sort());
});

test("racePredictionRow drops the surrogate id and preserves race_type verbatim", () => {
  const now = NOW;
  const marathon = racePredictionRow(
    UUID,
    { id: 2, race_type: "Marathon", duration_s: 10749, avg_pace: 255 },
    now,
  );
  assert.deepEqual(marathon, {
    user_id: UUID,
    race_type: "Marathon",
    duration_s: 10749,
    avg_pace: 255,
    updated_at: now,
  });
  // A COROS type the Python labeller left as "Unknown (5)" migrates verbatim
  // (fits varchar(32); normalisation is intentionally out of scope).
  const unknown = racePredictionRow(
    UUID,
    { id: 6, race_type: "Unknown (5)", duration_s: 1105, avg_pace: 221 },
    now,
  );
  assert.equal(unknown.race_type, "Unknown (5)");
  assert.deepEqual(Object.keys(unknown).sort(), [...RACE_PREDICTIONS_COLUMNS].sort());
});

test("racePredictionRow throws on a missing race_type (PK part)", () => {
  assert.throws(
    () => racePredictionRow(UUID, { duration_s: 100 }, NOW),
    HealthTransformError,
  );
});

test("transformRow dispatches by table and rejects an unknown table", () => {
  assert.equal(
    transformRow("daily_health", UUID, { date: "20260101" }, NOW).date,
    "20260101",
  );
  assert.throws(
    () => transformRow("sleep", UUID, {}, NOW),
    HealthTransformError,
  );
});

test("integer coercion truncates and preserves null (BigInt-safe)", () => {
  const row = dailyHealthRow(UUID, {
    date: "20260101",
    rhr: 52n, // node:sqlite can hand back a BigInt
    sleep_score: 63.0,
    stress_avg: null,
  });
  assert.equal(row.rhr, 52);
  assert.equal(typeof row.rhr, "number");
  assert.equal(row.sleep_score, 63);
  assert.equal(row.stress_avg, null);
});
