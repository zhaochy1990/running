import { StateSchema } from "@langchain/langgraph";
import { z } from "zod/v4";
import type { CoachAgentConfig } from "../../config/config.js";
import type { WeeklyPlanContextProvider } from "../../persistence/weeklyPlanContextProvider.js";
import { getLogger } from "../../utils/logger.js";
import {
	WeeklyPlanGeneratorContext,
	WeeklyPlanGeneratorOutcome,
	WeeklyPlanGeneratorRequest,
} from "./contracts.js";

const logger = getLogger("weekly-plan-graph");

export const GraphInput = new StateSchema({
	request: WeeklyPlanGeneratorRequest,
});
export const GraphOutput = new StateSchema({
	outcome: WeeklyPlanGeneratorOutcome,
});
export const GraphState = new StateSchema({
	request: WeeklyPlanGeneratorRequest,
	context: WeeklyPlanGeneratorContext.optional(),
	greeting: z.string().optional(),
	shouted: z.boolean().default(false),
	outcome: WeeklyPlanGeneratorOutcome.optional(),
});

/** Node implementations for the weekly plan generator graph. */
export class WeeklyPlanGeneratorNodes {
	constructor(
		private readonly config: CoachAgentConfig,
		private readonly contextProvider: WeeklyPlanContextProvider,
	) {}

	readonly initialize = async (
		state: typeof GraphState.State,
		runtime: { context?: WeeklyPlanGeneratorContext },
	) => {
		const request = WeeklyPlanGeneratorRequest.parse(state.request);
		const context = WeeklyPlanGeneratorContext.parse(runtime.context);
		try {
			const asOf = request.requested_as_of ?? new Date().toISOString();
			await this.contextProvider.loadSnapshot(context.userId, asOf);
			logger.info(
				`Loaded weekly plan context for user ${context.userId} as of ${asOf}`,
			);
		} catch (e) {
			logger.error(
				`Failed to load weekly plan context for user ${context.userId}: ${e instanceof Error ? e.message : "unknown error"}`,
			);
			return {
				context,
				outcome: WeeklyPlanGeneratorOutcome.parse({
					decision: "infrastructure_failure",
					request_id: request.request_id,
					generation_id: context.generationId,
					reason: "context_snapshot_unavailable",
				}),
			};
		}
		return { context };
	};

	readonly greet = (state: typeof GraphState.State) => {
		const request = WeeklyPlanGeneratorRequest.parse(state.request);
		logger.info(`Greeting ${request.name} for request ${request.request_id}`);
		return { greeting: `Hello, ${request.name}!` };
	};

	readonly shout = (state: typeof GraphState.State) => {
		const greeting = (state.greeting ?? "").toUpperCase();
		logger.info(`Shouting greeting for request ${state.request.request_id}`);
		return { greeting, shouted: true };
	};

	readonly finalize = (state: typeof GraphState.State) => {
		const request = WeeklyPlanGeneratorRequest.parse(state.request);
		const context = WeeklyPlanGeneratorContext.parse(state.context);
		logger.info(
			`Finalizing request ${request.request_id} with greeting ${state.greeting ?? ""}`,
		);
		return {
			outcome: WeeklyPlanGeneratorOutcome.parse({
				decision: "completed",
				request_id: request.request_id,
				generation_id: context.generationId,
				greeting: state.greeting ?? "",
				shouted: state.shouted,
			}),
		};
	};
}
