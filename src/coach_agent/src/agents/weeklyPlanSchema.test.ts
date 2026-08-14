import assert from "node:assert/strict";
import test from "node:test";
import { addDays } from "../utils/planningDate.js";
import { WeeklyPlanSchema } from "./weekly_plan/schema.js";

function canonicalPlan() {
	const weekStart = "2026-06-15";
	return {
		schema: "weekly-plan/v1",
		week_folder: "2026-06-15_06-21",
		sessions: [
			{
				schema: "plan-session/v1",
				date: weekStart,
				session_index: 0,
				kind: "run",
				summary: "轻松跑",
				spec: {
					schema: "run-workout/v1",
					name: "轻松跑",
					date: weekStart,
					note: null,
					blocks: [
						{
							repeat: 1,
							steps: [
								{
									step_kind: "work",
									duration: { kind: "distance_m", value: 8000 },
									target: { kind: "hr_bpm", low: 130, high: 145 },
									note: null,
									hr_cap_bpm: 145,
								},
							],
						},
					],
				},
				notes_md: null,
				total_distance_m: 8000,
				total_duration_s: null,
			},
			{
				schema: "plan-session/v1",
				date: addDays(weekStart, 1),
				session_index: 0,
				kind: "strength",
				summary: "力量训练",
				spec: {
					schema: "strength-workout/v1",
					name: "基础力量",
					date: addDays(weekStart, 1),
					note: null,
					exercises: [
						{
							canonical_id: "T1262",
							display_name: "深蹲",
							sets: 3,
							target_kind: "reps",
							target_value: 10,
							rest_seconds: 60,
							note: null,
							provider_id: "T1262",
						},
					],
				},
				notes_md: null,
				total_distance_m: null,
				total_duration_s: 1800,
			},
		],
		nutrition: Array.from({ length: 7 }, (_, offset) => ({
			schema: "plan-nutrition/v1",
			date: addDays(weekStart, offset),
			kcal_target: null,
			carbs_g: null,
			protein_g: null,
			fat_g: null,
			water_ml: null,
			meals: [],
			notes_md: null,
		})),
		notes_md: null,
		coach_notes: null,
	};
}

test("weekly plan schema accepts the canonical target week", () => {
	assert.equal(WeeklyPlanSchema.safeParse(canonicalPlan()).success, true);
});

test("weekly plan schema requires canonical schema stamps and week folder", () => {
	const plan = canonicalPlan();
	assert.equal(
		WeeklyPlanSchema.safeParse({ ...plan, schema: undefined }).success,
		false,
	);
	assert.equal(
		WeeklyPlanSchema.safeParse({ ...plan, week_folder: "2026-06-15_06-22" })
			.success,
		false,
	);
});

test("weekly plan schema rejects non-canonical extra fields", () => {
	assert.equal(
		WeeklyPlanSchema.safeParse({ ...canonicalPlan(), phase: "build" }).success,
		false,
	);
});

test("weekly plan schema rejects dates outside the target week", () => {
	const plan = canonicalPlan();
	const firstSession = plan.sessions[0];
	assert.ok(firstSession);
	firstSession.date = "2026-06-22";
	assert.equal(WeeklyPlanSchema.safeParse(plan).success, false);
});

test("weekly plan schema requires one nutrition entry for every target date", () => {
	const plan = canonicalPlan();
	plan.nutrition.pop();
	assert.equal(WeeklyPlanSchema.safeParse(plan).success, false);
});

test("weekly plan schema rejects empty run blocks and strength exercises", () => {
	const runPlan = canonicalPlan();
	const runSpec = runPlan.sessions[0]?.spec;
	assert.ok(runSpec && "blocks" in runSpec);
	runSpec.blocks = [];
	assert.equal(WeeklyPlanSchema.safeParse(runPlan).success, false);

	const strengthPlan = canonicalPlan();
	const strengthSpec = strengthPlan.sessions[1]?.spec;
	assert.ok(strengthSpec && "exercises" in strengthSpec);
	strengthSpec.exercises = [];
	assert.equal(WeeklyPlanSchema.safeParse(strengthPlan).success, false);
});

test("weekly plan schema permits the canonical custom-exercise fallback", () => {
	const plan = canonicalPlan();
	const strengthSpec = plan.sessions[1]?.spec;
	assert.ok(strengthSpec && "exercises" in strengthSpec);
	const firstExercise = strengthSpec.exercises[0];
	assert.ok(firstExercise);
	firstExercise.canonical_id = "split_squat";
	const customExercise = firstExercise as Omit<
		typeof firstExercise,
		"provider_id"
	> & {
		provider_id: string | null;
	};
	customExercise.provider_id = null;
	assert.equal(WeeklyPlanSchema.safeParse(plan).success, true);
	customExercise.provider_id = "invented";
	assert.equal(WeeklyPlanSchema.safeParse(plan).success, false);
});
