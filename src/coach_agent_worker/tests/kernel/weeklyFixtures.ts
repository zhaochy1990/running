import { addDays, type WeeklyPlan, weekFolder } from "@stride/contract";

/**
 * Shared schema-valid weekly-plan fixtures for the worker's weekly kernel /
 * handler tests. Parameterized by `weekStart` (a Monday) so the handler test
 * can build a plan for the *current* Shanghai week (its week guard runs against
 * the real clock) while the kernel test uses a fixed historical week.
 */

export function weekDates(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
}

export function buildWeeklyPlan(weekStart: string): WeeklyPlan {
  const dates = weekDates(weekStart);
  return {
    schema: "weekly-plan/v1",
    week_name: weekFolder(weekStart),
    sessions: [
      {
        schema: "plan-session/v1",
        date: dates[0]!,
        session_index: 0,
        summary: "structured run",
        notes_md: null,
        total_distance_m: 10_000,
        total_duration_s: null,
        estimated_dose: null,
        kind: "run",
        spec: {
          schema: "run-workout/v1",
          name: "structured run",
          date: dates[0]!,
          note: null,
          blocks: [
            {
              repeat: 1,
              steps: [
                {
                  step_kind: "work",
                  duration: { kind: "distance_m", value: 10_000 },
                  target: { kind: "pace_s_km", low: 330, high: 330 },
                  note: null,
                  hr_cap_bpm: null,
                },
              ],
            },
          ],
        },
      },
      {
        schema: "plan-session/v1",
        date: dates[1]!,
        session_index: 0,
        summary: "rest",
        notes_md: null,
        total_distance_m: null,
        total_duration_s: null,
        estimated_dose: null,
        kind: "rest",
        spec: null,
      },
    ],
    nutrition: dates.map((date) => ({
      schema: "plan-nutrition/v1",
      date,
      kcal_target: null,
      carbs_g: null,
      protein_g: null,
      fat_g: null,
      water_ml: null,
      meals: [],
      notes_md: null,
    })),
    notes_md: null,
    coach_notes: "test",
  };
}

export function buildCompletedOutcome(weekStart: string): {
  decision: "completed";
  request_id: string;
  generation_id: string;
  phase: "base";
  weekly_plan: WeeklyPlan;
  target_training_load: unknown;
  simulation: unknown;
  generation_attempts: number;
} {
  const dates = weekDates(weekStart);
  return {
    decision: "completed",
    request_id: "req-1",
    generation_id: "plan-job-1",
    phase: "base",
    weekly_plan: buildWeeklyPlan(weekStart),
    target_training_load: {
      available: true,
      missing_reason: null,
      load_decision: "maintain",
      training_load_low: 40,
      training_load_high: 60,
      target_distance_km_low: 30,
      target_distance_km_high: 45,
      load_ratio_low: 0.8,
      load_ratio_high: 1.2,
      remove_quality_stimulus: false,
      details: {
        last_complete_week: null,
        anchor: { training_load_avg4w: 50, distance_km_avg4w: 35 },
        trend: {
          recovery: null,
          seven_day_average: { rhr: 50, hrv: 60 },
          current_load_ratio: 1,
          form: 5,
          is_recovery_week: false,
          recovery_week_overridden: false,
          activity_restricted: false,
          recent_high_cost_training: false,
        },
        rationale: [],
      },
    },
    simulation: {
      algorithm_version: "weekly-plan-load-v1",
      estimated: true,
      provenance: "test",
      available: true,
      week_start: weekStart,
      initial_pmc_date: addDays(weekStart, -28),
      total_dose: 50,
      total_dose_low: 45,
      total_dose_high: 55,
      maximum_session_dose_share: 0.3,
      sessions: [],
      days: dates.map((date) => ({
        date,
        estimated_dose: 7.14,
        estimated_dose_low: 6.4,
        estimated_dose_high: 7.9,
        end_ctl: null,
        end_atl: null,
        end_form: null,
        load_ratio: null,
      })),
      load_assumptions: [],
      missing_dose_reasons: [],
      safety_issues: [],
    },
    generation_attempts: 1,
  };
}
