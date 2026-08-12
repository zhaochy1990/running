import { AIMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";
import { DirectResponseEnvelopeSchema } from "./master_plan/schema.js";

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
export function getMasterPlanTaskResult(
	messages: readonly MessageLike[],
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
				call.args?.subagent_type === "generate_master_plan",
		);
	if (generatorCall === undefined) return undefined;
	try {
		const envelope = DirectResponseEnvelopeSchema.safeParse(
			JSON.parse(result.content),
		);
		return envelope.success ? JSON.stringify(envelope.data.content) : undefined;
	} catch {
		return undefined;
	}
}

/** Avoid an LLM round-trip that can rewrite a structured master-plan result. */
export function createMasterPlanPassthroughMiddleware() {
	return createMiddleware({
		name: "MasterPlanPassthroughMiddleware",
		wrapModelCall: async (request, handler) => {
			const result = getMasterPlanTaskResult(request.messages as MessageLike[]);
			return result === undefined
				? handler(request)
				: new AIMessage({ content: result });
		},
	});
}
