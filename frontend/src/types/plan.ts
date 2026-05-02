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

/** True iff the surrounding week's structured layer is safe to push from. */
export function isFresh(status: StructuredStatus | null | undefined): boolean {
  return status === 'fresh'
}
