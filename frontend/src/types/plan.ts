// Mirrors `src/stride_core/plan_spec.py` + the bits of
// `src/stride_core/workout_spec.py` we read on the frontend.
//
// Types mirror the Python `to_dict()` output (the JSON shape of
// `WeeklyPlan.from_dict` / `to_dict`). Keep this file in lockstep with
// `plan_spec.py` — when fields are added/removed there, mirror here.

// ─────────────────────────────────────────────────────────────────────────────
// workout_spec primitives
// ─────────────────────────────────────────────────────────────────────────────

export type StepKind = 'warmup' | 'work' | 'recovery' | 'cooldown' | 'rest'

export type DurationKind = 'distance_m' | 'time_s' | 'open'

export type TargetKind = 'pace_s_km' | 'hr_bpm' | 'power_w' | 'open'

export type StrengthTargetKind = 'reps' | 'time_s'

export interface Duration {
  kind: DurationKind
  value: number | null
}

export interface Target {
  kind: TargetKind
  low: number | null
  high: number | null
}

export interface WorkoutStep {
  step_kind: StepKind
  duration: Duration
  target: Target
  note: string | null
}

export interface WorkoutBlock {
  steps: WorkoutStep[]
  repeat: number
}

export interface NormalizedRunWorkout {
  schema: 'run-workout/v1'
  name: string
  date: string
  note: string | null
  blocks: WorkoutBlock[]
}

export interface StrengthExerciseSpec {
  canonical_id: string
  display_name: string
  sets: number
  target_kind: StrengthTargetKind
  target_value: number
  rest_seconds: number
  note: string | null
}

export interface NormalizedStrengthWorkout {
  schema: 'strength-workout/v1'
  name: string
  date: string
  note: string | null
  exercises: StrengthExerciseSpec[]
}

// ─────────────────────────────────────────────────────────────────────────────
// plan_spec
// ─────────────────────────────────────────────────────────────────────────────

export type SessionKind = 'run' | 'strength' | 'rest' | 'cross' | 'note'

export type StructuredStatus =
  | 'fresh'
  | 'authored'
  | 'stale'
  | 'parse_failed'
  | 'backfilled'
  | 'none'

export interface PlannedSession {
  schema: 'plan-session/v1'
  date: string                       // ISO YYYY-MM-DD
  session_index: number
  kind: SessionKind
  summary: string
  // For kind=run, this is NormalizedRunWorkout. For kind=strength,
  // NormalizedStrengthWorkout. Otherwise null.
  spec: NormalizedRunWorkout | NormalizedStrengthWorkout | null
  notes_md: string | null
  total_distance_m: number | null
  total_duration_s: number | null
  scheduled_workout_id: number | null
}

export interface Meal {
  name: string
  time_hint: string | null
  kcal: number | null
  carbs_g: number | null
  protein_g: number | null
  fat_g: number | null
  items_md: string | null
}

export interface PlannedNutrition {
  schema: 'plan-nutrition/v1'
  date: string
  kcal_target: number | null
  carbs_g: number | null
  protein_g: number | null
  fat_g: number | null
  water_ml: number | null
  meals: Meal[]
  notes_md: string | null
}

export interface WeeklyPlanStructured {
  schema: 'weekly-plan/v1'
  week_folder: string
  sessions: PlannedSession[]
  nutrition: PlannedNutrition[]
  notes_md: string | null
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived helpers
// ─────────────────────────────────────────────────────────────────────────────

const PUSHABLE_KINDS: ReadonlySet<SessionKind> = new Set(['run', 'strength'])

/** True iff the session has a complete spec the push pipeline can consume. */
export function isPushable(s: PlannedSession): boolean {
  return PUSHABLE_KINDS.has(s.kind) && s.spec != null
}

/** True iff the surrounding week's structured layer is safe to push from
 * (LLM-fresh or author-direct). Both states represent canonical structure
 * the push pipeline can consume safely. */
export function isFresh(status: StructuredStatus | null | undefined): boolean {
  return status === 'fresh' || status === 'authored'
}

/** Canonical structured states that allow push to watch. Alias of {@link isFresh}
 * with a more explicit name for new call sites. */
export function isPushableStatus(status: StructuredStatus | null | undefined): boolean {
  return status === 'fresh' || status === 'authored'
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-variant plans (Step 4 — mirrors routes/plan_variants.py + weeks.py extras)
// ─────────────────────────────────────────────────────────────────────────────

export type VariantParseStatus = 'fresh' | 'parse_failed'

export type UnselectableReason = 'parse_failed' | 'schema_outdated' | 'superseded'

// Mirrors `routes/plan_variants.py:_VALID_RATING_DIMENSIONS`.
// Note: server uses `difficulty` (not `difficulty_match`); the spec doc
// uses `difficulty_match` but the wire format is `difficulty`.
export type RatingDimension =
  | 'overall'
  | 'suitability'
  | 'structure'
  | 'nutrition'
  | 'difficulty'

export type RatingScore = 1 | 2 | 3 | 4 | 5

export interface VariantRating {
  dimension: RatingDimension
  score: RatingScore
  comment?: string | null
}

export interface PlanVariant {
  variant_id: number
  variant_index: number | null
  model_id: string
  schema_version: number
  variant_parse_status: VariantParseStatus
  content_md: string
  sessions: PlannedSession[]
  nutrition: PlannedNutrition[]
  ratings: Partial<Record<RatingDimension, RatingScore>>
  rating_comment: string | null
  is_selected: boolean
  generated_at: string
  generation_metadata: Record<string, unknown> | null
  selectable: boolean
  unselectable_reason?: UnselectableReason
  superseded_at?: string
}

export interface VariantsResponse {
  week_folder: string
  selected_variant_id: number | null
  variants: PlanVariant[]
}

export interface VariantsSummary {
  total: number
  selected_variant_id: number | null
  model_ids: string[]
}

export interface AbandonedScheduledWorkout {
  id: number
  date: string
  name: string
  abandoned_by_promote_at: string
}
