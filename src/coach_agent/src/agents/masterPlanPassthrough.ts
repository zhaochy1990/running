import { AIMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";
import { DirectResponseEnvelopeSchema } from "./master_plan/schema.js";
import { WeeklyPlanDirectResponseSchema } from "./weekly_plan/schema.js";

type MessageLike = {
	type?: unknown;
	name?: unknown;
	content?: unknown;
	status?: unknown;
	tool_call_id?: unknown;
	tool_calls?: Array<{
		id?: unknown;
		name?: unknown;
		args?: { subagent_type?: unknown };
	}>;
};

/**
 * Returns the content of an explicit direct-response envelope tied to the
 * preceding generator call. Plan quality belongs to the generator/reviewer;
 * the orchestrator only honors the declared handoff disposition.
 */
function getPlanTaskResult(
	messages: readonly MessageLike[],
	acceptedSubagents: readonly string[],
): string | undefined {
	const result = messages.at(-1);
	if (
		result?.type !== "tool" ||
		result.status === "error" ||
		typeof result.content !== "string"
	) {
		return undefined;
	}
	const generatorCall = messages
		.at(-2)
		?.tool_calls?.find(
			(call) =>
				call.id === result.tool_call_id &&
				call.name === "task" &&
				typeof call.args?.subagent_type === "string" &&
				acceptedSubagents.includes(call.args.subagent_type),
		);
	if (generatorCall === undefined) return undefined;
	try {
		const schema =
			generatorCall.args?.subagent_type === "weekly_plan"
				? WeeklyPlanDirectResponseSchema
				: DirectResponseEnvelopeSchema;
		const envelope = schema.safeParse(JSON.parse(result.content));
		return envelope.success ? JSON.stringify(envelope.data.content) : undefined;
	} catch {
		return undefined;
	}
}

export function getMasterPlanTaskResult(
	messages: readonly MessageLike[],
): string | undefined {
	return getPlanTaskResult(messages, ["generate_master_plan"]);
}

/** Return validated generated plan content without an orchestrator rewrite. */
export function getDirectPlanTaskResult(
	messages: readonly MessageLike[],
): string | undefined {
	return getPlanTaskResult(messages, ["generate_master_plan", "weekly_plan"]);
}

/** Avoid an LLM round-trip that can rewrite a structured generated plan. */
export function createPlanPassthroughMiddleware() {
	return createMiddleware({
		name: "PlanPassthroughMiddleware",
		wrapModelCall: async (request, handler) => {
			const result = getDirectPlanTaskResult(request.messages as MessageLike[]);
			return result === undefined
				? handler(request)
				: new AIMessage({ content: result });
		},
	});
}

/** @deprecated Use createPlanPassthroughMiddleware. */
export const createMasterPlanPassthroughMiddleware =
	createPlanPassthroughMiddleware;
