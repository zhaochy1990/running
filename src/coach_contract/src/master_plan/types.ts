/**
 * S1 master-plan generation — shared types for the `load_context` node.
 *
 * Interface half of `load_master_plan_context.ts`. Pure type declarations only
 * (no runtime values) so any generation node can import the context contract
 * without pulling in logic. These mirror the Python shapes assembled by
 * `stride_server/coach_adapters/master_plan_adapter.py::load_master_context`.
 */

/** The goal race the plan targets (mirrors the Python `goal` dict, loosely). */
export interface MasterPlanGoal {
	distance?: string;
	race_date?: string | null;
	goal_time_s?: number | null;
	/** Fixture/replay anchor — freezes "today" for deterministic generation. */
	as_of_date?: string | null;
	/** Fixture anchor for the season start (upcoming-Monday alignment). */
	season_start?: string | null;
}

/** Athlete profile / onboarding payload (loosely typed for now). */
export interface AthleteProfile {
	height_cm?: number | null;
	weekly_run_days_max?: number | null;
	injuries?: string[] | null;
	prs?: Record<string, number> | null;
}

export interface GenInputPayload {
	goal: MasterPlanGoal;
	profile: AthleteProfile | null;
}

/** One week of the rolling athlete profile. */
export interface WeeklyProfileEntry {
	week_start: string;
	distance_km: number | null;
	avg_hr: number | null;
	rhr: number | null;
}

/** Training history rollup (36-month + 16-week profile in the real impl). */
export interface TrainingHistory {
	total_activities: number;
	max_weekly_km: number | null;
	monthly_km: Record<string, number>;
	weekly_profile: WeeklyProfileEntry[];
}

/** Latest fitness state from the PMC + calibration baselines. */
export interface FitnessState {
	chronic_load: number | null; // CTL
	acute_load: number | null; // ATL
	form: number | null; // CTL − ATL
	rhr: number | null;
	hrv: number | null;
	summary: string;
}

/** Continuity signals (recent aerobic base, form zone, layoff, injuries…). */
export interface Continuity {
	macro_cycle: "summer" | "winter" | null;
	recent_aerobic_weeks: number | null;
	current_form_zone: string | null;
	current_chronic_load: number | null;
	recent_longest_run_km: number | null;
	days_since_last_race: number | null;
	return_from_layoff: boolean;
	injuries: string[];
}

/** Authoritative current-phase position (deterministic detection). */
export interface CurrentPhase {
	source: "existing_plan" | "inferred";
	current_phase_type: string | null;
	recommended_entry_phase: string | null;
	weeks_in_phase: number | null;
	completed_aerobic_weeks: number | null;
	confidence: number;
	rationale: string;
}

/** Latest body-composition scan baseline. */
export interface BodyComposition {
	scan_date: string;
	weight_kg: number;
	body_fat_pct: number | null;
	smm_kg: number | null;
	fat_mass_kg: number | null;
	bmr_kcal: number | null;
	bmi: number | null;
}

/** The assembled context handed to the generator node (matches the Python dict). */
export interface MasterPlanContext {
	history_summary: string;
	pb_seconds: Record<string, number>;
	fitness_state: FitnessState;
	as_of_date: string;
	training_load_tool: Record<string, unknown>;
	training_load_tool_summary: string;
	continuity: Continuity | null;
	current_phase: CurrentPhase | null;
	body_composition: BodyComposition | null;
	body_composition_summary: string | null;
}
