import assert from "node:assert/strict";
import test from "node:test";
import type { WeeklyPlanContext } from "../persistence/index.js";
import { createWeeklyPlanContextTools } from "./weeklyPlanContext.js";

test("get_weekly_plan_context loads the runtime user's bounded snapshot", async () => {
	const calls: Array<[string, string]> = [];
	const snapshot = {
		as_of: "2026-08-14",
		plan_start: "2026-08-17",
	} as WeeklyPlanContext;
	const [tool] = createWeeklyPlanContextTools({
		async loadSnapshot(userId, asOf) {
			calls.push([userId, asOf]);
			return snapshot;
		},
	});

	assert.ok(tool);
	assert.equal(tool.name, "get_weekly_plan_context");
	assert.equal(
		await tool.invoke(
			{},
			{ context: { userId: "athlete-1", asof: "2026-08-14" } },
		),
		snapshot,
	);
	assert.deepEqual(calls, [["athlete-1", "2026-08-14"]]);
	await assert.rejects(() => tool.invoke({}, {}), /missing userId/);
	await assert.rejects(
		() => tool.invoke({}, { context: { userId: "athlete-1" } }),
		/missing asof/,
	);
});
