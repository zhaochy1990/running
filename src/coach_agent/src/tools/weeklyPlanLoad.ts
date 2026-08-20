import type { StructuredTool } from "@langchain/core/tools";
import { WeeklyPlanSchema } from "@stride/contract";
import * as z from "zod";
import type { CoachToolRuntime } from "../agents/coachAgent.js";
import { simulateWeeklyPlanLoad } from "../graph/weekly_plan/simulation.js";
import type { WeeklyPlanContextProvider } from "../persistence/weeklyPlanContextProvider.js";
import { defineCoachTools } from "./common.js";

const simulateWeeklyPlanLoadSchema = z.strictObject({
	plan: WeeklyPlanSchema,
});

/** Build the deterministic load-simulation tool used by the weekly generator. */
export function createWeeklyPlanLoadTools(
	provider: WeeklyPlanContextProvider,
): StructuredTool[] {
	return defineCoachTools([
		{
			name: "simulate_weekly_plan_load",
			description:
				"Deterministically estimate every run session's STRIDE training dose and project daily CTL, ATL, Form, and load ratio for one complete candidate WeeklyPlan. Call this with the final candidate before returning it.",
			schema: simulateWeeklyPlanLoadSchema,
			handler: async ({ plan }, runtime: CoachToolRuntime) => {
				const userId = runtime.context?.userId;
				const asof = runtime.context?.asof;
				if (!userId)
					throw new Error(
						"simulate_weekly_plan_load: missing userId in runtime context",
					);
				if (!asof)
					throw new Error(
						"simulate_weekly_plan_load: missing asof in runtime context",
					);
				const context = await provider.loadSnapshot(userId, asof);
				return simulateWeeklyPlanLoad(plan, context);
			},
		},
	]);
}
