import { z } from "zod/v4";
import { PhaseNameSchema } from "../master_plan/schemas.js";
import { WeeklyPlanSchema } from "./schema.js";
import { WeeklyPlanSimulationReportSchema } from "./simulation.js";

export type PhaseName = z.infer<typeof PhaseNameSchema>;

const identifier = z.string().min(1);

export const WeeklyPlanGeneratorRequest = z
  .object({
    request_id: identifier,
    requested_as_of: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type WeeklyPlanGeneratorRequest = z.infer<typeof WeeklyPlanGeneratorRequest>;

export const WeeklyPlanGeneratorContext = z
  .object({
    userId: identifier,
    generationId: identifier,
  })
  .strict();
export type WeeklyPlanGeneratorContext = z.infer<typeof WeeklyPlanGeneratorContext>;

export const RecoveryTrendSchema = z
  .object({
    available: z.boolean(),
    recent_rhr_avg: z.number().nonnegative().nullable(),
    prior_rhr_avg: z.number().nonnegative().nullable(),
    recent_hrv_avg: z.number().nonnegative().nullable(),
    prior_hrv_avg: z.number().nonnegative().nullable(),
    rhr_rising: z.boolean(),
    hrv_falling: z.boolean(),
    deteriorating: z.boolean(),
    window_days: z.int().nonnegative(),
    missing_reason: z.string().nullable(),
  })
  .strict();

export const TargetTrainingLoadSchema = z
  .object({
    available: z.boolean(),
    missing_reason: z.string().nullable(),
    load_decision: z.enum(["increase", "maintain", "decrease", "recover"]).nullable(),
    training_load_low: z.number().nonnegative().nullable(),
    training_load_high: z.number().nonnegative().nullable(),
    target_distance_km_low: z.number().nonnegative().nullable(),
    target_distance_km_high: z.number().nonnegative().nullable(),
    load_ratio_low: z.number().nullable(),
    load_ratio_high: z.number().nullable(),
    remove_quality_stimulus: z.boolean(),
    details: z
      .object({
        last_complete_week: z
          .object({
            week_start: z.string(),
            distance_km: z.number().nonnegative().nullable(),
            training_load: z.number().nonnegative().nullable(),
          })
          .strict()
          .nullable(),
        anchor: z
          .object({
            training_load_avg4w: z.number().nonnegative().nullable(),
            distance_km_avg4w: z.number().nonnegative().nullable(),
          })
          .strict(),
        trend: z
          .object({
            recovery: RecoveryTrendSchema.nullable(),
            seven_day_average: z
              .object({
                rhr: z.number().nonnegative().nullable(),
                hrv: z.number().nonnegative().nullable(),
              })
              .strict(),
            current_load_ratio: z.number().nonnegative().nullable(),
            form: z.number().nullable(),
            is_recovery_week: z.boolean(),
            recovery_week_overridden: z.boolean(),
            activity_restricted: z.boolean(),
            recent_high_cost_training: z.boolean(),
          })
          .strict(),
        rationale: z.array(z.string()),
      })
      .strict(),
  })
  .strict();
export type TargetTrainingLoad = z.infer<typeof TargetTrainingLoadSchema>;

export const WeeklyPlanGeneratorOutcome = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("completed"),
      request_id: identifier,
      generation_id: identifier,
      phase: PhaseNameSchema,
      weekly_plan: WeeklyPlanSchema,
      target_training_load: TargetTrainingLoadSchema,
      simulation: WeeklyPlanSimulationReportSchema,
      generation_attempts: z.int().positive(),
    })
    .strict(),
  z
    .object({
      decision: z.literal("infrastructure_failure"),
      request_id: identifier,
      generation_id: identifier,
      reason: z.literal("context_snapshot_unavailable"),
    })
    .strict(),
  z
    .object({
      decision: z.literal("quality_failure"),
      request_id: identifier,
      generation_id: identifier,
      reason: z.enum(["phase_unresolvable", "generation_failed", "load_mismatch_unresolved"]),
    })
    .strict(),
]);
export type WeeklyPlanGeneratorOutcome = z.infer<typeof WeeklyPlanGeneratorOutcome>;
