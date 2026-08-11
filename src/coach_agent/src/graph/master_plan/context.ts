import { z } from "zod/v4";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const nullableNumber = z.number().nullable();

const ProfileSchema = z.object({ display_name: z.string().nullable(), dob: day.nullable(), sex: z.string().nullable(), height_cm: nullableNumber, weight_kg: nullableNumber, running_age_range: z.string().nullable() }).strict();
const WeeklyMetricsSchema = z.object({ week_start: day, distance_km: z.number().nonnegative(), hours: z.number().nonnegative(), avg_pace_s_km: nullableNumber, avg_hr: nullableNumber, run_count: z.number().int().nonnegative(), long_run_km: nullableNumber, speed_session_count: z.number().int().nonnegative(), race_count: z.number().int().nonnegative(), training_dose: z.number().nonnegative(), ctl: nullableNumber, atl: nullableNumber, form: nullableNumber, rhr: nullableNumber, hrv: nullableNumber }).strict();

/** Complete, invocation-scoped and deeply immutable input to the planning Kernel. */
export const ContextSnapshotSchema = z.object({
  schema_version: z.literal(1),
  user: z.object({ id: z.string().min(1), profile: ProfileSchema }).strict(),
  injuries: z.array(z.object({ body_area: z.string(), status: z.string(), occurred_on: day.nullable(), source: z.string() }).strict()),
  personal_bests: z.array(z.object({ distance: z.string(), time_sec: z.number().positive(), achieved_at: day.nullable(), source: z.string().nullable() }).strict()),
  running_calibration: z.object({ as_of_date: day, threshold_hr: nullableNumber, threshold_speed_mps: nullableNumber, threshold_hr_confidence: z.string(), threshold_speed_confidence: z.string(), heart_rate_zones: z.array(z.unknown()), pace_zones: z.array(z.unknown()) }).strict().nullable(),
  race_history: z.array(z.object({ date: day, distance_km: nullableNumber, duration_min: nullableNumber, avg_pace_s_km: nullableNumber, avg_hr: nullableNumber, max_hr: nullableNumber, feel: z.string().nullable() }).strict()),
  macro_history: z.object({ start_date: day, end_date: day, months: z.array(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), distance_km: z.number().nonnegative(), hours: z.number().nonnegative(), run_count: z.number().int().nonnegative() }).strict()), peak_weekly_distance_km: nullableNumber, longest_run_km: nullableNumber, gap_periods: z.array(z.object({ start_date: day, end_date: day, days: z.number().int().positive() }).strict()), consistency_pct: nullableNumber }).strict(),
  recent_history: z.object({ start_date: day, end_date: day, weeks: z.array(WeeklyMetricsSchema) }).strict(),
  fitness_state: z.object({ as_of_date: day, ctl: nullableNumber, atl: nullableNumber, form: nullableNumber }).strict(),
  body_composition: z.object({ weight_kg: nullableNumber, body_fat_pct: nullableNumber, skeletal_muscle_kg: nullableNumber }).strict(),
  active_plan: z.object({ plan_id: z.string(), revision: z.number().int().positive(), status: z.string(), start_date: day.nullable(), end_date: day.nullable() }).strict().nullable(),
  current_phase: z.object({ name: z.string(), start_date: day.nullable(), end_date: day.nullable(), source: z.enum(["active_plan", "inferred"]) }).strict().nullable(),
  continuity: z.object({ active_plan_continuation: z.boolean(), last_activity_date: day.nullable(), days_since_last_run: z.number().int().nonnegative().nullable() }).strict(),
  coverage: z.array(z.object({ domain: z.string(), status: z.enum(["complete", "partial", "missing"]), detail: z.string().nullable() }).strict()),
  source_manifest: z.array(z.object({ domain: z.string(), source: z.string(), range_start: day.nullable(), range_end: day.nullable(), records: z.number().int().nonnegative() }).strict()),
  as_of: z.string().datetime({ offset: true }),
}).strict().transform(deepFreeze);

type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T
  : T extends readonly (infer Item)[] ? readonly DeepReadonly<Item>[]
  : T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
  : T;

export type ContextSnapshot = DeepReadonly<z.infer<typeof ContextSnapshotSchema>>;

export interface MasterPlanContextProvider {
  loadSnapshot(userId: string, asOf?: string): Promise<ContextSnapshot>;
}

export class FrozenMasterPlanContextProvider implements MasterPlanContextProvider {
  readonly #snapshot: ContextSnapshot;
  constructor(snapshot: z.input<typeof ContextSnapshotSchema>) { this.#snapshot = ContextSnapshotSchema.parse(snapshot); }
  async loadSnapshot(): Promise<ContextSnapshot> { return this.#snapshot; }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
