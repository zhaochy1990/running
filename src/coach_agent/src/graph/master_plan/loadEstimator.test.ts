import assert from "node:assert/strict";
import test from "node:test";
import type { MasterPlan } from "@stride/contract";
import { estimateMasterPlanWeekLoad } from "./loadEstimator.js";
import structuredFixtures from "./structuredLoadFixtures.json" with { type: "json" };
import { createTestMasterPlan } from "./testFixtures.js";

type Week = MasterPlan["weeks"][number];

function canonicalPaceZones(thresholdSpeedMps = 4) {
  const ratios = {
    recovery: [null, 0.72],
    easy: [0.72, 0.84],
    marathon: [0.84, 0.97],
    threshold: [0.97, 1.03],
    interval: [1.03, 1.11],
    repetition: [1.11, null],
  } as const;
  return Object.entries(ratios).map(([name, [low, high]]) => ({
    name,
    minPaceSPerKm: high === null ? null : 1000 / (thresholdSpeedMps * high),
    maxPaceSPerKm: low === null ? null : 1000 / (thresholdSpeedMps * low),
  }));
}

function estimate(week: Partial<Week> & Pick<Week, "key_sessions">, goal: MasterPlan["goal"] = createTestMasterPlan().goal) {
  const base = createTestMasterPlan().weeks[0];
  assert.ok(base);
  return estimateMasterPlanWeekLoad(
    {
      ...base,
      target_weekly_km_low: 50,
      target_weekly_km_high: 60,
      ...week,
    },
    goal,
    4,
    canonicalPaceZones(),
  );
}

function step(
  step_kind: "warmup" | "work" | "recovery" | "cooldown" | "rest",
  duration: { kind: "time_s" | "distance_m"; value: number },
  target: { kind: "pace_s_km" | "hr_bpm"; low: number; high: number } | { kind: "open"; low: null; high: null },
) {
  return { step_kind, duration, target, note: null, hr_cap_bpm: null };
}

function workoutStructure(blocks: Array<{ repeat: number; steps: ReturnType<typeof step>[] }>) {
  return {
    schema: "run-workout/v1" as const,
    name: "structured test",
    date: "2026-08-11",
    note: null,
    blocks,
  };
}

test("weekly range and remaining easy volume match the Python master-plan estimator", () => {
  const result = estimate({ key_sessions: [] });

  assert.deepEqual(
    {
      expected: result.expectedDose,
      low: result.lowDose,
      high: result.highDose,
      remainingLow: result.remainingEasyKmLow,
      remainingHigh: result.remainingEasyKm,
    },
    {
      expected: 325,
      low: 250,
      high: 350,
      remainingLow: 50,
      remainingHigh: 60,
    },
  );
  assert.deepEqual(result.assumptions, ["remaining_weekly_distance_in_easy_zone"]);
});

test("shared structured fixtures match Python planned-load details", () => {
  const base = createTestMasterPlan().weeks[0];
  assert.ok(base);
  for (const fixture of structuredFixtures.cases) {
    const result = estimateMasterPlanWeekLoad(
      {
        ...base,
        target_weekly_km_low: fixture.declared_distance_km,
        target_weekly_km_high: fixture.declared_distance_km,
        key_sessions: [
          {
            type: fixture.type,
            distance_km: fixture.declared_distance_km,
            duration_min: fixture.declared_duration_min,
            intensity: fixture.id,
            purpose: "structured parity",
            workout_structure: fixture.workout_structure,
          },
        ],
      } as Week,
      createTestMasterPlan().goal,
      structuredFixtures.threshold_speed_mps,
      canonicalPaceZones(structuredFixtures.threshold_speed_mps),
      structuredFixtures.threshold_hr,
      structuredFixtures.rhr,
    );

    assert.equal(result.lowDose, Number(fixture.expected.low_dose.toFixed(1)), fixture.id);
    assert.equal(result.expectedDose, Number(fixture.expected.expected_dose.toFixed(1)), fixture.id);
    assert.equal(result.highDose, Number(fixture.expected.high_dose.toFixed(1)), fixture.id);
  }
});

test("quality sessions use their personal pace-zone range instead of whole-workout average speed", () => {
  const result = estimate({
    key_sessions: [
      {
        type: "interval",
        distance_km: 12,
        duration_min: 75,
        intensity: "3 km warm-up + 6 x 800 m Z5 with jog recoveries + cool-down",
        purpose: "quality session",
      },
    ],
  });

  assert.equal(result.expectedDose, 349.2);
  assert.equal(result.lowDose, 275.8);
  assert.equal(result.highDose, 372.5);
  assert.equal(result.keySessionKm, 12);
  assert.ok(result.assumptions.includes("z5_pace_zone_range"));
});

