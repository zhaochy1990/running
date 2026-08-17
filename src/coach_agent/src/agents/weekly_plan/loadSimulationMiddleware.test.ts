import assert from "node:assert/strict";
import test from "node:test";
import { HumanMessage } from "@langchain/core/messages";
import { isCommand } from "@langchain/langgraph";
import {
	simulateWeeklyPlanLoad,
	weeklyPlanSimulationKey,
} from "../../graph/weekly_plan/simulation.js";
import {
	createWeeklyPlanSimulationContext,
	createWeeklyPlanForSimulation as weeklyPlan,
} from "../../graph/weekly_plan/testFixtures.js";
import { createWeeklyPlanLoadSimulationMiddleware } from "./loadSimulationMiddleware.js";

const context = createWeeklyPlanSimulationContext();

function afterModelHook() {
	const hook = createWeeklyPlanLoadSimulationMiddleware().afterModel;
	assert.ok(hook && typeof hook !== "function");
	return hook.hook;
}

test("weekly generator must simulate before returning a structured response", async () => {
	const result = await afterModelHook()(
		{
			messages: [],
			structuredResponse: {
				disposition: "return_direct",
				content: weeklyPlan(),
			},
			_weeklyPlanContext: context,
			_weeklyPlanSimulation: null,
			_weeklyPlanSimulationKey: null,
			_weeklyPlanSimulationRetries: 0,
		} as never,
		{} as never,
	);

	assert.ok(result);
	assert.equal(result.jumpTo, "model");
	assert.equal(result._weeklyPlanSimulationRetries, 1);
	assert.ok(HumanMessage.isInstance(result.messages?.[0]));
});

test("weekly generator accepts the exact simulated candidate", async () => {
	const plan = weeklyPlan();
	const result = await afterModelHook()(
		{
			messages: [],
			structuredResponse: { disposition: "return_direct", content: plan },
			_weeklyPlanContext: context,
			_weeklyPlanSimulation: simulateWeeklyPlanLoad(plan, context),
			_weeklyPlanSimulationKey: weeklyPlanSimulationKey(plan),
			_weeklyPlanSimulationRetries: 0,
		} as never,
		{} as never,
	);

	assert.equal(result, undefined);
});

test("weekly generator must re-simulate after editing the candidate", async () => {
	const simulated = weeklyPlan();
	const returned = weeklyPlan();
	returned.coach_notes = "changed after simulation";
	const result = await afterModelHook()(
		{
			messages: [],
			structuredResponse: { disposition: "return_direct", content: returned },
			_weeklyPlanContext: context,
			_weeklyPlanSimulation: simulateWeeklyPlanLoad(simulated, context),
			_weeklyPlanSimulationKey: weeklyPlanSimulationKey(simulated),
			_weeklyPlanSimulationRetries: 0,
		} as never,
		{} as never,
	);

	assert.equal(result?.jumpTo, "model");
});

test("weekly generator must revise a simulated overreach candidate", async () => {
	const overloadedContext = createWeeklyPlanSimulationContext();
	const strideLoad = overloadedContext.fitness_state.stride_training_load as {
		available: boolean;
		acute_load: number;
		chronic_load: number;
	};
	assert.equal(strideLoad.available, true);
	strideLoad.acute_load = 120;
	strideLoad.chronic_load = 40;
	const plan = weeklyPlan();
	const result = await afterModelHook()(
		{
			messages: [],
			structuredResponse: { disposition: "return_direct", content: plan },
			_weeklyPlanContext: overloadedContext,
			_weeklyPlanSimulation: simulateWeeklyPlanLoad(plan, overloadedContext),
			_weeklyPlanSimulationKey: weeklyPlanSimulationKey(plan),
			_weeklyPlanSimulationRetries: 0,
		} as never,
		{} as never,
	);

	assert.equal(result?.jumpTo, "model");
	assert.match(
		String(result?.messages?.[0]?.content),
		/planned_load_extends_overreach_more_than_1_25_to_3_consecutive_days/,
	);
});

test("simulation tool stores its report and candidate identity in agent state", async () => {
	const middleware = createWeeklyPlanLoadSimulationMiddleware();
	const simulator = middleware.tools?.find(
		(candidate) =>
			"name" in candidate && candidate.name === "simulate_weekly_plan_load",
	);
	assert.ok(simulator && "invoke" in simulator);
	const plan = weeklyPlan();
	const result = await simulator.invoke(
		{
			name: "simulate_weekly_plan_load",
			args: { plan },
			id: "simulate-1",
			type: "tool_call",
		},
		{
			state: {
				messages: [],
				_weeklyPlanContext: context,
				_weeklyPlanSimulation: null,
				_weeklyPlanSimulationKey: null,
				_weeklyPlanSimulationRetries: 0,
			},
		} as never,
	);

	assert.ok(isCommand(result));
	const update = (result as { update?: unknown }).update as Record<
		string,
		unknown
	>;
	assert.equal(update._weeklyPlanSimulationKey, weeklyPlanSimulationKey(plan));
	assert.equal(
		(update._weeklyPlanSimulation as { available?: unknown }).available,
		true,
	);
});
