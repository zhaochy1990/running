import { AIMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";
import { MasterPlanSchema } from "./master_plan/schema.js";

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

const MASTER_PLAN_SEMANTIC_ISSUES = new Set([
	"must be null for an incomplete phase",
	"recovery weeks may contain at most one strategic key session",
	"weeks may contain at most three strategic key sessions",
	"race weeks may contain only the target race key session",
	"ordinary easy/recovery/filler runs do not belong in the strategic skeleton",
	"embedded race-pace work must be represented only by its long_run session",
	"must equal weeks.length",
	"phase names must be unique",
	"must be consecutive from 1",
]);

/**
 * Returns a master-plan task result only when it is a JSON object tied to the
 * preceding generator call. Plan quality belongs to the generator/reviewer;
 * it must not trigger an orchestrator rewrite. The string is deliberately not
 * re-serialized so its exact bytes reach the athlete.
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
		const parsed: unknown = JSON.parse(result.content);
		const validation = MasterPlanSchema.safeParse(parsed);
		return validation.success ||
			validation.error.issues.every(
				(issue) =>
					issue.code === "custom" &&
					MASTER_PLAN_SEMANTIC_ISSUES.has(issue.message),
			)
			? result.content
			: undefined;
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
