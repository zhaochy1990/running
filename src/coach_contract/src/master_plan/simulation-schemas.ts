import { z } from "zod/v4";

const DailyDistributionSchema = z
  .array(z.number().min(0).max(1))
  .length(7)
  .refine((shares) => Math.abs(shares.reduce((sum, share) => sum + share, 0) - 1) < 1e-9, "daily distribution must sum to 1");
export const SimulationWeekSchema = z
  .object({
    week_index: z.int().positive(),
    week_start: z.string(),
    estimated: z.literal(true),
    provenance: z.enum(["weekly_high_target+key_sessions+remaining_easy_volume", "partial_current_week+weekly_high_target+key_sessions+remaining_easy_volume"]),
    confidence: z.enum(["high", "medium", "low"]),
    daily_distribution: DailyDistributionSchema,
    estimated_dose: z.number().nullable(),
    estimated_dose_low: z.number().nullable(),
    estimated_dose_high: z.number().nullable(),
    load_assumptions: z.array(z.string()),
    missing_dose_reason: z.string().nullable(),
    end_ctl: z.number().nullable(),
    end_atl: z.number().nullable(),
    end_form: z.number().nullable(),
    ratio: z.number().nullable(),
    long_run_dose_share: z.number().nullable(),
  })
  .strict();
export const SimulationReportSchema = z
  .object({
    algorithm_version: z.literal("master-plan-load-v3"),
    estimated: z.literal(true),
    provenance: z.string(),
    weeks: z.array(SimulationWeekSchema),
  })
  .strict();
export type SimulationReport = z.infer<typeof SimulationReportSchema>;
export type SimulationWeek = z.infer<typeof SimulationWeekSchema>;
