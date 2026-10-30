import assert from "node:assert/strict";
import test from "node:test";
import type { RunWorkout, WorkoutStep } from "./schema.js";
import { easyMidOfPaceZones, estimatedTotalDistanceM, workoutTotals } from "./totals.js";

function step(overrides: Partial<WorkoutStep>): WorkoutStep {
  return {
    step_kind: "work",
    duration: { kind: "time_s", value: 600 },
    target: { kind: "open", low: null, high: null },
    note: null,
    hr_cap_bpm: null,
    ...overrides,
  };
}

function workout(blocks: Array<{ repeat?: number; steps: WorkoutStep[] }>): RunWorkout {
  return {
    schema: "run-workout/v1",
    name: "estimate-test",
    date: "2026-10-30",
    note: null,
    blocks: blocks.map((block) => ({ repeat: block.repeat ?? 1, steps: block.steps })),
  };
}

test("estimatedTotalDistanceM: time+open steps fold at the easy band mid（契约⑨）", () => {
  const w = workout([{ steps: [step({})] }]);
  // 600s ÷ 400s/km = 1.5km
  assert.equal(estimatedTotalDistanceM(w, 400), 1500);
  // workoutTotals 不受影响：time+open 步距离仍未知。
  assert.equal(workoutTotals(w).total_distance_m, null);
});

test("estimatedTotalDistanceM: pace-prescribed time steps fold at the prescription mid", () => {
  const w = workout([{ repeat: 3, steps: [step({ duration: { kind: "time_s", value: 300 }, target: { kind: "pace_s_km", low: 230, high: 250 } })] }]);
  // 3 × (300 ÷ 240) km = 3.75km；easy 带无关
  assert.equal(estimatedTotalDistanceM(w, 400), 3750);
});

test("estimatedTotalDistanceM: mixed course sums direct/prescribed/open steps; rest steps excluded", () => {
  const w = workout([
    {
      steps: [
        step({ step_kind: "warmup", duration: { kind: "time_s", value: 600 } }),
        step({ step_kind: "rest", duration: { kind: "time_s", value: 120 } }),
        step({ duration: { kind: "distance_m", value: 1000 } }),
        step({ step_kind: "cooldown", duration: { kind: "time_s", value: 300 } }),
      ],
    },
  ]);
  // 600÷400 + 1000 + 300÷400 (m) = 1500 + 1000 + 750 = 3250；rest 步不折算
  assert.equal(estimatedTotalDistanceM(w, 400), 3250);
});

test("estimatedTotalDistanceM: un-estimable steps null the total; missing pace falls back to 330s/km", () => {
  // open duration 步（时长本身未知）→ 未知不猜
  const openDuration = workout([{ steps: [step({ duration: { kind: "open", value: null } })] }]);
  assert.equal(estimatedTotalDistanceM(openDuration, 400), null);
  // 混合课里有一节不可估即整体 null（不报半截数）
  const mixed = workout([{ steps: [step({}), step({ step_kind: "recovery", duration: { kind: "open", value: null } })] }]);
  assert.equal(estimatedTotalDistanceM(mixed, 400), null);
  // 无校准 / easy 带缺失 → 330s/km 兜底：600s ÷ 330
  const w = workout([{ steps: [step({})] }]);
  assert.equal(estimatedTotalDistanceM(w, null), (600 / 330) * 1000);
  assert.equal(estimatedTotalDistanceM(w), (600 / 330) * 1000);
});

test("estimatedTotalDistanceM: distance-only course equals workoutTotals", () => {
  const w = workout([{ repeat: 6, steps: [step({ duration: { kind: "distance_m", value: 400 }, target: { kind: "pace_s_km", low: 205, high: 215 } })] }]);
  assert.equal(estimatedTotalDistanceM(w, 400), workoutTotals(w).total_distance_m);
});

test("easyMidOfPaceZones: easy mid, missing/open bands, empty input", () => {
  assert.equal(
    easyMidOfPaceZones([
      { name: "easy", minPaceSPerKm: 300, maxPaceSPerKm: 340 },
      { name: "threshold", minPaceSPerKm: 230, maxPaceSPerKm: 240 },
    ]),
    320,
  );
  assert.equal(easyMidOfPaceZones([{ name: "threshold", minPaceSPerKm: 230, maxPaceSPerKm: 240 }]), null);
  assert.equal(easyMidOfPaceZones([{ name: "easy", minPaceSPerKm: 300, maxPaceSPerKm: null }]), null);
  assert.equal(easyMidOfPaceZones([]), null);
  assert.equal(easyMidOfPaceZones(null), null);
});
