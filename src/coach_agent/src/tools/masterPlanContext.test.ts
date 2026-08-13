import assert from "node:assert/strict";
import test from "node:test";
import type { ContextSnapshot } from "../graph/master_plan/index.js";
import { createMasterPlanContextTools } from "./masterPlanContext.js";

test("get_master_plan_context returns one bounded provider snapshot for the runtime user", async () => {
	const calls: string[] = [];
	const snapshot = { user: { id: "athlete-1" } } as ContextSnapshot;
	const [tool] = createMasterPlanContextTools({
		async loadSnapshot(userId) {
			calls.push(userId);
			return snapshot;
		},
	});

	assert.ok(tool);
	assert.equal(tool.name, "get_master_plan_context");
	assert.equal(
		await tool.invoke({}, { context: { userId: "athlete-1" } }),
		snapshot,
	);
	assert.deepEqual(calls, ["athlete-1"]);
	await assert.rejects(() => tool.invoke({}, {}), /missing userId/);
});
