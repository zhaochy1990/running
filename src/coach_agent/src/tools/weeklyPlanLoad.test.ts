import assert from "node:assert/strict";
import test from "node:test";
import {
	createWeeklyPlanForSimulation,
	createWeeklyPlanSimulationContext,
} from "../graph/weekly_plan/testFixtures.js";
import { createWeeklyPlanLoadTools } from "./weeklyPlanLoad.js";

test("simulate_weekly_plan_load loads context and returns the deterministic report", async () => {
	const calls: Array<[string, string]> = [];
	const [tool] = createWeeklyPlanLoadTools({
		async loadSnapshot(userId, asOf) {
			calls.push([userId, asOf]);
			return createWeeklyPlanSimulationContext();
		},
	});

	assert.ok(tool);
	assert.equal(tool.name, "simulate_weekly_plan_load");
	const report = (await tool.invoke(
		{ plan: createWeeklyPlanForSimulation() },
		{ context: { userId: "athlete-1", asof: "2026-08-14" } },
	)) as { available: boolean; total_dose: number | null };

	assert.equal(report.available, true);
	assert.ok((report.total_dose ?? 0) > 0);
	assert.deepEqual(calls, [["athlete-1", "2026-08-14"]]);
});

test("simulate_weekly_plan_load requires runtime identity and asof", async () => {
	const [tool] = createWeeklyPlanLoadTools({
		async loadSnapshot() {
			return createWeeklyPlanSimulationContext();
		},
	});
	assert.ok(tool);
	const input = { plan: createWeeklyPlanForSimulation() };

	await assert.rejects(() => tool.invoke(input, {}), /missing userId/);
	await assert.rejects(
		() => tool.invoke(input, { context: { userId: "athlete-1" } }),
		/missing asof/,
	);
});
