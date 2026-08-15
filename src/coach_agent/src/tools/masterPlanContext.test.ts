import assert from "node:assert/strict";
import test from "node:test";
import type { ContextSnapshot } from "../graph/master_plan/index.js";
import { createMasterPlanContextTools } from "./masterPlanContext.js";

test("get_master_plan_context returns one bounded provider snapshot for the runtime anchor", async () => {
	const calls: Array<[string, string | undefined]> = [];
	const snapshot = { user: { id: "athlete-1" } } as ContextSnapshot;
	const [tool] = createMasterPlanContextTools({
		async loadSnapshot(userId, asOf) {
			calls.push([userId, asOf]);
			return snapshot;
		},
	});

	assert.ok(tool);
	assert.equal(tool.name, "get_master_plan_context");
	assert.equal(
		await tool.invoke(
			{},
			{ context: { userId: "athlete-1", asof: "2026-05-01" } },
		),
		snapshot,
	);
	assert.deepEqual(calls, [["athlete-1", "2026-05-01"]]);
	await assert.rejects(() => tool.invoke({}, {}), /missing userId/);
	await assert.rejects(
		() => tool.invoke({}, { context: { userId: "athlete-1" } }),
		/missing asof/,
	);
});
