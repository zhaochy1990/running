/** Read-only projections of the Go-owned calibration metadata contract. */
import { z } from "zod/v4";
import type { RunningCalibration } from "./dataProvider.js";

const evidence = z.object({
  activity_id: z.string(),
  root_activity_id: z.string(),
  activity_day: z.string(),
  source_version: z.string(),
  evidence_ref: z.string().optional(),
  duration_s: z.number().optional(),
  start_s: z.number().optional(),
  end_s: z.number().optional(),
  measurement_quality: z.string(),
  effort_support: z.string(),
});
const metric = z.object({
  method: z.string(),
  target_type: z.string(),
  measurement_quality: z.string(),
  effort_support: z.string(),
  support: z.string(),
  range_low: z.number().optional(),
  range_high: z.number().optional(),
  range_meaning: z.string(),
  evidence_date: z.string().optional(),
  independent_activities: z.number(),
  independent_days: z.number(),
  lab_method: z.string().optional(),
  reasons: z.array(z.string()).nullable(),
  limitations: z.array(z.string()).nullable(),
  evidence: z.array(evidence).optional(),
  evidence_count: z.number(),
});
export const CalibrationSourceSchema = z.object({
  schema_version: z.number().int().default(0),
  state: z.string().default(""),
  strategy: z.string().optional(),
  implementation: z.string().optional(),
  parameter_version: z.string().optional(),
  data_cutoff_day: z.string().optional(),
  availability_semantics: z.string().optional(),
  fingerprint: z.string().optional(),
  speed: metric.optional(),
  hr: metric.optional(),
});
export const CalibrationSelectionSchema = z.object({
  mode: z.enum(["active", "candidate"]),
  policy_revision: z.number().int().nonnegative(),
  requested_version: z.number().int().nullable(),
  effective_version: z.number().int().nullable(),
  state: z.enum(["selected", "fallback", "unavailable"]),
  reason: z.string().optional(),
});
export type CalibrationSource = z.infer<typeof CalibrationSourceSchema>;
export type CalibrationSelection = z.infer<typeof CalibrationSelectionSchema>;

export const CalibrationMetadataShape = {
  calibration_id: z.number().optional(),
  algorithm_version: z.number().optional(),
  computed_at: z.string().optional(),
  selection: CalibrationSelectionSchema.optional(),
  source: CalibrationSourceSchema.optional(),
  fingerprint: z.string().optional(),
};
export function calibrationMetadataShape(c: RunningCalibration | null) {
  return {
    ...(c?.calibrationId === undefined ? {} : { calibration_id: c.calibrationId }),
    ...(c?.algorithmVersion === undefined ? {} : { algorithm_version: c.algorithmVersion }),
    ...(c?.computedAt === undefined ? {} : { computed_at: c.computedAt }),
    ...(c?.selection === undefined ? {} : { selection: c.selection }),
    ...(c?.source === undefined ? {} : { source: c.source }),
    ...(c?.fingerprint === undefined ? {} : { fingerprint: c.fingerprint }),
  };
}
