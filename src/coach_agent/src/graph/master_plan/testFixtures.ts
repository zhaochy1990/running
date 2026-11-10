import { addDays } from "@stride/contract";
import { deriveAssessmentFacts } from "./assessment.js";

export function createTestRequest() {
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

export function structuredRun(name: string, date: string, distanceM: number, paceSPerKm: number) {
  return {
    schema: "run-workout/v1" as const,
    name,
    date,
    note: null,
    blocks: [
      {
        repeat: 1,
        steps: [
          {
            step_kind: "work" as const,
            duration: { kind: "distance_m" as const, value: distanceM },
            target: {
              kind: "pace_s_km" as const,
              low: paceSPerKm,
              high: paceSPerKm,
            },
            note: null,
            hr_cap_bpm: null,
          },
        ],
      },
    ],
  };
}

export function createTestMasterPlan() {
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
    total_weeks: 2,
    phases: [
      {
        name: "base" as const,
        start_date: "2026-08-10",
        end_date: "2026-08-16",
        focus: "建立赛季起点",
        weekly_distance_km_low: 70,
        weekly_distance_km_high: 80,
        key_session_types: ["long_run"],
        milestones: [],
        key_workouts: "周末长跑",
        monitoring_triggers: ["疼痛加重时降量"],
        coach_note: "保持恢复",
        strength: {
          sessions_per_week: 2,
          focus: "核心和下肢耐力",
          timing: "轻松跑后",
        },
        recovery: {
          focus: "睡眠和补给",
          sleep_target_hours: "7-9",
          adjustment_trigger: "疼痛或睡眠恶化",
        },
        is_completed: false,
        summary: null,
      },
      {
        name: "taper" as const,
        start_date: "2026-08-17",
        end_date: "2026-08-23",
        focus: "目标比赛",
        weekly_distance_km_low: 42.195,
        weekly_distance_km_high: 50,
        key_session_types: ["race"],
        milestones: [
          {
            type: "race" as const,
            date: "2026-08-23",
            target: "测试比赛",
            completed_actual: null,
          },
        ],
        key_workouts: "目标比赛",
        monitoring_triggers: ["异常时停止"],
        coach_note: "比赛周",
        strength: { sessions_per_week: 0, focus: "无", timing: "无" },
        recovery: {
          focus: "恢复",
          sleep_target_hours: "7-9",
          adjustment_trigger: "疼痛",
        },
        is_completed: false,
        summary: null,
      },
    ],
    weeks: [
      {
        week_index: 1,
        week_start: "2026-08-10",
        phase_name: "base" as const,
        target_weekly_km_low: 70,
        target_weekly_km_high: 80,
        key_sessions: [
          {
            type: "long_run" as const,
            distance_km: 24,
            duration_min: null,
            intensity: "Z2 endurance",
            purpose: "建立耐力",
            workout_structure: structuredRun("24km long run", "2026-08-15", 24000, 300),
          },
        ],
        is_recovery_week: false,
      },
      {
        week_index: 2,
        week_start: "2026-08-17",
        phase_name: "taper" as const,
        target_weekly_km_low: 42.195,
        target_weekly_km_high: 50,
        key_sessions: [
          {
            type: "race" as const,
            distance_km: 42.195,
            duration_min: 170,
            intensity: "目标比赛",
            purpose: "完成目标比赛",
            workout_structure: structuredRun("西安马拉松", "2026-08-23", 42195, 242),
          },
        ],
        is_recovery_week: false,
      },
    ],
    training_principles: ["循序渐进", "长跑练习碳水、液体与电解质补给"],
    generated_by: "coach_agent" as const,
    version: 1 as const,
    created_at: "2026-08-10T00:00:00Z",
    updated_at: "2026-08-10T00:00:00Z",
  };
}

