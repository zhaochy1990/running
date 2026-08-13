import assert from "node:assert/strict";
import test from "node:test";
import type { DataProvider } from "../data/dataProvider.js";
import { createActivitiesTools } from "./activities.js";
import { createRaceTools } from "./races.js";
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
	} as unknown as DataProvider;
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
	} as unknown as DataProvider;
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

test("race-history tools bound results to context.asof", async () => {
	const raceCalls: unknown[][] = [];
	const pbCalls: unknown[][] = [];
	const store = {
		async getRaceHistory(...args: unknown[]) {
			raceCalls.push(args);
			return [];
		},
		async getPersonalBests(...args: unknown[]) {
			pbCalls.push(args);
			return [];
		},
	} as unknown as DataProvider;
	const [raceHistory, personalBests] = createRaceTools(store);
	assert.ok(raceHistory);
	assert.ok(personalBests);
	const config = { context: { userId: "athlete", asof: "2026-06-10" } };

	await raceHistory.invoke({ minDistanceKm: 10, limit: 3 }, config);
	await personalBests.invoke({}, config);

	assert.deepEqual(raceCalls, [
		["athlete", { asOfDate: "2026-06-10", minDistanceKm: 10, limit: 3 }],
	]);
	assert.deepEqual(pbCalls, [["athlete", "2026-06-10"]]);
});

test("race-history tools require context.asof", async () => {
	const store = {
		async getRaceHistory() {
			return [];
		},
		async getPersonalBests() {
			return [];
		},
	} as unknown as DataProvider;
	const [raceHistory, personalBests] = createRaceTools(store);
	assert.ok(raceHistory);
	assert.ok(personalBests);

	await assert.rejects(
		() => raceHistory.invoke({}, { context: { userId: "athlete" } }),
		/missing asof/,
	);
	await assert.rejects(
		() => personalBests.invoke({}, { context: { userId: "athlete" } }),
		/missing asof/,
	);
});
