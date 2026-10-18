import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWeeklyPlan, WeeklyPlanSchema } from "./schema.js";

// 与 tests/fixtures/weekly_plan_contract.json 的 base 周对齐（2026-08-17 是周一）。
function validPlan() {
  const runSpec = {
    schema: "run-workout/v1",
    name: "Easy run",
    date: "2026-08-17",
    note: null,
    blocks: [
      {
        repeat: 1,
        steps: [
          { step_kind: "work", duration: { kind: "distance_m", value: 8000 }, target: { kind: "pace_s_km", low: 330, high: 360 }, note: null, hr_cap_bpm: 150 },
        ],
      },
    ],
  };
  return {
    schema: "weekly-plan/v1",
    week_name: "2026-08-17_08-23",
    sessions: [
      {
        schema: "plan-session/v1",
        date: "2026-08-17",
        session_index: 0,
        kind: "run",
        summary: "Easy run",
        spec: runSpec,
        notes_md: null,
        total_distance_m: 8000,
        total_duration_s: null,
        estimated_dose: null,
      },
      {
        schema: "plan-session/v1",
        date: "2026-08-19",
        session_index: 0,
        kind: "rest",
        summary: "休息",
        spec: null,
        notes_md: null,
        total_distance_m: null,
        total_duration_s: null,
        estimated_dose: null,
      },
    ],
    nutrition: Array.from({ length: 7 }, (_, i) => ({
      schema: "plan-nutrition/v1",
      date: `2026-08-${17 + i}`,
      kcal_target: null,
      carbs_g: null,
      protein_g: null,
      fat_g: null,
      water_ml: null,
      meals: [],
      notes_md: null,
    })),
    notes_md: null,
    coach_notes: null,
  };
}

// #611 现场：DeepSeek 给 optional rest 补 null，strict 直接拒收（生成腿两次同因失败）。
function deepSeekDamaged(plan: Record<string, unknown>): Record<string, unknown> {
  const damaged = structuredClone(plan) as typeof plan & { __noise: boolean };
  damaged.__noise = true; // 模型多吐的噪声键
  const runSession = (damaged.sessions as Array<Record<string, unknown>>)[0]!;
  const spec = runSession.spec as { blocks: Array<{ steps: Array<Record<string, unknown>> }> };
  const step = spec.blocks[0]!.steps[0]!;
  step.rest = null;
  delete step.note; // LLM 省略可空字段
  delete step.hr_cap_bpm;
  delete damaged.notes_md;
  delete damaged.coach_notes;
  return damaged;
}

test("strict WeeklyPlanSchema rejects the rest:null LLM payload (#611 reproduction)", () => {
  assert.equal(WeeklyPlanSchema.safeParse(deepSeekDamaged(validPlan())).success, false);
});

test("normalizeWeeklyPlan repairs rest:null, omitted notes and noise keys into a strict plan", () => {
  const normalized = normalizeWeeklyPlan(deepSeekDamaged(validPlan()));
  assert.equal(WeeklyPlanSchema.safeParse(normalized).success, true);
  const spec = normalized.sessions[0]!.spec!;
  assert.equal(spec.schema, "run-workout/v1");
  const step = (spec as { blocks: Array<{ steps: Array<Record<string, unknown>> }> }).blocks[0]!.steps[0]!;
  assert.equal("rest" in step, false);
  assert.deepEqual({ note: step.note, hr_cap_bpm: step.hr_cap_bpm }, { note: null, hr_cap_bpm: null });
  assert.deepEqual(normalized.notes_md, null);
  assert.deepEqual(normalized.coach_notes, null);
});
