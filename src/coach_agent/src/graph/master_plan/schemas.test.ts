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
						workout_structure: structuredWorkout("2026-08-11", 30000),
					},
					{
						type: "race_pace",
						distance_km: 10,
						duration_min: null,
						intensity: "MP",
						purpose: "race pace",
						workout_structure: structuredWorkout("2026-08-11", 10000),
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

test("strategic sessions may describe easy segments inside the complete workout", () => {
	const plan = createTestMasterPlan();
	const firstSession = plan.weeks[0]?.key_sessions[0];
	assert.ok(firstSession);
	firstSession.intensity = "12km轻松跑 + 8km稳态跑 + 8km轻松跑";
	firstSession.purpose = "Build easy aerobic endurance and late-run stability";
	assert.equal(MasterPlanSchema.safeParse(plan).success, true);
});

test("race week accepts one race-pace activation but rejects other companions", () => {
	const plan = MasterPlanSchema.parse(createTestMasterPlan());
	const raceWeek = plan.weeks[1];
	assert.ok(raceWeek);
	const activation = {
		type: "race_pace" as const,
		distance_km: 16,
		duration_min: 70,
		intensity: "3km热身 + 10km马拉松配速 + 3km放松",
		purpose: "比赛周维持专项节奏和体能",
		workout_structure: structuredWorkout("2026-08-18", 10000),
	};
	raceWeek.key_sessions.unshift(activation);
	assert.equal(MasterPlanSchema.safeParse(plan).success, true);

	raceWeek.key_sessions[0] = { ...activation, type: "threshold" };
	assert.equal(MasterPlanSchema.safeParse(plan).success, false);
});

test("race-week activation enforces the goal-specific race-pace work distance", () => {
	const plan = MasterPlanSchema.parse(createTestMasterPlan());
	const raceWeek = plan.weeks[1];
	assert.ok(raceWeek);
	raceWeek.key_sessions.unshift({
		type: "race_pace",
		distance_km: 8,
		duration_min: 40,
		intensity: "2km热身 + 3km马配 + 3km放松",
		purpose: "比赛周激活",
		workout_structure: structuredWorkout("2026-08-18", 3000),
	});

	const result = MasterPlanSchema.safeParse(plan);
	assert.equal(result.success, false);
	assert.ok(
		!result.success &&
			result.error.issues.some((issue) =>
				issue.message.includes("requires 10-15km"),
			),
	);
});

test("race-week activation requires structured segments", () => {
	const plan = MasterPlanSchema.parse(createTestMasterPlan());
	const raceWeek = plan.weeks[1];
	assert.ok(raceWeek);
	raceWeek.key_sessions.unshift({
		type: "race_pace",
		distance_km: 14,
		duration_min: 65,
		intensity: "10km马配，另含热身放松",
		purpose: "比赛周激活",
		workout_structure: null,
	});
	assert.equal(MasterPlanSchema.safeParse(plan).success, false);
});

function structuredWorkout(date: string, workDistanceM: number) {
	return {
		schema: "run-workout/v1" as const,
		name: "structured workout",
		date,
		note: null,
		blocks: [
			{
				repeat: 1,
				steps: [
					{
						step_kind: "work" as const,
						duration: { kind: "distance_m" as const, value: workDistanceM },
						target: { kind: "pace_s_km" as const, low: 244, high: 240 },
					},
				],
			},
		],
	};
}

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