export function createAssessmentSnapshot() {
  return {
    user: {
      id: "athlete-344",
      profile: {
        display_name: null,
        dob: null,
        sex: null,
        height_cm: null,
        weight_kg: 70,
        running_age_range: null,
      },
    },
    injuries: [],
    personal_bests: [
      {
        distance: "FM",
        time_sec: 10631,
        achieved_at: "2026-03-01",
        activity_label_id: "activity-fm-pb",
      },
    ],
    running_calibration: {
      as_of_date: "2026-08-10",
      threshold_hr: 172,
      threshold_speed_mps: 4.25,
      rhr_baseline: 50,
      threshold_hr_confidence: "high",
      threshold_speed_confidence: "high",
      heart_rate_zones: [],
      pace_zones: [
        {
          name: "easy",
          minPaceSPerKm: 1000 / (4.25 * 0.84),
          maxPaceSPerKm: 1000 / (4.25 * 0.72),
        },
        {
          name: "marathon",
          minPaceSPerKm: 1000 / (4.25 * 0.97),
          maxPaceSPerKm: 1000 / (4.25 * 0.84),
        },
        {
          name: "threshold",
          minPaceSPerKm: 1000 / (4.25 * 1.03),
          maxPaceSPerKm: 1000 / (4.25 * 0.97),
        },
        {
          name: "interval",
          minPaceSPerKm: 1000 / (4.25 * 1.11),
          maxPaceSPerKm: 1000 / (4.25 * 1.03),
        },
      ],
    },
    race_history: [],
    macro_history: {
      start_date: "2024-08-10",
      end_date: "2026-08-10",
      months: [],
      peak_weekly_distance_km: 92,
      longest_run_km: 32,
      longest_road_run_km: 32,
      gap_periods: [{ start_date: "2025-01-01", end_date: "2025-01-18", days: 18 }],
      consistency_pct: 84,
    },
    recent_history: {
      start_date: "2026-06-15",
      end_date: "2026-08-10",
      weeks: [
        {
          week_start: "2026-06-15",
          distance_km: 58,
          hours: 5,
          avg_pace_s_km: 310,
          avg_hr: 140,
          run_count: 5,
          run_day_count: 5,
          long_run_km: 20,
          speed_session_count: 1,
          race_count: 0,
          training_dose: 400,
          ctl: 61,
          atl: 62,
          form: -1,
          rhr: 48,
          hrv: 58,
        },
        {
          week_start: "2026-06-22",
          distance_km: 62,
          hours: 5.4,
          avg_pace_s_km: 308,
          avg_hr: 141,
          run_count: 5,
          run_day_count: 5,
          long_run_km: 22,
          speed_session_count: 1,
          race_count: 0,
          training_dose: 430,
          ctl: 63,
          atl: 65,
          form: -2,
          rhr: 48,
          hrv: 57,
        },
        {
          week_start: "2026-06-29",
          distance_km: 66,
          hours: 5.7,
          avg_pace_s_km: 306,
          avg_hr: 141,
          run_count: 6,
          run_day_count: 6,
          long_run_km: 24,
          speed_session_count: 2,
          race_count: 0,
          training_dose: 450,
          ctl: 65,
          atl: 68,
          form: -3,
          rhr: 49,
          hrv: 55,
        },
        {
          week_start: "2026-07-06",
          distance_km: 70,
          hours: 6,
          avg_pace_s_km: 305,
          avg_hr: 142,
          run_count: 6,
          run_day_count: 6,
          long_run_km: 26,
          speed_session_count: 2,
          race_count: 0,
          training_dose: 470,
          ctl: 66,
          atl: 70,
          form: -4,
          rhr: 49,
          hrv: 54,
        },
        {
          week_start: "2026-07-13",
          distance_km: 68,
          hours: 5.9,
          avg_pace_s_km: 306,
          avg_hr: 141,
          run_count: 5,
          run_day_count: 5,
          long_run_km: 24,
          speed_session_count: 1,
          race_count: 0,
          training_dose: 460,
          ctl: 66,
          atl: 69,
          form: -3,
          rhr: 48,
          hrv: 56,
        },
        {
          week_start: "2026-07-20",
          distance_km: 72,
          hours: 6.2,
          avg_pace_s_km: 304,
          avg_hr: 142,
          run_count: 6,
          run_day_count: 6,
          long_run_km: 26,
          speed_session_count: 2,
          race_count: 0,
          training_dose: 485,
          ctl: 67,
          atl: 72,
          form: -5,
          rhr: 49,
          hrv: 54,
        },
        {
          week_start: "2026-07-27",
          distance_km: 74,
          hours: 6.3,
          avg_pace_s_km: 303,
          avg_hr: 142,
          run_count: 6,
          run_day_count: 6,
          long_run_km: 28,
          speed_session_count: 2,
          race_count: 0,
          training_dose: 500,
          ctl: 68,
          atl: 75,
          form: -7,
          rhr: 49,
          hrv: 53,
        },
        {
          week_start: "2026-08-03",
          distance_km: 64,
          hours: 5.5,
          avg_pace_s_km: 309,
          avg_hr: 140,
          run_count: 5,
          run_day_count: 5,
          long_run_km: 22,
          speed_session_count: 1,
          race_count: 0,
          training_dose: 420,
          ctl: 68,
          atl: 74,
          form: -6,
          rhr: 48,
          hrv: 56,
        },
      ],
    },
    fitness_state: { as_of_date: "2026-08-10", ctl: 68, atl: 74, form: -6 },
    body_composition: {
      weight_kg: 70,
      body_fat_pct: 14,
      skeletal_muscle_kg: 34,
    },
    active_plan: null,
    current_phase: null,
    continuity: {
      active_plan_continuation: false,
      last_activity_date: "2026-08-09",
      days_since_last_run: 1,
    },
    coverage: [
      { domain: "activities", status: "complete" as const, detail: null },
      { domain: "training_load", status: "complete" as const, detail: null },
      { domain: "personal_bests", status: "complete" as const, detail: null },
      {
        domain: "injuries",
        status: "missing" as const,
        detail: "no canonical records",
      },
    ],
    plan_start: "2026-08-10",
    as_of: "2026-08-10T00:00:00Z",
  };
}

