import assert from "node:assert/strict";
import test from "node:test";
import { MasterPlanLenientDirectResponseSchema, MasterPlanLenientSchema } from "./schema.js";
import { MasterPlanSchema } from "./schemas.js";

/** 与 coach_agent 侧 kernel 夹具同型的最小计划；violations 字段刻意违反跨字段确定性规则。 */
function createCrossFieldViolatingPlan() {
  return {
    status: "draft" as const,
    goal: {
      race_name: "西安马拉松",
      distance: "FM" as const,
      race_date: "2026-10-18",
      target_time: "2:50:00",
      timezone: "Asia/Shanghai" as const,
      location: "西安",
    },
    start_date: "2026-08-10",
    end_date: "2026-08-23",
    // 违反 plan 级确定性规则：total_weeks 必须等于 weeks.length
    total_weeks: 3,
    phases: [
      {
        name: "base" as const,
        start_date: "2026-08-10",
        end_date: "2026-08-23",
        focus: "建立赛季起点",
        weekly_distance_km_low: 70,
        weekly_distance_km_high: 80,
        key_session_types: ["long_run"],
        milestones: [],
        key_workouts: "周末长跑",
        monitoring_triggers: ["疼痛加重时降量"],
        coach_note: "保持恢复",
        strength: { sessions_per_week: 2, focus: "核心和下肢耐力", timing: "轻松跑后" },
        recovery: { focus: "睡眠和补给", sleep_target_hours: "7-9", adjustment_trigger: "疼痛或睡眠恶化" },
        is_completed: false,
        // 违反 phase 级确定性规则：未完成阶段的 summary 必须为 null
        summary: "已完成基础期",
      },
    ],
    weeks: [
      {
        week_index: 1,
        week_start: "2026-08-10",
        phase_name: "base" as const,
        target_weekly_km_low: 70,
        target_weekly_km_high: 80,
        // 违反 week 级确定性规则：非恢复周最多 3 节战略重点课
        key_sessions: [
          {
            type: "long_run" as const,
            distance_km: 24,
            duration_min: null,
            intensity: "Z2 endurance",
            purpose: "建立耐力",
            workout_structure: null,
          },
          {
            type: "threshold" as const,
            distance_km: 10,
            duration_min: null,
            intensity: "T",
            purpose: "阈值",
            workout_structure: null,
          },
          {
            type: "interval" as const,
            distance_km: 8,
            duration_min: null,
            intensity: "I",
            purpose: "间歇",
            workout_structure: null,
          },
          {
            type: "race_pace" as const,
            distance_km: 12,
            duration_min: null,
            intensity: "M",
            purpose: "马配",
            workout_structure: null,
          },
        ],
        is_recovery_week: false,
      },
    ],
    training_principles: ["循序渐进"],
    generated_by: "coach_agent" as const,
    version: 1 as const,
    created_at: "2026-08-10T00:00:00Z",
    updated_at: "2026-08-10T00:00:00Z",
  };
}

test("lenient schema keeps shape checks while skipping cross-field deterministic rules", () => {
  const plan = createCrossFieldViolatingPlan();

  const strict = MasterPlanSchema.safeParse(plan);
  assert.ok(!strict.success, "strict schema must reject the cross-field violations");

  const lenient = MasterPlanLenientSchema.safeParse(plan);
  assert.ok(lenient.success, "lenient schema accepts the same plan (rules skipped)");
  assert.equal(lenient.data?.total_weeks, 3);
});

test("lenient schema still rejects malformed shapes", () => {
  const plan = createCrossFieldViolatingPlan();
  const broken = { ...plan, goal: { ...plan.goal, distance: "10K" }, weeks: [] };
  assert.ok(!MasterPlanLenientSchema.safeParse(broken).success);
  assert.ok(!MasterPlanLenientDirectResponseSchema.safeParse({ disposition: "return_direct", content: broken }).success);
});

test("lenient direct-response envelope parses a shape-valid plan content", () => {
  const plan = createCrossFieldViolatingPlan();
  const envelope = MasterPlanLenientDirectResponseSchema.safeParse({ disposition: "return_direct", content: plan });
  assert.ok(envelope.success);
  assert.equal(envelope.data?.content?.goal.race_name, "西安马拉松");
});
