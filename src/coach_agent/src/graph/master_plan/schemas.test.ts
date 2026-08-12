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
