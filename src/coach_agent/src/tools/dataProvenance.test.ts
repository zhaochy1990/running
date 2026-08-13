import assert from "node:assert/strict";
import test from "node:test";
import type { DataProvider } from "../data/dataProvider.js";
import { createActivitiesTools } from "./activities.js";
import { createTrainingLoadTools } from "./trainingLoad.js";

const userId = "athlete-1";
const provider = {
	async getActivitiesByDateRange() {
		return [];
	},
	async getDailyTrainingLoadByDateRange() {
		return [];
	},
} as unknown as DataProvider;

test("activity and load tools label STRIDE provenance", async () => {
	const [activityTool] = createActivitiesTools(provider);
	const [loadTool] = createTrainingLoadTools(provider);
	const config = { context: { userId } };
	assert.deepEqual(
		await activityTool?.invoke({ startDay: "2026-08-01" }, config),
		{
			activities: [],
			provenance: { source: "stride", vendorDerived: false },
		},
	);
	assert.deepEqual(await loadTool?.invoke({ startDay: "2026-08-01" }, config), {
		strideTrainingLoad: [],
		provenance: { source: "stride", vendorDerived: false },
	});
});
