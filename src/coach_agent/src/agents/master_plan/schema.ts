import { z } from "zod/v4";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UTC_ISO = /(?:Z|[+-]00:00)$/;

const MilestoneSchema = z.object({
  type: z.enum(["race", "test_run", "long_run", "strength_test", "body_composition"]),
  date: z.string().regex(DAY),
  target: z.string(),
  completed_actual: z.string().nullable(),
});

const StrengthSchema = z.object({
  sessions_per_week: z.int().nonnegative(),
  focus: z.string(),
  timing: z.string(),
});

const RecoverySchema = z.object({
  focus: z.string(),
  sleep_target_hours: z.string(),
  adjustment_trigger: z.string(),
});

const PhaseSchema = z.object({
  name: z.enum(["基础期", "提升期", "专项速度周期", "马拉松专项期", "赛前减量期", "赛后恢复期"]),
  start_date: z.string().regex(DAY),
  end_date: z.string().regex(DAY),
  focus: z.string(),
  weekly_distance_km_low: z.number().nonnegative(),
  weekly_distance_km_high: z.number().nonnegative(),
  key_session_types: z.array(z.string()),
  milestones: z.array(MilestoneSchema),
  key_workouts: z.string(),
  monitoring_triggers: z.array(z.string()),
  coach_note: z.string(),
  strength: StrengthSchema,
  recovery: RecoverySchema,
  is_completed: z.boolean(),
  summary: z.string().nullable(),
}).superRefine((phase, ctx) => {
  if (!phase.is_completed && phase.summary !== null) {
    ctx.addIssue({ code: "custom", path: ["summary"], message: "must be null for an incomplete phase" });
  }
});

const KeySessionSchema = z.object({
  type: z.string(),
  distance_km: z.number().nonnegative().nullable(),
  duration_min: z.number().nonnegative().nullable(),
  intensity: z.string().nullable(),
  purpose: z.string().nullable(),
});

const WeekSchema = z.object({
  week_index: z.int().positive(),
  week_start: z.string().regex(DAY),
  phase_name: PhaseSchema.shape.name,
  target_weekly_km_low: z.number().nonnegative(),
  target_weekly_km_high: z.number().nonnegative(),
  key_sessions: z.array(KeySessionSchema),
  is_recovery_week: z.boolean(),
});

/** Canonical machine-enforced contract for newly generated season plans. */
export const MasterPlanSchema = z.object({
  status: z.literal("draft"),
  goal: z.object({
    race_name: z.string(),
    distance: z.enum(["FM", "HM"]),
    race_date: z.string().regex(DAY),
    target_time: z.string(),
    timezone: z.literal("Asia/Shanghai"),
    location: z.string().min(1),
  }),
  start_date: z.string().regex(DAY),
  end_date: z.string().regex(DAY),
  total_weeks: z.int().positive(),
  phases: z.array(PhaseSchema).min(1),
  weeks: z.array(WeekSchema).min(1),
  training_principles: z.array(z.string()).min(1),
  generated_by: z.literal("coach_agent"),
  version: z.literal(1),
  created_at: z.string().regex(UTC_ISO),
  updated_at: z.string().regex(UTC_ISO),
}).superRefine((plan, ctx) => {
  if (plan.total_weeks !== plan.weeks.length) {
    ctx.addIssue({ code: "custom", path: ["total_weeks"], message: "must equal weeks.length" });
  }
  if (new Set(plan.phases.map((phase) => phase.name)).size !== plan.phases.length) {
    ctx.addIssue({ code: "custom", path: ["phases"], message: "phase names must be unique" });
  }
  for (const [index, week] of plan.weeks.entries()) {
    if (week.week_index !== index + 1) {
      ctx.addIssue({ code: "custom", path: ["weeks", index, "week_index"], message: "must be consecutive from 1" });
    }
  }
});

export type MasterPlan = z.infer<typeof MasterPlanSchema>;
