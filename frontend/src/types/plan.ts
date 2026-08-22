// Legacy Python plan wire types. Mirrors `src/stride_core/plan_spec.py` + the bits of
// `src/stride_core/workout_spec.py` we read on the frontend.
//
// Types mirror the Python `to_dict()` output (the JSON shape of
// `WeeklyPlan.from_dict` / `to_dict`). Keep this file in lockstep with
// `plan_spec.py` — when fields are added/removed there, mirror here.

import type { PlanDay, PlannedSessionRow, WeekDetail } from "../api";

// ─────────────────────────────────────────────────────────────────────────────
// workout_spec primitives
// ─────────────────────────────────────────────────────────────────────────────

export type StepKind = "warmup" | "work" | "recovery" | "cooldown" | "rest";

export type DurationKind = "distance_m" | "time_s" | "open";

export type TargetKind = "pace_s_km" | "hr_bpm" | "power_w" | "open";

export type StrengthTargetKind = "reps" | "time_s";

export interface Duration {
  kind: DurationKind;
  value: number | null;
}

export interface Target {
  kind: TargetKind;
  low: number | null;
  high: number | null;
}

export interface WorkoutStep {
  step_kind: StepKind;
  duration: Duration;
  target: Target;
  note: string | null;
  /** Optional HR ceiling layered on top of the primary target — e.g.
   * "4×3K @ 4:05-4:10/km, HR ≤167" stores pace as `target` and 167 here.
   * `null` for steps without a cap (most easy runs / open recoveries). */
  hr_cap_bpm?: number | null;
}

export interface WorkoutBlock {
  steps: WorkoutStep[];
  repeat: number;
}

export interface NormalizedRunWorkout {
  schema: "run-workout/v1";
  name: string;
  date: string;
  note: string | null;
  blocks: WorkoutBlock[];
}

export interface StrengthExerciseSpec {
  canonical_id: string;
  display_name: string;
  sets: number;
  target_kind: StrengthTargetKind;
  target_value: number;
  rest_seconds: number;
  note: string | null;
}

export interface NormalizedStrengthWorkout {
  schema: "strength-workout/v1";
  name: string;
  date: string;
  note: string | null;
  exercises: StrengthExerciseSpec[];
}

// ─────────────────────────────────────────────────────────────────────────────
// plan_spec
// ─────────────────────────────────────────────────────────────────────────────

export type SessionKind = "run" | "strength" | "rest" | "cross" | "note";

export type StructuredStatus = "fresh" | "authored" | "canonical" | "stale" | "parse_failed" | "backfilled" | "none";

export interface PlannedSession {
  schema: "plan-session/v1";
  date: string; // ISO YYYY-MM-DD
  session_index: number;
  kind: SessionKind;
  summary: string;
  // For kind=run, this is NormalizedRunWorkout. For kind=strength,
  // NormalizedStrengthWorkout. Otherwise null.
  spec: NormalizedRunWorkout | NormalizedStrengthWorkout | null;
  notes_md: string | null;
  total_distance_m: number | null;
  total_duration_s: number | null;
  scheduled_workout_id: number | null;
}

export interface Meal {
  name: string;
  time_hint: string | null;
  kcal: number | null;
  carbs_g: number | null;
  protein_g: number | null;
  fat_g: number | null;
  items_md: string | null;
}

export interface PlannedNutrition {
  schema: "plan-nutrition/v1";
  date: string;
  kcal_target: number | null;
  carbs_g: number | null;
  protein_g: number | null;
  fat_g: number | null;
  water_ml: number | null;
  meals: Meal[];
  notes_md: string | null;
}

