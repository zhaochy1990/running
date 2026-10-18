import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { normalizeRunWorkout, type RunWorkout, RunWorkoutLenientSchema, RunWorkoutSchema, StrengthWorkoutSchema } from "./schema.js";
import { formatDurationSec, formatPaceSecKm, formatStepRest, renderRunWorkoutDetail, renderRunWorkoutSummary } from "./summary.js";
import { workoutTotals } from "./totals.js";

const FIXTURE_DIR = new URL("../../../../tests/fixtures/workout/", import.meta.url);

function loadFixture(name: string): RunWorkout {
  return RunWorkoutSchema.parse(JSON.parse(readFileSync(new URL(name, FIXTURE_DIR), "utf8")));
}

test("formatPaceSecKm / formatDurationSec are deterministic", () => {
  assert.equal(formatPaceSecKm(230), "3:50");
  assert.equal(formatPaceSecKm(205), "3:25");
  assert.equal(formatDurationSec(180), "3′");
  assert.equal(formatDurationSec(90), "90″");
  assert.equal(formatDurationSec(3600), "60′");
});

test("summary golden: user example with rest fields", () => {
  const workout = loadFixture("interval-rest-field.json");
  assert.equal(renderRunWorkoutSummary(workout), "3×4km @ 3:50–4:00/km（休3′） ＋ 6×400m @ 3:25–3:35/km（休90″）");
  assert.equal(renderRunWorkoutDetail(workout), "3× 4km @ 3:50–4:00/km（休3′）\n6× 400m @ 3:25–3:35/km（休90″）");
});

test("dual rest idioms render identically and produce identical totals", () => {
  const restField = loadFixture("interval-rest-field.json");
  const restStep = loadFixture("interval-rest-step.json");
  assert.equal(renderRunWorkoutSummary(restStep), renderRunWorkoutSummary(restField));
  assert.equal(renderRunWorkoutDetail(restStep), renderRunWorkoutDetail(restField));
  assert.deepEqual(workoutTotals(restStep), workoutTotals(restField));
  // 跑动距离步不带固定时长，总时长未知 → null；两种 idiom 仍等价。
  assert.deepEqual(workoutTotals(restField), { total_distance_m: 14400, total_duration_s: null });
});

test("rest field variants render: hr recovery and manual", () => {
  assert.equal(renderRunWorkoutSummary(loadFixture("hr-recovery-rest.json")), "5×1km @ 3:55–4:05/km，HR≤175（休至HR<130）");
  assert.equal(renderRunWorkoutSummary(loadFixture("cadence-target.json")), "8×20″ @ 176–186spm（休手动）");
});

test("linear blocks join with →, open targets are omitted", () => {
  const workout = loadFixture("easy-run.json");
  assert.equal(renderRunWorkoutDetail(workout), "10′\n50′ @ 130–150bpm\n10′");
  assert.equal(renderRunWorkoutSummary(workout), "10′→50′ @ 130–150bpm→10′");
});

test("totals: open steps and non-time rests null the affected total", () => {
  assert.deepEqual(workoutTotals(loadFixture("open-duration.json")), { total_distance_m: null, total_duration_s: null });
  assert.deepEqual(workoutTotals(loadFixture("hr-recovery-rest.json")), { total_distance_m: 5000, total_duration_s: null });
  assert.deepEqual(workoutTotals(loadFixture("cadence-target.json")), { total_distance_m: null, total_duration_s: null });
  assert.deepEqual(workoutTotals(loadFixture("easy-run.json")), { total_distance_m: null, total_duration_s: 4200 });
});