export function createTestGoalAssessment() {
  const conditions = (fact_id: string) => [
    {
      signal: "race_specific_performance" as const,
      criterion: "Complete a race-specific validation effort at the required level",
      description: "Evidence gate",
      fact_ids: [fact_id],
    },
  ];
  return {
    schema_version: 2 as const,
    level: "aggressive_but_plausible" as const,
    summary: "Aggressive but plausible goal",
    material_conclusions: [
      {
        claim: "goal_requires_improvement" as const,
        explanation: "Goal requires improvement",
        fact_ids: ["goal.a.improvement_pct"],
      },
    ],
    abc_gates: {
      A: {
        target: {
          kind: "time" as const,
          time_seconds: 10200,
          label: "2:50:00",
        },
        conditions: conditions("goal.a.improvement_pct"),
      },
      B: {
        target: {
          kind: "time" as const,
          time_seconds: 10380,
          label: "2:53:00",
        },
        conditions: conditions("goal.a.matching_pb_seconds"),
      },
      C: {
        target: {
          kind: "finish" as const,
          time_seconds: null,
          label: "Safe completion",
        },
        conditions: conditions("load.current_form"),
      },
    },
    conflicts: [],
    multi_cycle_path: [],
  };
}

/**
 * v3 completed 产物的最小合法样本（worker runner 测试用）：政策包四段 + 首期快照，
 * 四条跨契约不变量都成立。故意只有 1 阶段 1 周——runner 只关心 outcome 的搬运。
 * `weeklyDocs` > 0 时按 #858 附上首批周课文档（第 1..N 周，planStart=2026-08-10）。
 */
export function createTestWeeklyPlanDoc(weekIndex: number) {
  const weekStart = addDays("2026-08-10", (weekIndex - 1) * 7);
  const weekEnd = addDays(weekStart, 6);
  const folder = `${weekStart}_${weekEnd.slice(5)}`;
  const restOfDay = (offset: number) => ({
    schema: "plan-session/v1" as const,
    date: addDays(weekStart, offset),
    session_index: 0,
    kind: "rest" as const,
    summary: "休息",
    notes_md: null,
    total_distance_m: null,
    total_duration_s: null,
    estimated_dose: null,
    spec: null,
  });
  return {
    schema: "weekly-plan/v1" as const,
    week_name: folder,
    sessions: [
      {
        schema: "plan-session/v1" as const,
        date: weekStart,
        session_index: 0,
        kind: "run" as const,
        summary: "有氧跑",
        notes_md: null,
        total_distance_m: 8000,
        total_duration_s: 2880,
        estimated_dose: 47.2,
        spec: null,
      },
      ...Array.from({ length: 6 }, (_, offset) => restOfDay(offset + 1)),
    ],
    nutrition: Array.from({ length: 7 }, (_, offset) => ({
      schema: "plan-nutrition/v1" as const,
      date: addDays(weekStart, offset),
      kcal_target: null,
      carbs_g: null,
      protein_g: null,
      fat_g: null,
      water_ml: null,
      meals: [],
      notes_md: null,
    })),
    notes_md: null,
    coach_notes: `建立有氧基础；第 ${weekIndex} 周（progress）`,
    week_index: weekIndex,
    phase_name: "base",
    phase_goal: "建立有氧基础（赛季初有氧储备不足）",
    target_weekly_km_low: 65,
    target_weekly_km_high: 65,
    is_recovery_week: false,
    planned_dose: 210.5,
    load_ratio_projection: null,
    km_deviation_pct: 0,
    source: "llm" as const,
  };
}

