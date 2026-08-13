import assert from "node:assert/strict";
import test from "node:test";
import { createPlanTools, type PlanStore } from "./plan.js";

const userId = "athlete-1";

class FakePlanStore implements PlanStore {
	calls: Array<{
		method: string;
		userId: string;
		weekName?: string;
		day?: string;
	}> = [];

	async getMasterPlan(requestUserId: string, day: string) {
		this.calls.push({ method: "master", userId: requestUserId, day });
		return requestUserId === userId
			? { plan_id: "master-1", status: "active" }
			: null;
	}

	async getWeeklyPlan(requestUserId: string, weekName: string) {
		this.calls.push({ method: "weekly", userId: requestUserId, weekName });
		return requestUserId === userId && weekName === "2026-07-20_07-26"
			? { week_name: weekName, sessions: [] }
			: null;
	}
}

test("plan tools query the data provider with the runtime user identity", async () => {
	const store = new FakePlanStore();
	const [masterTool, weeklyTool] = createPlanTools(store as never);
	const config = { context: { userId, asof: "2026-07-20" } };

	assert.equal(masterTool!.name, "get_master_plan");
	assert.equal(weeklyTool!.name, "get_weekly_plan");
	assert.deepEqual(await masterTool!.invoke({}, config), {
		plan_id: "master-1",
		status: "active",
	});
	assert.deepEqual(
		await weeklyTool!.invoke({ weekName: "2026-07-20_07-26" }, config),
		{ week_name: "2026-07-20_07-26", sessions: [] },
	);
	assert.deepEqual(store.calls, [
		{ method: "master", userId, day: "2026-07-20" },
		{ method: "weekly", userId, weekName: "2026-07-20_07-26" },
	]);
});

test("plan tools reject calls without a runtime user identity", async () => {
	const [masterTool] = createPlanTools(new FakePlanStore() as never);
	await assert.rejects(() => masterTool!.invoke({}, {}), /missing userId/);
	await assert.rejects(
		() => masterTool!.invoke({}, { context: { userId } }),
		/missing asof/,
	);
});
