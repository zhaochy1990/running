import assert from "node:assert/strict";
import test from "node:test";
import { MasterPlanGraphOutcome, MasterPlanGraphRequest } from "./contracts.js";

function createTestRequest() {
  return {
    request_id: "request-342",
    requested_mode: "new_season" as const,
    requested_modifiers: [],
    goals: [
      {
        race_name: "西安马拉松",
        location: "西安",
        distance: "FM" as const,
        race_date: "2026-10-18",
        target_time: "2:50:00",
        finish_only: false,
        priority: "A" as const,
      },
    ],
    availability: {
      weekly_run_days_max: 6,
      available_training_windows: [
        { day: "monday" as const, start_time: "06:00", end_time: "08:00" },
        { day: "tuesday" as const, start_time: "06:00", end_time: "08:00" },
        { day: "wednesday" as const, start_time: "06:00", end_time: "08:00" },
        { day: "thursday" as const, start_time: "06:00", end_time: "08:00" },
        { day: "friday" as const, start_time: "06:00", end_time: "08:00" },
        { day: "saturday" as const, start_time: "06:00", end_time: "09:00" },
      ],
      unavailable_days: ["sunday" as const],
      max_session_duration_min: 180,
      allows_double_sessions: false,
      preferred_long_run_day: "saturday" as const,
      strength_sessions_per_week: 2,
      strength_available_days: ["monday" as const, "thursday" as const],
    },
    injury_declarations: [],
    environment_constraints: [],
    travel_constraints: [],
    preferences: [],
    prohibited_arrangements: [],
    active_plan_action: "none" as const,
    user_confirmations: {
      intake_complete: true as const,
      goals_confirmed: true as const,
      availability_confirmed: true as const,
      injury_history_confirmed: true as const,
      constraints_confirmed: true as const,
    },
  };
}

test("request accepts explicit empty constraints in a complete confirmed intake", () => {
  const request = createTestRequest();
  assert.deepEqual(MasterPlanGraphRequest.parse(request), request);
});

test("request accepts an omitted or null race location", () => {
  const request = createTestRequest();
  const goal = request.goals[0];
  assert.ok(goal);
  const { location: _location, ...goalWithoutLocation } = goal;
  const withoutLocation = { ...request, goals: [goalWithoutLocation] };
  assert.equal(MasterPlanGraphRequest.safeParse(withoutLocation).success, true);

  const withNullLocation = {
    ...request,
    goals: [{ ...goal, location: null }],
  };
  assert.equal(MasterPlanGraphRequest.safeParse(withNullLocation).success, true);
});

test("request rejects omitted intake fields and unconfirmed answers", () => {
  const { preferences: _, ...missingPreferences } = createTestRequest();
  assert.equal(MasterPlanGraphRequest.safeParse(missingPreferences).success, false);

  const unconfirmed = createTestRequest();
  const invalidConfirmation = {
    ...unconfirmed,
    user_confirmations: {
      ...unconfirmed.user_confirmations,
      constraints_confirmed: false,
    },
  };
  assert.equal(MasterPlanGraphRequest.safeParse(invalidConfirmation).success, false);
});

test("request rejects ambiguous primary race priorities", () => {
  const request = createTestRequest();
  const ambiguous = {
    ...request,
    goals: [...request.goals, { ...request.goals[0]!, race_name: "上海马拉松", location: "上海" }],
  };

  assert.equal(MasterPlanGraphRequest.safeParse(ambiguous).success, false);
});

test("request rejects malformed race target times instead of treating them as finish-only", () => {
  const request = createTestRequest();
  request.goals[0]!.target_time = "2:50";
  assert.equal(MasterPlanGraphRequest.safeParse(request).success, false);
});

test("outcome accepts minimal non-completed decisions", () => {
  const clarification = {
    decision: "needs_clarification",
    request_id: "request-342",
    generation_id: "generation-342",
    questions: [{ question_id: "q1", intent: "confirm goal" }],
  };
  assert.equal(MasterPlanGraphOutcome.safeParse(clarification).success, true);
});