test("structured intervals integrate warm-up, repeated work, active recovery and cooldown", () => {
  const result = estimate({
    target_weekly_km_low: 11.304,
    target_weekly_km_high: 11.304,
    key_sessions: [
      {
        type: "interval",
        distance_km: 11.304,
        duration_min: 55,
        intensity: "15 min warm-up + 6 x (3 min work + 2 min jog) + 10 min cooldown",
        purpose: "interval stimulus",
        workout_structure: {
          schema: "run-workout/v1",
          name: "6x3min",
          date: "2026-08-11",
          note: null,
          blocks: [
            {
              repeat: 1,
              steps: [
                {
                  step_kind: "warmup",
                  duration: { kind: "time_s", value: 900 },
                  target: { kind: "open", low: null, high: null },
                },
              ],
            },
            {
              repeat: 6,
              steps: [
                {
                  step_kind: "work",
                  duration: { kind: "time_s", value: 180 },
                  target: {
                    kind: "pace_s_km",
                    low: 1000 / (4 * 1.1),
                    high: 1000 / (4 * 1.1),
                  },
                },
                {
                  step_kind: "recovery",
                  duration: { kind: "time_s", value: 120 },
                  target: { kind: "open", low: null, high: null },
                },
              ],
            },
            {
              repeat: 1,
              steps: [
                {
                  step_kind: "cooldown",
                  duration: { kind: "time_s", value: 600 },
                  target: { kind: "open", low: null, high: null },
                },
              ],
            },
          ],
        },
      },
    ] as unknown as Week["key_sessions"],
  });

  assert.equal(result.expectedDose, 81.3);
  assert.deepEqual(result.lowDose, result.expectedDose);
  assert.deepEqual(result.highDose, result.expectedDose);
  assert.ok(result.assumptions.includes("structured_workout_segments_integrated"));
});

test("structured distance ranges, repeat blocks and passive rests match the Python oracle", () => {
  const result = estimate({
    target_weekly_km_low: 11,
    target_weekly_km_high: 11,
    key_sessions: [
      {
        type: "interval",
        distance_km: 11,
        duration_min: 51.7379,
        intensity: "2km warm-up + 5 x (1km work + 400m jog) + 2km cooldown",
        purpose: "interval stimulus",
        workout_structure: workoutStructure([
          {
            repeat: 1,
            steps: [
              step(
                "warmup",
                { kind: "distance_m", value: 2000 },
                {
                  kind: "pace_s_km",
                  low: 330,
                  high: 310,
                },
              ),
            ],
          },
          {
            repeat: 5,
            steps: [
              step(
                "work",
                { kind: "distance_m", value: 1000 },
                {
                  kind: "pace_s_km",
                  low: 230,
                  high: 220,
                },
              ),
              step(
                "recovery",
                { kind: "distance_m", value: 400 },
                {
                  kind: "pace_s_km",
                  low: 360,
                  high: 340,
                },
              ),
              step(
                "rest",
                { kind: "time_s", value: 60 },
                {
                  kind: "open",
                  low: null,
                  high: null,
                },
              ),
            ],
          },
          {
            repeat: 1,
            steps: [
              step(
                "cooldown",
                { kind: "distance_m", value: 2000 },
                {
                  kind: "open",
                  low: null,
                  high: null,
                },
              ),
            ],
          },
        ]),
      },
    ],
  });

  assert.deepEqual([result.expectedDose, result.lowDose, result.highDose], [80.3, 78.5, 82.1]);
});

test("structured weekly volume uses segment distance instead of a conflicting declaration", () => {
  const result = estimate({
    target_weekly_km_low: 20,
    target_weekly_km_high: 20,
    key_sessions: [
      {
        type: "threshold",
        distance_km: 20,
        duration_min: 50,
        intensity: "conflicting declaration",
        purpose: "regression",
        workout_structure: workoutStructure([
          {
            repeat: 1,
            steps: [
              step(
                "work",
                { kind: "distance_m", value: 10000 },
                {
                  kind: "pace_s_km",
                  low: 250,
                  high: 250,
                },
              ),
            ],
          },
        ]),
      },
    ],
  });

  assert.equal(result.keySessionKm, 10);
  assert.equal(result.remainingEasyKm, 10);
});

