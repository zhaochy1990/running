import { AIMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";
import { MasterPlanSchema } from "./master_plan/schema.js";

type MessageLike = {
  type?: unknown;
  name?: unknown;
  content?: unknown;
  tool_call_id?: unknown;
  tool_calls?: Array<{
    id?: unknown;
    name?: unknown;
    args?: { subagent_type?: unknown };
  }>;
};

/**
 * Returns a master-plan task result only when it is a bare JSON object tied to
 * the preceding `task` call. The returned string is deliberately not parsed
 * and re-serialized so its exact bytes reach the athlete.
 */
export function getMasterPlanTaskResult(messages: readonly MessageLike[]): string | undefined {
  const result = messages.at(-1);
  if (result?.type !== "tool" || result.name !== "task" || typeof result.content !== "string") {
    return undefined;
  }
  const generatorCall = messages.at(-2)?.tool_calls?.find((call) => (
    call.id === result.tool_call_id
    && call.name === "task"
    && call.args?.subagent_type === "generate_master_plan"
  ));
  if (generatorCall === undefined) return undefined;
  try {
    return MasterPlanSchema.safeParse(JSON.parse(result.content)).success ? result.content : undefined;
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
      return result === undefined ? handler(request) : new AIMessage({ content: result });
    },
  });
}