// ── completed.artifact.weekly_docs（#858 PR-A：首批周课文档进产物）──────────────

/** 跨契约不变量成立的最小 completed 产物（1 阶段 2 周），weekly_docs 挂在第 1 周。 */
function gateCondition() {
  return {
    signal: "race_specific_performance",
    criterion: "完成一次赛专验证课",
    description: "证据门",
    fact_ids: ["goal.a.improvement_pct"],
  };
}

function createCompletedOutcome() {
  return {
    decision: "completed",
    request_id: "request-342",
    generation_id: "generation-342",
    artifact: {
      type: "master_plan_draft",
      activation_status: "inactive",
      plan: {
        status: "draft",
        goal: { race_name: "西安马拉松", distance: "FM", race_date: "2026-10-18", target_time: "2:50:00", timezone: "Asia/Shanghai", location: null },
        start_date: "2026-08-10",
        end_date: "2026-08-23",
        total_weeks: 2,
        phases: [
          {
            name: "base",
            start_date: "2026-08-10",
            end_date: "2026-08-23",
            focus: "建立有氧基础",
            weekly_distance_km_low: 55,
            weekly_distance_km_high: 75,
            key_session_types: ["long_run"],
            milestones: [],
            key_workouts: "周末长跑",
            monitoring_triggers: [],
            coach_note: "循序渐进",
            strength: { sessions_per_week: 2, focus: "核心", timing: "轻松跑后" },
            recovery: { focus: "睡眠", sleep_target_hours: "8", adjustment_trigger: "疲劳" },
            is_completed: false,
            summary: null,
          },
        ],
        weeks: [
          { week_index: 1, week_start: "2026-08-10", phase_name: "base", target_weekly_km_low: 60, target_weekly_km_high: 65, key_sessions: [], is_recovery_week: false },
          { week_index: 2, week_start: "2026-08-17", phase_name: "base", target_weekly_km_low: 60, target_weekly_km_high: 65, key_sessions: [], is_recovery_week: false },
        ],
        training_principles: ["循序渐进"],
        generated_by: "coach_agent",
        version: 1,
        created_at: "2026-08-10T00:00:00Z",
        updated_at: "2026-08-10T00:00:00Z",
      },
      facts: { schema_version: 1, as_of: "2026-08-10T00:00:00Z", facts: [] },
      goal_assessment: {
        schema_version: 2,
        level: "aggressive_but_plausible",
        summary: "合理但有挑战",
        material_conclusions: [{ claim: "goal_requires_improvement", explanation: "需提升", fact_ids: ["goal.a.improvement_pct"] }],
        abc_gates: {
          A: { target: { kind: "time", time_seconds: 10200, label: "2:50:00" }, conditions: [gateCondition()] },
          B: { target: { kind: "time", time_seconds: 10380, label: "2:53:00" }, conditions: [gateCondition()] },
          C: { target: { kind: "finish", time_seconds: null, label: "安全完赛" }, conditions: [gateCondition()] },
        },
        conflicts: [],
        multi_cycle_path: [],
      },
      policy: {
        phases: [
          {
            canonical: "foundation",
            name: "第一阶段·基础期",
            start_week: 1,
            end_week: 2,
            primary_goal: "aerobic_base",
            training_goal: "建立有氧基础",
            block_mode: "progressive",
            rationale: "赛季初有氧储备不足",
          },
        ],
        taper_weeks: 1,
        milestones: [{ phase: "第一阶段·基础期", signal: "周量", criterion: "连续 3 周 ≥60km" }],
        gates: [
          { phase: "第一阶段·基础期", signal: "RHR", criterion: "周均 ≤ 基线+3", action_if_missed: "降周 15%" },
          { phase: "第一阶段·基础期", signal: "体感", criterion: "无持续疲劳", action_if_missed: "转吸收周" },
        ],
        volume_bands: [{ phase: "第一阶段·基础期", weekly_km_min: 55, weekly_km_max: 75 }],
      },
      skeleton: {
        weeks: [
          { week: 1, canonical: "foundation", block: 1, role: "progress", km: 60, lr: 22, q: 1 },
          { week: 2, canonical: "foundation", block: 1, role: "progress", km: 62, lr: 22, q: 1 },
        ],
        blocks: [{ block: 1, canonical: "foundation", start_week: 1, end_week: 2, absorb_weeks: [], boundary: "phase_start" }],
        recovery_policy: [],
        strength_policy: [],
        checks: [],
        milestones: [],
      },
      anchor: { as_of: "2026-08-10", vdot: 52.9, vdot_source: "calibration@2026-08-01", seed: { ctl: 57, atl: 57 }, coefficient_version: "lsq-20261029", projection: { capped: false, residual: 0 } },
      audit: { items: [], summary: { pass: 0, warn: 0, fail: 0 } },
      artifact_revision: 1,
      warnings: [],
    },
  };
}

