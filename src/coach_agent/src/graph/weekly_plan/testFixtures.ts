import type { WeeklyPlan } from "../../agents/weekly_plan/schema.js";
import type { WeeklyPlanContext } from "../../persistence/weeklyPlanContextProvider.js";

export function createWeeklyPlanSimulationContext(): WeeklyPlanContext {
	return {
		as_of: "2026-08-14",
		plan_start: "2026-08-17",
		week_name: "2026-08-17_08-23",
		lookback: { start_date: "2026-07-18", end_date: "2026-08-14", days: 28 },
		training_position: { phase: null, stage: null },
		recent_activities: [],
		recent_training_weeks: [],
		absorbed_load: {
			complete_weeks_considered: [],
			distance_anchor_km: null,
			latest_complete_week: null,
		},
		recent_feedback: [],
		fitness_state: {
			as_of_date: "2026-08-14",
			stride_training_load: {
				available: true,
				acute_load: 55,
				chronic_load: 60,
				form: 5,
				load_ratio: 0.9167,
			},
			trend: [],
			provenance: { source: "stride", vendor_derived: false },
		},
		injury_and_recovery: {},
		running_calibration: {
			as_of_date: "2026-08-01",
			lactate_threshold_hr: 170,
			threshold_pace_s_per_km: 250,
			threshold_speed_mps: 4,
			rhr_baseline: 50,
			threshold_hr_confidence: "high",
			threshold_pace_confidence: "high",
			heart_rate_zones: [],
			pace_zones: [],
		},
	};
}

function nutrition() {
	return Array.from({ length: 7 }, (_, index) => ({
		schema: "plan-nutrition/v1" as const,
		date: `2026-08-${String(17 + index).padStart(2, "0")}`,
		kcal_target: null,
		carbs_g: null,
		protein_g: null,
		fat_g: null,
		water_ml: null,
		meals: [],
		notes_md: null,
	}));
}

function runSession(
	date: string,
	index: number,
	distanceM: number,
	target:
		| { kind: "pace_s_km"; low: number; high: number }
		| { kind: "hr_bpm"; low: number; high: number },
) {
	return {
		schema: "plan-session/v1" as const,
		date,
		session_index: index,
		summary: "structured run",
		notes_md: null,
		total_distance_m: distanceM,
		total_duration_s: null,
		kind: "run" as const,
		spec: {
			schema: "run-workout/v1" as const,
			name: "structured run",
			date,
			note: null,
			blocks: [
				{
					repeat: 1,
					steps: [
						{
							step_kind: "work" as const,
							duration: { kind: "distance_m" as const, value: distanceM },
							target,
							note: null,
							hr_cap_bpm: null,
						},
					],
				},
			],
		},
	};
}

export function createWeeklyPlanForSimulation(): WeeklyPlan {
	return {
		schema: "weekly-plan/v1",
		week_name: "2026-08-17_08-23",
		sessions: [
			runSession("2026-08-17", 0, 10_000, {
				kind: "pace_s_km",
				low: 330,
				high: 330,
			}),
			runSession("2026-08-19", 0, 8_000, {
				kind: "hr_bpm",
				low: 140,
				high: 150,
			}),
		],
		nutrition: nutrition(),
		notes_md: null,
		coach_notes: "simulated",
	};
}
