import { z } from "zod/v4";

const FactValueSchema = z.union([z.number(), z.string(), z.boolean(), z.null()]);
const FactSchema = z
  .object({
    fact_id: z.string().min(1),
    value: FactValueSchema,
    unit: z.string().min(1),
    source: z.string().min(1),
    confidence: z.enum(["high", "medium", "low", "unavailable"]),
  })
  .strict();

export const AssessmentFactsSchema = z
  .object({
    schema_version: z.literal(1),
    as_of: z.string().datetime({ offset: true }),
    facts: z.array(FactSchema),
  })
  .strict();
export type AssessmentFacts = z.infer<typeof AssessmentFactsSchema>;
export type Fact = z.infer<typeof FactSchema>;

const AthleteClaimSchema = z.enum([
  "volume_baseline_established",
  "long_run_tolerance_established",
  "quality_tolerance_established",
  "availability_requires_adjustment",
  "load_state_supportive",
  "coverage_sufficient",
]);
const GoalClaimSchema = z.enum(["goal_requires_improvement", "goal_runway_limited", "goal_supported_by_history"]);
export type AthleteClaim = z.infer<typeof AthleteClaimSchema>;
export type GoalClaim = z.infer<typeof GoalClaimSchema>;
const MaterialConclusionSchema = <T extends z.ZodType>(claim: T) =>
  z
    .object({
      claim,
      explanation: z.string().min(1),
      fact_ids: z.array(z.string().min(1)).min(1),
    })
    .strict();
const EvidenceNoteSchema = z
  .object({
    description: z.string().min(1),
    fact_ids: z.array(z.string().min(1)).min(1),
  })
  .strict();
const RangeSchema = z
  .object({ low: z.number().nonnegative(), high: z.number().nonnegative() })
  .strict()
  .refine((range) => range.low <= range.high, "range low must not exceed high");

export const AthleteAssessmentSchema = z
  .object({
    schema_version: z.literal(2),
    readiness: z.enum(["ready", "limited", "missing_baseline"]),
    summary: z.string().min(1),
    capability_confidence: z.enum(["high", "medium", "low"]),
    current_phase: z.string().min(1).nullable(),
    continuity: z.enum(["continuous", "interrupted", "returning", "unknown"]),
    recommended_entry_phase: z.enum(["base", "build", "peak", "taper", "recovery", "return_to_run"]),
    safe_training_ranges: z
      .object({
        starting_weekly_distance_km: RangeSchema,
        weekly_distance_km: RangeSchema,
        runs_per_week: RangeSchema,
        long_run_km: RangeSchema,
        quality_sessions_per_week: RangeSchema,
      })
      .strict(),
    material_conclusions: z.array(MaterialConclusionSchema(AthleteClaimSchema)).min(1),
    limiting_factors: z.array(EvidenceNoteSchema),
    assumptions_to_validate: z.array(EvidenceNoteSchema),
    gaps: z.array(EvidenceNoteSchema),
  })
  .strict();
export type AthleteAssessment = z.infer<typeof AthleteAssessmentSchema>;

const GateSchema = z
  .object({
    target: z
      .object({
        kind: z.enum(["time", "pb", "finish"]),
        time_seconds: z.number().positive().nullable(),
        label: z.string().min(1),
      })
      .strict(),
    conditions: z
      .array(
        z
          .object({
            signal: z.enum(["race_specific_performance", "durability", "health_readiness", "fueling_execution", "availability_consistency"]),
            criterion: z.string().min(1),
            description: z.string().min(1),
            fact_ids: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const GoalAssessmentSchema = z
  .object({
    schema_version: z.literal(2),
    level: z.enum(["supported", "aggressive_but_plausible", "conditional", "multi_cycle_required", "unsafe_or_incompatible"]),
    summary: z.string().min(1),
    material_conclusions: z.array(MaterialConclusionSchema(GoalClaimSchema)).min(1),
    abc_gates: z.object({ A: GateSchema, B: GateSchema, C: GateSchema }).strict(),
    conflicts: z.array(EvidenceNoteSchema),
    multi_cycle_path: z.array(z.string()),
  })
  .strict();
export type GoalAssessment = z.infer<typeof GoalAssessmentSchema>;