// This is not the TypeScript Coach Agent WeeklyPlanSchema. The legacy Python
// contract still uses week_folder and includes persistence-only session fields.
export interface LegacyWeeklyPlanStructured {
  schema: "weekly-plan/v1";
  week_folder: string;
  sessions: PlannedSession[];
  nutrition: PlannedNutrition[];
  notes_md: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived helpers
// ─────────────────────────────────────────────────────────────────────────────

const PUSHABLE_KINDS: ReadonlySet<SessionKind> = new Set(["run", "strength"]);

/** True iff the session has a complete spec the push pipeline can consume. */
export function isPushable(s: PlannedSession): boolean {
  return PUSHABLE_KINDS.has(s.kind) && s.spec != null;
}

/**
 * Merge structured-plan sessions/nutrition (from the `/weeks/{id}` Go backend,
 * which reads MySQL) into a calendar `PlanDay[]`. `days` rows win on the same
 * `date`/`session_index` key so any pre-existing state (e.g. push/scheduled
 * info) survives; structured sessions fill the gaps. This is the basis of the
 * Go-only calendar (see {@link buildPlanDaysFromWeekDetail}).
 *
 * Structured sessions lack `id`/`pushable`, so we synthesize them.
 */
export function mergeStructuredIntoPlanDays(
  days: PlanDay[],
  structured: WeekDetail["structured"],
): PlanDay[] {
  if (!structured) return days;
  const structuredSessions = structured.sessions ?? [];
  const structuredNutrition = new Map<string, PlannedNutrition>(
    (structured.nutrition ?? []).map((n) => [n.date, n]),
  );
  const out = days.map((day) => {
    const byKey = new Map<string, PlannedSessionRow>(
      day.sessions.map((s) => [`${s.date}/${s.session_index}`, s]),
    );
    for (const s of structuredSessions) {
      if (s.date !== day.date) continue;
      const key = `${s.date}/${s.session_index}`;
      if (!byKey.has(key)) {
        byKey.set(key, { ...s, id: 0, pushable: isPushable(s) });
      }
    }
    const sessions = Array.from(byKey.values()).sort(
      (a, b) => a.session_index - b.session_index,
    );
    const nutrition = day.nutrition ?? structuredNutrition.get(day.date) ?? null;
    return { date: day.date, sessions, nutrition };
  });
  return out;
}

/**
 * Build the calendar `PlanDay[]` for a week entirely from the Go `/weeks/{id}`
 * detail response (`weekDetail.structured`) — the canonical MySQL source for
 * both sessions and nutrition. Replaces the legacy `/plan/days` Python/Azure
 * endpoint for the calendar tab. Structured sessions lack `id`/`pushable`, so
 * we synthesize them.
 */
export function buildPlanDaysFromWeekDetail(weekDetail: WeekDetail): PlanDay[] {
  const dates = buildWeekDates(weekDetail.date_from, weekDetail.date_to);
  const empty: PlanDay[] = dates.map((d) => ({ date: d, sessions: [], nutrition: null }));
  return mergeStructuredIntoPlanDays(empty, weekDetail.structured);
}

/** Build an inclusive list of Shanghai-local YYYY-MM-DD dates for a week. */
export function buildWeekDates(dateFrom: string, dateTo: string): string[] {
  // `dateFrom`/`dateTo` are Shanghai-local YYYY-MM-DD (week-folder format).
  // Parse the bare strings as Shanghai dates and iterate by day — we
  // deliberately do NOT use `new Date(yyyy_mm_dd)` because that parses as
  // UTC midnight and would drift by one day for non-Shanghai browsers.
  const out: string[] = [];
  const parse = (s: string): [number, number, number] | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    return m ? [+m[1], +m[2], +m[3]] : null;
  };
  const from = parse(dateFrom);
  const to = parse(dateTo);
  if (!from || !to) return out;
  // Use UTC date arithmetic to walk day-by-day; the resulting numbers are
  // calendar values, not instants, so TZ never enters the picture.
  let cur = Date.UTC(from[0], from[1] - 1, from[2]);
  const end = Date.UTC(to[0], to[1] - 1, to[2]);
  while (cur <= end && out.length < 31) {
    const d = new Date(cur);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    out.push(`${y}-${m}-${day}`);
    cur += 24 * 3600 * 1000;
  }
  return out;
}

/** True iff the surrounding week's structured layer is safe to push from
 * (LLM-fresh or author-direct). Both states represent canonical structure
 * the push pipeline can consume safely. */
export function isFresh(status: StructuredStatus | null | undefined): boolean {
  return status === "fresh" || status === "authored" || status === "canonical";
}

/** Canonical structured states that allow push to watch. Alias of {@link isFresh}
 * with a more explicit name for new call sites. */
export function isPushableStatus(status: StructuredStatus | null | undefined): boolean {
  return status === "fresh" || status === "authored" || status === "canonical";
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-variant plans (Step 4 — mirrors routes/plan_variants.py + weeks.py extras)
// ─────────────────────────────────────────────────────────────────────────────

export type VariantParseStatus = "fresh" | "parse_failed";

export type UnselectableReason = "parse_failed" | "schema_outdated" | "superseded";

// Mirrors `routes/plan_variants.py:_VALID_RATING_DIMENSIONS`.
// Note: server uses `difficulty` (not `difficulty_match`); the spec doc
// uses `difficulty_match` but the wire format is `difficulty`.
export type RatingDimension = "overall" | "suitability" | "structure" | "nutrition" | "difficulty";

export type RatingScore = 1 | 2 | 3 | 4 | 5;

export interface VariantRating {
  dimension: RatingDimension;
  score: RatingScore;
  comment?: string | null;
}

export interface PlanVariant {
  variant_id: number;
  variant_index: number | null;
  model_id: string;
  schema_version: number;
  variant_parse_status: VariantParseStatus;
  content_md: string;
  sessions: PlannedSession[];
  nutrition: PlannedNutrition[];
  ratings: Partial<Record<RatingDimension, RatingScore>>;
  rating_comment: string | null;
  is_selected: boolean;
  generated_at: string;
  generation_metadata: Record<string, unknown> | null;
  selectable: boolean;
  unselectable_reason?: UnselectableReason;
  superseded_at?: string;
}

export interface VariantsResponse {
  week_folder: string;
  selected_variant_id: number | null;
  variants: PlanVariant[];
}

export interface VariantsSummary {
  total: number;
  selected_variant_id: number | null;
  model_ids: string[];
}

export interface AbandonedScheduledWorkout {
  id: number;
  date: string;
  name: string;
  abandoned_by_promote_at: string;
}