/** 第 1 周（2026-08-10 周一）的最小合法周课文档（1 run + 1 rest + 7 营养日 + 滚动扩展字段）。 */
function createWeeklyDoc() {
  return {
    schema: "weekly-plan/v1",
    week_name: "2026-08-10_08-16",
    sessions: [
      {
        schema: "plan-session/v1",
        date: "2026-08-11",
        session_index: 0,
        kind: "run",
        summary: "Easy run",
        notes_md: null,
        total_distance_m: 8000,
        total_duration_s: 2880,
        estimated_dose: 47.2,
        spec: null,
      },
    ],
    nutrition: Array.from({ length: 7 }, (_, index) => ({
      schema: "plan-nutrition/v1",
      date: `2026-08-1${index}`,
      kcal_target: null,
      carbs_g: null,
      protein_g: null,
      fat_g: null,
      water_ml: null,
      meals: [],
      notes_md: null,
    })),
    notes_md: null,
    coach_notes: "建立有氧基础；第 1 周（progress）",
    week_index: 1,
    phase_name: "base",
    phase_goal: "建立有氧基础（赛季初有氧储备不足）",
    target_weekly_km_low: 60,
    target_weekly_km_high: 60,
    is_recovery_week: false,
    planned_dose: 210.5,
    load_ratio_projection: null,
    km_deviation_pct: 0,
    source: "llm",
  };
}

test("completed artifact carries weekly_docs through a parse/serialize round-trip (#858)", () => {
  const outcome = createCompletedOutcome() as Record<string, unknown> & { artifact: Record<string, unknown> };
  outcome.artifact.weekly_docs = [createWeeklyDoc()];
  const parsed = MasterPlanGraphOutcome.parse(outcome);
  assert.equal(parsed.decision, "completed");
  if (parsed.decision !== "completed") return;
  assert.equal(parsed.artifact.weekly_docs?.length, 1);
  assert.equal(parsed.artifact.weekly_docs?.[0]?.week_index, 1);
  assert.equal(parsed.artifact.weekly_docs?.[0]?.km_deviation_pct, 0);
  // JSON 序列化（result_json/落库通道）后再次 parse，滚动扩展字段原样往返。
  const round = MasterPlanGraphOutcome.parse(JSON.parse(JSON.stringify(parsed)));
  if (round.decision !== "completed") throw new Error("round-trip lost decision");
  assert.deepEqual(round.artifact.weekly_docs, parsed.artifact.weekly_docs);
});

test("weekly_docs stays optional and rejects malformed docs", () => {
  assert.equal(MasterPlanGraphOutcome.safeParse(createCompletedOutcome()).success, true);
  const malformed = createCompletedOutcome() as Record<string, unknown> & { artifact: Record<string, unknown> };
  malformed.artifact.weekly_docs = [{ schema: "weekly-plan/v1" }];
  assert.equal(MasterPlanGraphOutcome.safeParse(malformed).success, false);
});
