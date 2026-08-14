import assert from "node:assert/strict";
import test from "node:test";
import type { StrideDataStore } from "../persistence/index.js";
import { createActivitiesTools } from "./activities.js";
import { createTrainingLoadTools } from "./trainingLoad.js";

test("date-range tools default their inclusive end to context.asof", async () => {
	const activityCalls: string[][] = [];
	const loadCalls: string[][] = [];
	const store = {
		async getActivitiesByDateRange(...args: string[]) {
			activityCalls.push(args);
			return [];
		},
		async getDailyTrainingLoadByDateRange(...args: string[]) {
			loadCalls.push(args);
			return [];
		},
	} as unknown as StrideDataStore;
	const [activities] = createActivitiesTools(store);
	const [loads] = createTrainingLoadTools(store);
	assert.ok(activities);
	assert.ok(loads);
	const config = { context: { userId: "athlete", asof: "2026-05-15" } };

	await activities.invoke({ startDay: "2026-05-01" }, config);
	await loads.invoke({ startDay: "2026-05-01" }, config);

	assert.deepEqual(activityCalls, [["athlete", "2026-05-01", "2026-05-15"]]);
	assert.deepEqual(loadCalls, [["athlete", "2026-05-01", "2026-05-15"]]);
});

test("date-range tools require asof even when an explicit end is supplied", async () => {
	const store = {
		async getActivitiesByDateRange() {
			return [];
		},
	} as unknown as StrideDataStore;
	const [activities] = createActivitiesTools(store);
	assert.ok(activities);

	await assert.rejects(
		() =>
			activities.invoke(
				{ startDay: "2026-05-01", endDay: "2026-05-02" },
				{ context: { userId: "athlete" } },
			),
		/missing asof/,
	);
});
