import assert from "node:assert/strict";
import test from "node:test";
import type { WeeklyPlan, WeeklyPlanSimulationReport } from "@stride/contract";
import { assessRecoveryTrend, loadWithinTolerance, mergeSimulationIntoPlan } from "./nodes.js";
import { createWeeklyPlanForSimulation } from "./testFixtures.js";

test("mergeSimulationIntoPlan keys doses by date and session index", () => {
  const plan: WeeklyPlan = {
    ...createWeeklyPlanForSimulation(),
    sessions: [
      ...createWeeklyPlanForSimulation().sessions,
      {
        schema: "plan-session/v1",
        date: "2026-08-21",
        session_index: 0,
        kind: "rest",
        summary: "Rest",
        spec: null,
        notes_md: null,
        total_distance_m: null,
        total_duration_s: null,
        estimated_dose: null,
      },
    ],
  };
  const simulation = {
    sessions: [
      { date: "2026-08-17", session_index: 0, estimated_dose: 40 },
      { date: "2026-08-19", session_index: 0, estimated_dose: 70 },
    ],
  } as WeeklyPlanSimulationReport;

  const merged = mergeSimulationIntoPlan(plan, simulation, null);

  assert.equal(merged.sessions[0]?.estimated_dose, 40);
  assert.equal(merged.sessions[1]?.estimated_dose, 70);
  assert.equal(merged.sessions[2]?.estimated_dose, null);
});

test("mergeSimulationIntoPlan back-fills display distance for time-based run sessions only（devops#838）", () => {
  const base = createWeeklyPlanForSimulation();
  const timeBased: WeeklyPlan = {
    ...base,
    sessions: [
      ...base.sessions.map((session) => {
        if (session.kind !== "run" || session.spec === null) return session;
        return {
          ...session,
          total_distance_m: null,
          spec: {
            ...session.spec,
            blocks: [
              {
                repeat: 1,
                steps: [
                  {
                    step_kind: "work" as const,
                    duration: { kind: "time_s" as const, value: 3600 },
                    target: { kind: "open" as const, low: null, high: null },
                    note: null,
                    hr_cap_bpm: null,
                  },
                ],
              },
            ],
          },
        };
      }),
      {
        schema: "plan-session/v1",
        date: "2026-08-20",
        session_index: 0,
        kind: "strength",
        summary: "力量训练",
        spec: null,
        notes_md: null,
        total_distance_m: null,
        total_duration_s: null,
        estimated_dose: null,
      },
    ],
  };

  const merged = mergeSimulationIntoPlan(timeBased, { sessions: [] } as unknown as WeeklyPlanSimulationReport, 400);
  // 两节 run 课 3600s ÷ 400s/km = 9000m；rest/strength session 不动（strength 恒 null）。
  assert.equal(merged.sessions[0]?.total_distance_m, 9000);
  assert.equal(merged.sessions[1]?.total_distance_m, 9000);
  assert.equal(merged.sessions[2]?.total_distance_m, null);
  assert.equal(merged.sessions[3]?.total_distance_m, null);

  // 已有距离不覆盖；无校准（null 配速）由估距函数兜底 330s/km。
  const untouched = mergeSimulationIntoPlan(base, { sessions: [] } as unknown as WeeklyPlanSimulationReport, 400);
  assert.equal(untouched.sessions[0]?.total_distance_m, 10_000);
  const fallback = mergeSimulationIntoPlan(timeBased, { sessions: [] } as unknown as WeeklyPlanSimulationReport, null);
  assert.equal(fallback.sessions[0]?.total_distance_m, (3600 / 330) * 1000);
});

test("loadWithinTolerance uses the same rounded acceptance band as retry feedback", () => {
  const simulation = {
    available: true,
    total_dose: 257.29,
  } as WeeklyPlanSimulationReport;
  const target = {
    training_load_low: 208,
    training_load_high: 233.9,
  } as Parameters<typeof loadWithinTolerance>[1];

  assert.equal(loadWithinTolerance(simulation, target), true);
  assert.equal(loadWithinTolerance({ ...simulation, total_dose: 257.2901 }, target), false);
});

function recoveryHistory(rhrs: number[], hrvs: number[], startDay = 1) {
  return rhrs.map((rhr, i) => ({
    date: `2026-08-${String(startDay + i).padStart(2, "0")}`,
    rhr,
    hrv: hrvs[i] ?? null,
  }));
}

test("assessRecoveryTrend ignores small RHR swings, flags a sustained 5+ bpm rise", () => {
  // tiny +1 bpm drift is normal, not deterioration
  const flat = assessRecoveryTrend(recoveryHistory(Array(10).fill(50), Array(10).fill(60)), 50, 55);
  assert.equal(flat.deteriorating, false);
  assert.equal(flat.rhr_rising_deviation, false);

  // prior 5d avg 50, recent 5d avg 56 -> +6 bpm
  const rise = assessRecoveryTrend(recoveryHistory([50, 50, 50, 50, 50, 56, 56, 56, 56, 56], Array(10).fill(60)), 50, 55);
  assert.equal(rise.rhr_rising_deviation, true);
  assert.equal(rise.deteriorating, true);

  // exactly +5 bpm is the boundary -> deteriorates
  const boundary = assessRecoveryTrend(recoveryHistory([50, 50, 50, 50, 50, 55, 55, 55, 55, 55], Array(10).fill(60)), 50, 55);
  assert.equal(boundary.rhr_rising_deviation, true);
  assert.equal(boundary.deteriorating, true);
});

test("assessRecoveryTrend flags HRV only when it sits below the baseline_low by a margin", () => {
  // falling HRV that stays above baseline is normal
  const above = assessRecoveryTrend(recoveryHistory(Array(10).fill(50), [60, 60, 60, 60, 60, 57, 57, 57, 57, 57]), 50, 55);
  assert.equal(above.hrv_falling, true);
  assert.equal(above.hrv_below_baseline, false);
  assert.equal(above.deteriorating, false);

  // dips below baseline but not by 10% (54 vs 55 baseline) -> noise, not deterioration
  const smallDip = assessRecoveryTrend(recoveryHistory(Array(10).fill(50), [60, 60, 60, 60, 60, 54, 54, 54, 54, 54]), 50, 55);
  assert.equal(smallDip.hrv_below_baseline, false);
  assert.equal(smallDip.deteriorating, false);

  // >=10% below baseline (49 vs 55 baseline) -> deterioration
  const below = assessRecoveryTrend(recoveryHistory(Array(10).fill(50), [60, 60, 60, 60, 60, 49, 49, 49, 49, 49]), 50, 55);
  assert.equal(below.hrv_below_baseline, true);
  assert.equal(below.deteriorating, true);

  // no baseline available -> can't confirm below-baseline, not deterioration
  const noBaseline = assessRecoveryTrend(recoveryHistory(Array(10).fill(50), [60, 60, 60, 60, 60, 49, 49, 49, 49, 49]), 50, null);
  assert.equal(noBaseline.hrv_below_baseline, false);
  assert.equal(noBaseline.deteriorating, false);
});
