// Canonical view-model types for Stride plan views.
// These mirror the JSON contracts returned by the Go/Python APIs. Consumers
// pass data shaped like these; no network layer lives in this package.

export type SessionKind = "run" | "strength" | "rest" | "cross" | "note";
export type DurationKind = "distance_m" | "time_s" | "open";
export type TargetKind = "pace_s_km" | "hr_bpm" | "power_w" | "open";

export interface WorkoutStep {
  step_kind: "warmup" | "work" | "recovery" | "cooldown" | "rest";
  duration: { kind: DurationKind; value: number | null };
  target: { kind: TargetKind; low: number | null; high: number | null };
  note: string | null;
  hr_cap_bpm?: number | null;
}

export interface RunWorkout {
  schema: "run-workout/v1";
  name: string;
  date: string;
  note: string | null;
  blocks: Array<{ repeat: number; steps: WorkoutStep[] }>;
}

export interface StrengthExercise {
  canonical_id: string;
  display_name: string;
  sets: number;
  target_kind: "reps" | "time_s";
  target_value: number;
  rest_seconds: number;
  note: string | null;
  provider_id: string | null;
}

export interface StrengthWorkout {
  schema: "strength-workout/v1";
  name: string;
  date: string;
  note: string | null;
  exercises: StrengthExercise[];
}

export interface PlannedSession {
  schema: "plan-session/v1";
  date: string;
  session_index: number;
  kind: SessionKind;
  summary: string;
  spec: RunWorkout | StrengthWorkout | null;
  notes_md: string | null;
  total_distance_m: number | null;
  total_duration_s: number | null;
  estimated_dose: number | null;
  scheduled_workout_id?: number | null;
}

export interface PlannedMeal {
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
  meals: PlannedMeal[];
  notes_md: string | null;
}

export interface WeeklyPlanContent {
  schema: "weekly-plan/v1";
  week_name: string;
  sessions: PlannedSession[];
  nutrition: PlannedNutrition[];
  notes_md: string | null;
  coach_notes: string | null;
}

export interface WeeklyPlanEnvelopeBase {
  plan_id: string;
  week_name: string;
  date_from: string;
  date_to: string;
  master_plan_id: string | null;
  status: "active";
  revision: number;
  created_at: string;
  updated_at: string;
}

export type WeeklyPlanEnvelope =
  | (WeeklyPlanEnvelopeBase & { content_version: 1; content: string })
  | (WeeklyPlanEnvelopeBase & { content_version: 2; content: WeeklyPlanContent });

export interface WeeklyActivity {
  label_id: string;
  name: string | null;
  sport_type: number;
  sport_name: string | null;
  date: string;
  distance_m: number | null;
  distance_km: number;
  duration_s: number | null;
  duration_fmt: string;
  avg_pace_s_km: number | null;
  pace_fmt: string;
  avg_hr: number | null;
  max_hr: number | null;
  train_type: string | null;
  sport_note: string | null;
}

export interface WeekDetail {
  week_name: string;
  date_from: string;
  date_to: string;
  plan: string | null;
  feedback: string;
  feedback_created_at: string | null;
  feedback_updated_at: string | null;
  activities: WeeklyActivity[];
  total_km: number;
  total_duration_s: number;
  total_duration_fmt: string;
  activity_count: number;
  structured: {
    structured_status: "canonical";
    sessions: PlannedSession[];
    nutrition: PlannedNutrition[];
    coach_notes: string | null;
  } | null;
}

export interface PlanDay {
  date: string;
  sessions: PlannedSession[];
  nutrition: PlannedNutrition | null;
}

// ---- Master (season) plan view-model types ----

export interface HrZoneShare {
  zone_index: number;
  minutes: number;
  percent: number;
}

export interface CompletedPhaseSummary {
  total_distance_km: number;
  run_count: number;
  weekly_avg_km: number;
  avg_pace_s_km: number | null;
  avg_pace_fmt: string;
  avg_hr: number | null;
  hr_zone_distribution: HrZoneShare[];
}

export interface MasterPlanMilestone {
  id: string;
  type: string;
  date: string;
  phase_id: string;
  target: string;
  completed_actual: string | null;
}

export interface MasterPlanPhase {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  focus: string;
  weekly_distance_km_low: number;
  weekly_distance_km_high: number;
  key_session_types: string[];
  milestone_ids: string[];
  phase_type?: string;
  rhythm?: string;
  key_workouts?: string;
  monitoring_triggers?: string[];
  coach_note?: string;
  is_completed?: boolean;
  summary?: CompletedPhaseSummary | null;
}

export interface MasterPlanKeySession {
  type: string;
  distance_km: number | null;
  duration_min: number | null;
  intensity?: string | null;
  purpose?: string | null;
}

export interface MasterPlanWeek {
  week_index: number;
  week_start: string;
  week_end?: string | null;
  phase_id: string;
  target_weekly_km_low: number | null;
  target_weekly_km_high: number | null;
  target_training_dose_low?: number | null;
  target_training_dose_high?: number | null;
  key_sessions: MasterPlanKeySession[];
  is_recovery_week?: boolean;
  is_taper_week?: boolean;
  planned_distance_km?: number | null;
  is_completed?: boolean;
  actual_distance_km?: number | null;
  actual_avg_pace_s_km?: number | null;
  actual_avg_pace_fmt?: string;
  actual_avg_hr?: number | null;
  actual_run_count?: number;
  actual_duration_s?: number;
  actual_training_dose?: number | null;
  actual_training_dose_coverage?: number | null;
  actual_training_dose_status?: "complete" | "partial" | "unknown" | null;
}

export interface SeasonPlanGoal {
  goal_id: string;
  race_name?: string;
  distance?: string;
  race_date?: string;
  target_time?: string;
  timezone?: string;
  location?: string | null;
}

export interface SeasonPlanContent {
  goal: SeasonPlanGoal;
  start_date: string;
  end_date: string;
  total_weeks: number;
  phases: MasterPlanPhase[];
  milestones: MasterPlanMilestone[];
  weeks: MasterPlanWeek[];
  training_load_projection?: {
    status: "available" | "unavailable";
    unavailable_reason: string | null;
    calculated_at: string;
  } | null;
  training_principles: string[];
  generated_by: string;
  current_phase_id: string | null;
  current_week_number: number | null;
  next_milestone: {
    id: string;
    date: string;
    target: string;
    days_until: number;
  } | null;
}
