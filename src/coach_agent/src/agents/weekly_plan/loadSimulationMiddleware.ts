import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { type ToolRuntime, tool } from "@langchain/core/tools";
import { Command, isCommand } from "@langchain/langgraph";
import { createMiddleware } from "langchain";
import { z } from "zod/v4";
import {
	simulateWeeklyPlanLoad,
	type WeeklyPlanSimulationReport,
	WeeklyPlanSimulationReportSchema,
	weeklyPlanSimulationKey,
} from "../../graph/weekly_plan/simulation.js";
import type { WeeklyPlanContext } from "../../persistence/weeklyPlanContextProvider.js";
import { WeeklyPlanDirectResponseSchema, WeeklyPlanSchema } from "./schema.js";

const MAX_SIMULATION_RETRIES = 2;
const FIXABLE_MISSING_REASONS = new Set([
	"run_workout_structure_missing",
	"planned_session_uncomputable",
	"structured_distance_differs_from_session_total",
]);

const WeeklyPlanLoadStateSchema = z.object({
	_weeklyPlanContext: z.custom<WeeklyPlanContext>().nullable().default(null),
	_weeklyPlanSimulation:
		WeeklyPlanSimulationReportSchema.nullable().default(null),
	_weeklyPlanSimulationKey: z.string().nullable().default(null),
	_weeklyPlanSimulationRetries: z.int().nonnegative().default(0),
});

const simulateWeeklyPlanLoadTool = tool(
	(
		{ plan },
		runtime: ToolRuntime<typeof WeeklyPlanLoadStateSchema>,
	): Command => {
		const context = runtime.state._weeklyPlanContext;
		if (!context) {
			throw new Error(
				"simulate_weekly_plan_load requires get_weekly_plan_context first",
			);
		}
		const report = simulateWeeklyPlanLoad(plan, context);
		return new Command({
			update: {
				messages: [
					new ToolMessage({
						name: "simulate_weekly_plan_load",
						tool_call_id: runtime.toolCallId,
						content: JSON.stringify(report),
					}),
				],
				_weeklyPlanSimulation: report,
				_weeklyPlanSimulationKey: weeklyPlanSimulationKey(plan),
			},
		});
	},
	{
		name: "simulate_weekly_plan_load",
		description:
			"Deterministically estimate every run session's STRIDE training dose and project daily CTL, ATL, Form, and load ratio for one complete candidate WeeklyPlan. Call this with the final candidate before returning it.",
		schema: z.strictObject({ plan: WeeklyPlanSchema }),
	},
);

/** Force generate_weekly_plan to simulate and return the exact audited candidate. */
export function createWeeklyPlanLoadSimulationMiddleware() {
	return createMiddleware({
		name: "WeeklyPlanLoadSimulationMiddleware",
		stateSchema: WeeklyPlanLoadStateSchema,
		tools: [simulateWeeklyPlanLoadTool],
		beforeAgent: () => ({
			_weeklyPlanContext: null,
			_weeklyPlanSimulation: null,
			_weeklyPlanSimulationKey: null,
			_weeklyPlanSimulationRetries: 0,
		}),
		wrapToolCall: async (request, handler) => {
			const result = await handler(request);
			if (request.toolCall.name !== "get_weekly_plan_context") return result;
			if (isCommand(result) || !ToolMessage.isInstance(result)) return result;
			const context = parseContextToolMessage(result);
			return new Command({
				update: {
					messages: [result],
					_weeklyPlanContext: context,
					_weeklyPlanSimulation: null,
					_weeklyPlanSimulationKey: null,
				},
			});
		},
		afterModel: {
			canJumpTo: ["model"],
			hook: (state) => {
				if (state.structuredResponse === undefined) return;
				const parsed = WeeklyPlanDirectResponseSchema.safeParse(
					state.structuredResponse,
				);
				if (!parsed.success)
					return retryOrThrow(
						state._weeklyPlanSimulationRetries,
						`The WeeklyPlan failed canonical validation: ${formatIssues(parsed.error.issues)}`,
					);

				const plan = parsed.data.content;
				const report = state._weeklyPlanSimulation;
				if (
					state._weeklyPlanSimulationKey !== weeklyPlanSimulationKey(plan) ||
					report === null
				)
					return retryOrThrow(
						state._weeklyPlanSimulationRetries,
						"Call simulate_weekly_plan_load with the complete final candidate, inspect its report, then return that exact unchanged candidate.",
					);

				const blockingIssues = blockingSimulationIssues(report);
				if (blockingIssues.length > 0)
					return retryOrThrow(
						state._weeklyPlanSimulationRetries,
						`Revise the candidate to clear every deterministic load issue, simulate it again, and return the re-simulated candidate: ${blockingIssues.join(", ")}`,
					);
			},
		},
	});
}

function parseContextToolMessage(message: ToolMessage): WeeklyPlanContext {
	if (typeof message.content !== "string")
		throw new Error("get_weekly_plan_context returned non-text content");
	try {
		return JSON.parse(message.content) as WeeklyPlanContext;
	} catch {
		throw new Error("get_weekly_plan_context returned invalid JSON");
	}
}

function blockingSimulationIssues(
	report: WeeklyPlanSimulationReport,
): string[] {
	return [
		...report.safety_issues,
		...report.missing_dose_reasons.filter((reason) =>
			FIXABLE_MISSING_REASONS.has(reason),
		),
	];
}

function retryOrThrow(retries: number, issue: string) {
	if (retries >= MAX_SIMULATION_RETRIES)
		throw new Error(
			`Weekly plan failed deterministic load simulation after ${MAX_SIMULATION_RETRIES + 1} attempts: ${issue}`,
		);
	return {
		_weeklyPlanSimulationRetries: retries + 1,
		messages: [new HumanMessage(issue)],
		jumpTo: "model" as const,
	};
}

function formatIssues(issues: z.core.$ZodIssue[]): string {
	return issues
		.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
		.join("; ");
}