test("lenient parsing tolerates LLM noise and normalizeRunWorkout fills defaults", () => {
  const lenient = RunWorkoutLenientSchema.parse({
    schema: "run-workout/v1",
    name: "节奏跑",
    date: "2026-03-14",
    note: null,
    blocks: [
      {
        repeat: 1,
        steps: [
          {
            step_kind: "work",
            duration: { kind: "time_s", value: 1800 },
            target: { kind: "power_w", low: 200, high: 250 },
            title: "模型多吐的噪声键",
          },
        ],
      },
    ],
  });
  const strict = normalizeRunWorkout(lenient);
  assert.equal(strict.schema, "run-workout/v1");
  assert.deepEqual(strict.blocks[0]!.steps[0], {
    step_kind: "work",
    duration: { kind: "time_s", value: 1800 },
    target: { kind: "power_w", low: 200, high: 250 },
    note: null,
    hr_cap_bpm: null,
  });
  // lenient 也容忍缺失 schema 判别符
  const { schema: _discarded, ...withoutSchema } = structuredClone(JSON.parse(JSON.stringify(lenient)));
  assert.equal(normalizeRunWorkout(withoutSchema).schema, "run-workout/v1");
  // #611：LLM 给 optional rest 补 null，lenient 接受、normalize 丢弃
  const withNullRest = { ...withoutSchema, blocks: [{ repeat: 1, steps: [{ ...withoutSchema.blocks[0]!.steps[0]!, rest: null }] }] };
  assert.equal("rest" in normalizeRunWorkout(withNullRest).blocks[0]!.steps[0]!, false);
});

test("duration/target unions keep master's strict positive/null constraints", () => {
  const base = loadFixture("interval-rest-field.json");
  const invalidDurations = [
    { kind: "distance_m", value: null },
    { kind: "distance_m", value: 0 },
    { kind: "time_s", value: -5 },
  ];
  for (const duration of invalidDurations) {
    const attempt = structuredClone(base);
    attempt.blocks[0]!.steps[0]!.duration = duration as never;
    assert.equal(RunWorkoutSchema.safeParse(attempt).success, false, JSON.stringify(duration));
  }
  const attempt = structuredClone(base);
  attempt.blocks[0]!.steps[0]!.target = { kind: "pace_s_km", low: 0, high: 230 } as never;
  assert.equal(RunWorkoutSchema.safeParse(attempt).success, false);
  assert.equal(RunWorkoutSchema.safeParse(loadFixture("open-duration.json")).success, true);
});

test("a rest step must not carry a rest field (strict and lenient)", () => {
  const restStepWithRest = {
    step_kind: "rest",
    duration: { kind: "time_s", value: 60 },
    target: { kind: "open", low: null, high: null },
    note: null,
    hr_cap_bpm: null,
    rest: { kind: "manual", value: null },
  };
  const base = loadFixture("interval-rest-field.json");
  const attempt = structuredClone(base);
  attempt.blocks[0]!.steps[0] = restStepWithRest as never;
  assert.equal(RunWorkoutSchema.safeParse(attempt).success, false);
  const lenientAttempt = {
    name: base.name,
    date: base.date,
    note: base.note,
    blocks: [{ repeat: 1, steps: [restStepWithRest] }],
  };
  assert.equal(RunWorkoutLenientSchema.safeParse(lenientAttempt).success, false);
});

test("shared fixtures are authoritative: every fixture parses and round-trips", () => {
  for (const entry of readdirSync(FIXTURE_DIR)) {
    const raw = JSON.parse(readFileSync(new URL(entry, FIXTURE_DIR), "utf8"));
    const schema = raw.schema === "strength-workout/v1" ? StrengthWorkoutSchema : RunWorkoutSchema;
    assert.deepEqual(schema.parse(raw), raw, entry);
  }
});

test("when both rest idioms coexist the trailing rest step wins", () => {
  const workout = loadFixture("interval-rest-field.json");
  workout.blocks[0]!.steps = [
    structuredClone(workout.blocks[0]!.steps[0]!),
    { step_kind: "rest", duration: { kind: "time_s", value: 60 }, target: { kind: "open", low: null, high: null }, note: null, hr_cap_bpm: null },
  ];
  assert.equal(renderRunWorkoutSummary(workout), "3×4km @ 3:50–4:00/km（休1′） ＋ 6×400m @ 3:25–3:35/km（休90″）");
});

test("formatStepRest covers all three kinds", () => {
  assert.equal(formatStepRest({ kind: "time_s", value: 90 }), "（休90″）");
  assert.equal(formatStepRest({ kind: "hr_bpm", value: 130 }), "（休至HR<130）");
  assert.equal(formatStepRest({ kind: "manual", value: null }), "（休手动）");
});