test("structured long runs integrate embedded race-pace blocks as one session", () => {
  const result = estimate({
    target_weekly_km_low: 25,
    target_weekly_km_high: 25,
    key_sessions: [
      {
        type: "long_run",
        distance_km: 25,
        duration_min: 114.0374,
        intensity: "5km easy + 15km MP + 5km easy",
        purpose: "marathon-specific endurance",
        workout_structure: workoutStructure([
          {
            repeat: 1,
            steps: [
              step(
                "warmup",
                { kind: "distance_m", value: 5000 },
                {
                  kind: "open",
                  low: null,
                  high: null,
                },
              ),
              step(
                "work",
                { kind: "distance_m", value: 15000 },
                {
                  kind: "pace_s_km",
                  low: 245,
                  high: 240,
                },
              ),
              step(
                "cooldown",
                { kind: "distance_m", value: 5000 },
                {
                  kind: "open",
                  low: null,
                  high: null,
                },
              ),
            ],
          },
        ]),
      },
    ],
  });

  assert.deepEqual([result.expectedDose, result.lowDose, result.highDose], [172.2, 170.3, 174.1]);
  assert.equal(result.longRunDose, 172.2);
});

test("structured HR targets use the athlete's threshold and resting HR calibration", () => {
  const base = createTestMasterPlan().weeks[0];
  assert.ok(base);
  const result = estimateMasterPlanWeekLoad(
    {
      ...base,
      target_weekly_km_low: 5.7,
      target_weekly_km_high: 5.7,
      key_sessions: [
        {
          type: "tempo",
          distance_km: 5.7,
          duration_min: 30,
          intensity: "30min HR 140-150",
          purpose: "tempo stimulus",
          workout_structure: workoutStructure([
            {
              repeat: 1,
              steps: [
                step(
                  "work",
                  { kind: "time_s", value: 1800 },
                  {
                    kind: "hr_bpm",
                    low: 140,
                    high: 150,
                  },
                ),
              ],
            },
          ]),
        },
      ],
    },
    createTestMasterPlan().goal,
    4,
    canonicalPaceZones(),
    170,
    50,
  );

  assert.deepEqual([result.expectedDose, result.lowDose, result.highDose], [31.3, 28.1, 34.7]);
  assert.ok(result.assumptions.includes("heart_rate_target_used_as_intensity_proxy"));
});

test("multi-zone quality text follows the Python marker precedence", () => {
  const result = estimate({
    key_sessions: [
      {
        type: "interval",
        distance_km: 12,
        duration_min: 75,
        intensity: "3 km Z2 warm-up + 6 x 800 m Z5 with jog recoveries",
        purpose: "interval stimulus",
      },
    ],
  });

  assert.equal(result.expectedDose, 325);
  assert.ok(result.assumptions.includes("z2_pace_zone_range"));
});

test("Z1 sessions use the persisted open-ended recovery pace zone", () => {
  const result = estimate({
    target_weekly_km_low: 10,
    target_weekly_km_high: 10,
    key_sessions: [
      {
        type: "long_run",
        distance_km: 10,
        duration_min: null,
        intensity: "Z1 recovery",
        purpose: "recovery stimulus",
      },
    ],
  });

  assert.equal(result.expectedDose, 42.4);
  assert.equal(result.lowDose, 34.7);
  assert.equal(result.highDose, 50);
  assert.ok(result.assumptions.includes("z1_pace_zone_range"));
});

test("distance takes precedence over total duration for strategic session load", () => {
  const common = {
    type: "threshold" as const,
    distance_km: 10,
    intensity: "Z4 steady",
    purpose: "threshold stimulus",
  };
  const distanceOnly = estimate({
    key_sessions: [{ ...common, duration_min: null }],
  });
  const withElapsedDuration = estimate({
    key_sessions: [{ ...common, duration_min: 75 }],
  });

  assert.equal(distanceOnly.expectedDose, 340.3);
  assert.equal(withElapsedDuration.expectedDose, distanceOnly.expectedDose);
});

test("estimator consumes persisted canonical pace-zone boundaries", () => {
  const base = createTestMasterPlan().weeks[0];
  assert.ok(base);
  const zones = canonicalPaceZones().map((zone) =>
    zone.name === "easy"
      ? {
          ...zone,
          minPaceSPerKm: 1000 / (4 * 0.9),
          maxPaceSPerKm: 1000 / (4 * 0.8),
        }
      : zone,
  );
  const result = estimateMasterPlanWeekLoad(
    {
      ...base,
      target_weekly_km_low: 50,
      target_weekly_km_high: 60,
      key_sessions: [],
    },
    createTestMasterPlan().goal,
    4,
    zones,
  );

  assert.equal(result.expectedDose, 354.2);
  assert.equal(result.assumptions.includes("pace_zone_calibration_missing"), false);
});

