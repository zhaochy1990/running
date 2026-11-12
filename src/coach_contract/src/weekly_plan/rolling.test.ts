import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWeeklyPlan, WeeklyPlanSchema } from "./schema.js";

/**
 * 滚动扩展字段契约往返（#858 PR-A Round 1）：WeeklyPlanSchema 追加的可选字段
 * parse/serialize 往返；存量 v1 文档（无扩展字段）不受影响；LLM 宽松归一
 * （normalizeWeeklyPlan）继续剥离未知键。
 */

function runSpec(date: string, name: string) {
  return {
    schema: "run-workout/v1",
    name,
    date,
    note: null,
    type: "E",
    purpose: "有氧恢复",
    blocks: [
      {
        repeat: 1,
        steps: [
          {
            step_kind: "work",
            duration: { kind: "distance_m", value: 8000 },
            target: { kind: "pace_s_km", low: 330, high: 360 },
            note: null,
            hr_cap_bpm: null,
          },
        ],
      },
    ],
  };
}

function rollingDoc() {
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
        spec: runSpec("2026-08-17", "Easy run"),
        notes_md: null,
        total_distance_m: 8000,
        total_duration_s: null,
        estimated_dose: 47.2,
      },
      {
        schema: "plan-session/v1",
        date: "2026-08-18",
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
    coach_notes: "建立有氧基础（近 8 周 60km）；第 7 周（progress）；出口里程碑：周量：连续 3 周 ≥60km",
    week_index: 7,
    phase_name: "base",
    phase_goal: "建立有氧基础（赛季初有氧储备不足）",
    milestone_note: "周量：连续 3 周 ≥60km",
    target_weekly_km_low: 66,
    target_weekly_km_high: 66,
    is_recovery_week: false,
    planned_dose: 312.4,
    load_ratio_projection: 1.05,
    km_deviation_pct: 10,
    source: "llm",
  };
}

test("滚动扩展字段：strict parse → JSON 序列化 → 再 parse 往返一致", () => {
  const parsed = WeeklyPlanSchema.parse(rollingDoc());
  assert.equal(parsed.week_index, 7);
  assert.equal(parsed.phase_name, "base");
  assert.equal(parsed.phase_goal, "建立有氧基础（赛季初有氧储备不足）");
  assert.equal(parsed.milestone_note, "周量：连续 3 周 ≥60km");
  assert.equal(parsed.target_weekly_km_low, 66);
  assert.equal(parsed.target_weekly_km_high, 66);
  assert.equal(parsed.is_recovery_week, false);
  assert.equal(parsed.planned_dose, 312.4);
  assert.equal(parsed.load_ratio_projection, 1.05);
  assert.equal(parsed.km_deviation_pct, 10);
  assert.equal(parsed.source, "llm");
  const round = WeeklyPlanSchema.parse(JSON.parse(JSON.stringify(parsed)));
  assert.deepEqual(round, parsed);
});

test("滚动扩展字段全可省：存量 v1 文档（无扩展字段）照常合法", () => {
  const { week_index: _weekIndex, phase_name: _phaseName, planned_dose: _plannedDose, source: _source, ...legacy } = rollingDoc();
  const parsed = WeeklyPlanSchema.parse(legacy);
  assert.equal(parsed.week_index, undefined);
  assert.equal(parsed.source, undefined);
});

test("load_ratio_projection 可为 null（chronic=0 的退化种子）；source 只收 llm/fallback", () => {
  const doc = rollingDoc();
  const nullable = WeeklyPlanSchema.parse({ ...doc, load_ratio_projection: null });
  assert.equal(nullable.load_ratio_projection, null);
  assert.equal(WeeklyPlanSchema.safeParse({ ...doc, source: "table" }).success, false);
});

test("normalizeWeeklyPlan（LLM 宽松归一）对扩展字段零感知：剥掉后仍是合法 strict 文档", () => {
  const normalized = normalizeWeeklyPlan(rollingDoc());
  assert.equal(normalized.week_index, undefined);
  assert.equal(normalized.planned_dose, undefined);
  assert.equal(normalized.sessions.length, 2);
});