export function createTestCompletedOutcomeV3(
  overrides: { totalWeeks?: number; revision?: number; weeklyDocs?: number } = {},
) {
  const weeks = overrides.totalWeeks ?? 1;
  const plan = createTestMasterPlan();
  const single = {
    ...plan,
    start_date: "2026-08-10",
    end_date: addDays("2026-08-10", weeks * 7 - 1),
    total_weeks: weeks,
    phases: [
      {
        ...plan.phases[0]!,
        start_date: "2026-08-10",
        end_date: addDays("2026-08-10", weeks * 7 - 1),
      },
    ],
    weeks: Array.from({ length: weeks }, (_, index) => ({
      week_index: index + 1,
      week_start: addDays("2026-08-10", index * 7),
      phase_name: "base" as const,
      target_weekly_km_low: 60,
      target_weekly_km_high: 70,
      key_sessions: [],
      is_recovery_week: false,
    })),
  };
  const skeletonWeeks = single.weeks.map((week) => ({
    week: week.week_index,
    canonical: "foundation" as const,
    block: 1,
    role: "progress" as const,
    km: 65,
    lr: 24,
    q: 1,
  }));
  return {
    decision: "completed" as const,
    request_id: "request-342",
    generation_id: "plan-job-1",
    artifact: {
      type: "master_plan_draft" as const,
      activation_status: "inactive" as const,
      plan: single,
      facts: testAssessmentFacts(),
      goal_assessment: createTestGoalAssessment(),
      policy: {
        phases: [
          {
            canonical: "foundation" as const,
            name: "第一阶段·基础期",
            start_week: 1,
            end_week: weeks,
            primary_goal: "aerobic_base" as const,
            training_goal: "建立有氧基础",
            block_mode: "progressive" as const,
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
        weeks: skeletonWeeks,
        blocks: [
          { block: 1, canonical: "foundation" as const, start_week: 1, end_week: weeks, absorb_weeks: [], boundary: "phase_start" as const },
        ],
        recovery_policy: [{ id: "normal" as const, trigger: "体感正常", action: "常规递进", depth: "+3~8%/块" }],
        strength_policy: [
          { canonical: "foundation" as const, strength_focus: "基础力量", quality_family: "E 为主", strides_note: "不计质量课" },
        ],
        checks: [{ id: "acwr", pass: true, detail: "1.12 ≤ 1.3" }],
        milestones: [{ phase: "第一阶段·基础期", signal: "周量", criterion: "连续 3 周 ≥60km", week: weeks }],
      },
      anchor: {
        as_of: "2026-08-10",
        vdot: 52.9,
        vdot_source: "calibration@2026-08-01",
        seed: { ctl: 57, atl: 57 },
        coefficient_version: "lsq-20261029",
        projection: { capped: false, residual: 0 },
      },
      audit: {
        items: [{ item: "W1 Q 配额", verdict: "pass" as const, expectation: "进度周 1 节 T", actual: "1 节 T" }],
        summary: { pass: 1, warn: 0, fail: 0 },
      },
      ...(overrides.weeklyDocs != null && overrides.weeklyDocs > 0
        ? { weekly_docs: Array.from({ length: overrides.weeklyDocs }, (_, index) => createTestWeeklyPlanDoc(index + 1)) }
        : {}),
      artifact_revision: overrides.revision ?? 1,
      warnings: [],
    },
  };
}

/** completed 产物里的 AssessmentFacts：从测试快照确定性推导（与 kernel 同源）。 */
function testAssessmentFacts() {
  return deriveAssessmentFacts(createAssessmentSnapshot(), createTestRequest());
}