test("duration-only sessions derive distance from personal threshold calibration", () => {
  const result = estimate({
    key_sessions: [
      {
        type: "vo2max",
        distance_km: null,
        duration_min: 75,
        intensity: "warm-up + 5 x 4 min hard with jog recoveries + cool-down",
        purpose: "VO2 stimulus",
      },
    ],
  });

  assert.equal(result.expectedDose, 363.8);
  assert.equal(result.lowDose, 286.3);
  assert.equal(result.highDose, 391.7);
  assert.equal(result.keySessionKm, 19.3);
});

test("an embedded marathon-pace block remains one long run and exposes uncertainty", () => {
  const result = estimate({
    key_sessions: [
      {
        type: "long_run",
        distance_km: 30,
        duration_min: 180,
        intensity: "10 km easy + 15 km MP + 5 km easy",
        purpose: "marathon-specific endurance",
      },
    ],
  });

  assert.equal(result.expectedDose, 345.2);
  assert.equal(result.lowDose, 250);
  assert.equal(result.highDose, 390.5);
  assert.equal(result.keySessionKm, 30);
  assert.equal(result.longRunDose, 182.7);
  assert.ok(result.assumptions.includes("mp_fraction_unspecified_range_easy_to_goal_pace"));
});

test("an explicitly embedded sibling replaces part of its parent without double-counting distance", () => {
  const result = estimate({
    key_sessions: [
      {
        type: "long_run",
        distance_km: 30,
        duration_min: 180,
        intensity: "Z2 endurance",
        purpose: "long run",
      },
      {
        type: "race_pace",
        distance_km: 10,
        duration_min: 45,
        intensity: "MP embedded within long run",
        purpose: "part of long run",
      },
    ],
  });

  assert.equal(result.keySessionKm, 30);
  assert.equal(result.expectedDose, 342.7);
  assert.equal(result.lowDose, 271.8);
  assert.equal(result.highDose, 363.5);
  assert.equal(result.longRunDose, 180.2);
  assert.ok(result.assumptions.includes("race_pace_embedded_in_parent_not_double_counted"));
  assert.ok(result.assumptions.includes("embedded_segments_integrated_by_distance"));
});

test("race sessions use the goal pace while tune-up races use their own result", () => {
  const race = estimate({
    target_weekly_km_low: 42.195,
    target_weekly_km_high: 42.195,
    key_sessions: [
      {
        type: "race",
        distance_km: 42.195,
        duration_min: 180,
        intensity: "目标比赛",
        purpose: "race",
      },
    ],
  });
  const tuneUp = estimate({
    target_weekly_km_low: 30,
    target_weekly_km_high: 40,
    key_sessions: [
      {
        type: "tune_up_race",
        distance_km: 10,
        duration_min: 42,
        intensity: "10K tune-up",
        purpose: "race rehearsal",
      },
    ],
  });

  assert.deepEqual([race.expectedDose, race.lowDose, race.highDose], [303, 303, 303]);
  assert.deepEqual([tuneUp.expectedDose, tuneUp.lowDose, tuneUp.highDose], [231.4, 168.9, 243.9]);
});

test("strength-only weeks keep running dose at zero", () => {
  const result = estimate({
    target_weekly_km_low: 0,
    target_weekly_km_high: 0,
    key_sessions: [
      {
        type: "strength_key",
        distance_km: null,
        duration_min: 45,
        intensity: "heavy strength",
        purpose: "strength",
      },
    ],
  });

  assert.equal(result.expectedDose, 0);
  assert.equal(result.lowDose, 0);
  assert.equal(result.highDose, 0);
});

test("missing threshold calibration makes all dose bounds unavailable", () => {
  const result = estimate({ key_sessions: [] });
  const week = createTestMasterPlan().weeks[0];
  assert.ok(week);
  const unavailable = estimateMasterPlanWeekLoad(week, createTestMasterPlan().goal, null);

  assert.notEqual(result.expectedDose, null);
  assert.equal(unavailable.expectedDose, null);
  assert.equal(unavailable.lowDose, null);
  assert.equal(unavailable.highDose, null);
  assert.equal(unavailable.unavailableReason, "threshold_speed_calibration_missing");
});

test("missing canonical pace zones makes all dose bounds unavailable", () => {
  const week = createTestMasterPlan().weeks[0];
  assert.ok(week);
  const unavailable = estimateMasterPlanWeekLoad(week, createTestMasterPlan().goal, 4, []);

  assert.equal(unavailable.expectedDose, null);
  assert.equal(unavailable.lowDose, null);
  assert.equal(unavailable.highDose, null);
  assert.equal(unavailable.unavailableReason, "pace_zone_calibration_missing");
});
