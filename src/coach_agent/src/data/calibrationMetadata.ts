/** Read-only projections of the Go-owned calibration metadata contract. */
import { z } from "zod/v4";
import type { RunningCalibration } from "./dataProvider.js";

// Match Go encoding/json zero values and the bounded reader contract. Empty
// omitempty fields disappear; missing evidence remains missing, never inferred.
const text = z
  .string()
  .nullish()
  .transform((value) =>
    Array.from(value ?? "")
      .slice(0, 256)
      .join(""),
  );
const optionalText = text.transform((value) => value || undefined).optional();
const integer = z
  .number()
  .int()
  .nullish()
  .transform((value) => value ?? 0);
const optionalNumber = z
  .number()
  .nullish()
  .transform((value) => value ?? undefined)
  .optional();
const strings = z
  .array(text)
  .nullish()
  .transform((value) => value?.slice(0, 16) ?? null);
const evidence = z.object({
  activity_id: text,
  root_activity_id: text,
  activity_day: text,
  source_version: text,
  evidence_ref: optionalText,
  duration_s: optionalNumber.transform((value) => value || undefined).optional(),
  start_s: optionalNumber,
  end_s: optionalNumber,
  measurement_quality: text,
  effort_support: text,
});
const metric = z.object({
  method: text,
  target_type: text,
  measurement_quality: text,
  effort_support: text,
  support: text,
  range_low: optionalNumber,
  range_high: optionalNumber,
  range_meaning: text,
  evidence_date: optionalText,
  latest_rejected_evidence_date: optionalText,
  independent_activities: integer,
  independent_days: integer,
  lab_method: optionalText,
  reasons: strings,
  limitations: strings,
  evidence: z
    .array(evidence)
    .nullish()
    .transform((value) => (value?.length ? value.slice(0, 16) : undefined))
    .optional(),
  evidence_count: integer,
});
export const CalibrationSourceSchema = z
  .object({
    schema_version: integer,
    state: text,
    strategy: optionalText,
    implementation: optionalText,
    parameter_version: optionalText,
    data_cutoff_day: optionalText,
    availability_semantics: optionalText,
    fingerprint: optionalText,
    speed: metric
      .nullish()
      .transform((value) => value ?? undefined)
      .optional(),
    hr: metric
      .nullish()
      .transform((value) => value ?? undefined)
      .optional(),
  })
  .transform((value) => JSON.parse(JSON.stringify(value)) as typeof value);
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
