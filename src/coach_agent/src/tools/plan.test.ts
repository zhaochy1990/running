import assert from "node:assert/strict";
import test from "node:test";
import { StrideDataStore } from "../persistence/index.js";
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
			? { week_folder: weekName, sessions: [] }
			: null;
	}
}

test("plan tools query the MySQL store with the runtime user identity", async () => {
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
		{ week_folder: "2026-07-20_07-26", sessions: [] },
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

test("StrideDataStore queries structured plans by requested day and week", async () => {
	const queries: Array<{ sql: string; values: unknown[] }> = [];
	const pool = {
		async query(sql: string, values: unknown[]) {
			queries.push({ sql, values });
			return [
				[
					{
						content: JSON.stringify(
							queries.length === 1
								? {
										plan_id: "master-1",
										start_date: "2026-06-01",
										end_date: "2026-10-01",
									}
								: { plan_id: "week-1" },
						),
					},
				],
			];
		},
	};
	const store = new StrideDataStore(pool as never);

	assert.deepEqual(await store.getMasterPlan(userId, "2026-07-20"), {
		plan_id: "master-1",
		start_date: "2026-06-01",
		end_date: "2026-10-01",
	});
	assert.deepEqual(await store.getWeeklyPlan(userId, "2026-07-20_07-26"), {
		plan_id: "week-1",
	});
	assert.match(
		queries[0]!.sql,
		/user_id = \?[\s\S]*content_version = 2[\s\S]*status IN \('active', 'archived'\)/,
	);
	assert.deepEqual(queries[0]!.values, [userId]);
	assert.match(
		queries[1]!.sql,
		/user_id = \? AND week_start = \? AND content_version = 2 AND status = 'active'/,
	);
	assert.deepEqual(queries[1]!.values, [userId, "2026-07-20"]);
});

test("StrideDataStore rejects malformed plan JSON", async () => {
	const pool = {
		async query() {
			return [[{ content: "not-json" }]];
		},
	};
	const store = new StrideDataStore(pool as never);
	await assert.rejects(
		() => store.getMasterPlan(userId, "2026-07-20"),
		/master_plan contains invalid JSON/,
	);
});

test("StrideDataStore selects only the master plan covering the requested day", async () => {
	const pool = {
		async query() {
			return [
				[
					{
						plan_id: "past",
						revision: 1,
						status: "archived",
						content: JSON.stringify({
							start_date: "2026-01-01",
							end_date: "2026-05-31",
						}),
					},
					{
						plan_id: "future",
						revision: 2,
						status: "active",
						content: JSON.stringify({
							start_date: "2026-06-01",
							end_date: "2026-10-31",
						}),
					},
				],
			];
		},
	};
	const store = new StrideDataStore(pool as never);
	assert.deepEqual(await store.getMasterPlan(userId, "2026-05-15"), {
		start_date: "2026-01-01",
		end_date: "2026-05-31",
	});
});

test("StrideDataStore rejects ambiguous overlapping master plans", async () => {
	const pool = {
		async query() {
			return [
				[
					{
						plan_id: "one",
						revision: 1,
						status: "archived",
						content: JSON.stringify({
							start_date: "2026-05-01",
							end_date: "2026-06-30",
						}),
					},
					{
						plan_id: "two",
						revision: 2,
						status: "active",
						content: JSON.stringify({
							start_date: "2026-06-01",
							end_date: "2026-10-31",
						}),
					},
				],
			];
		},
	};
	const store = new StrideDataStore(pool as never);
	await assert.rejects(
		() => store.getMasterPlan(userId, "2026-06-15"),
		/multiple master plans cover 2026-06-15/,
	);
});
