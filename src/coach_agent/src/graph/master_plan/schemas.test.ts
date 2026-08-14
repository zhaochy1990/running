import assert from "node:assert/strict";
import test from "node:test";
import { MasterPlanSchema as LegacyMasterPlanSchema } from "../../agents/master_plan/schema.js";
import { KeySessionTypeSchema, MasterPlanSchema } from "./schemas.js";
import { createTestMasterPlan } from "./testFixtures.js";

const strategicTypes = [
	"long_run",
	"threshold",
	"tempo",
	"interval",
	"vo2max",
	"hill",
	"race_pace",
	"time_trial",
	"tune_up_race",
	"race",
	"strength_key",
] as const;

test("key-session type accepts only the strategic domain enum", () => {
	for (const type of strategicTypes) {
		assert.equal(KeySessionTypeSchema.safeParse(type).success, true, type);
	}
	assert.equal(KeySessionTypeSchema.safeParse("easy").success, false);
	assert.equal(KeySessionTypeSchema.safeParse("arbitrary").success, false);
});

test("embedded race-pace long runs cannot be duplicated as race-pace sessions", () => {
	const plan = createTestMasterPlan();
	const invalidPlan = {
		...plan,
		weeks: [
			{
				...plan.weeks[0],
				key_sessions: [
					{
						type: "long_run",
						distance_km: 30,
						duration_min: null,
						intensity: "easy + 10km MP",
						purpose: "race-specific endurance",
					},
					{
						type: "race_pace",
						distance_km: 10,
						duration_min: null,
						intensity: "MP",
						purpose: "race pace",
					},
				],
			},
		],
	};

	assert.equal(MasterPlanSchema.safeParse(invalidPlan).success, false);
});

test("strategic skeleton rejects ordinary filler runs", () => {
	const plan = createTestMasterPlan();
	plan.weeks[0]!.key_sessions[0]!.purpose = "easy recovery filler run";
	assert.equal(MasterPlanSchema.safeParse(plan).success, false);
});

test("the legacy schema import is the Kernel-owned schema", () => {
	assert.equal(LegacyMasterPlanSchema, MasterPlanSchema);
});

test("master plan accepts an omitted or null race location", () => {
	const plan = createTestMasterPlan();
	const { location: _location, ...goalWithoutLocation } = plan.goal;
	const withoutLocation = { ...plan, goal: goalWithoutLocation };
	assert.equal(MasterPlanSchema.safeParse(withoutLocation).success, true);

	const withNullLocation = {
		...plan,
		goal: { ...plan.goal, location: null },
	};
	assert.equal(MasterPlanSchema.safeParse(withNullLocation).success, true);
});

test("key sessions accept the canonical structured running-workout shape", () => {
	const plan = createTestMasterPlan();
	const session = plan.weeks[0]!.key_sessions[0]! as Record<string, unknown>;
	session.workout_structure = {
		schema: "run-workout/v1",
		name: "6x3min",
		date: "2026-08-11",
		note: null,
		blocks: [
			{
				repeat: 6,
				steps: [
					{
						step_kind: "work",
						duration: { kind: "time_s", value: 180 },
						target: { kind: "pace_s_km", low: 230, high: 225 },
					},
					{
						step_kind: "recovery",
						duration: { kind: "time_s", value: 120 },
						target: { kind: "open", low: null, high: null },
					},
				],
			},
		],
	};

	assert.equal(MasterPlanSchema.safeParse(plan).success, true);
});

test("structured workout dates stay in their week and work targets are explicit", () => {
	const plan = createTestMasterPlan();
	const session = plan.weeks[0]!.key_sessions[0]! as Record<string, unknown>;
	const workout = {
		schema: "run-workout/v1",
		name: "invalid",
		date: "2026-08-18",
		note: null,
		blocks: [
			{
				repeat: 1,
				steps: [
					{
						step_kind: "work",
						duration: { kind: "time_s", value: 600 },
						target: { kind: "open", low: null, high: null },
					},
				],
			},
		],
	};
	session.workout_structure = workout;

	const result = MasterPlanSchema.safeParse(plan);
	assert.equal(result.success, false);
	assert.ok(
		!result.success &&
			result.error.issues.some((issue) =>
				issue.message.includes("containing Monday-Sunday week"),
			),
	);
	assert.ok(
		!result.success &&
			result.error.issues.some((issue) =>
				issue.message.includes("explicit target"),
			),
	);
});
