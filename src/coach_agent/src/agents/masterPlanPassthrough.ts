import { AIMessage } from "@langchain/core/messages";
import { DirectResponseEnvelopeSchema } from "@stride/contract";
import { createMiddleware } from "langchain";

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
 *
 * #858 PR-F：`generate_weekly_plan` 直出信封分支已随聊天侧周课生成路径
 * 退役——周课由 master 首批物化 + 滚动投影落库，passthrough 只剩 master 一条。
 */
function getPlanTaskResult(messages: readonly MessageLike[], acceptedSubagents: readonly string[]): string | undefined {
  const result = messages.at(-1);
  if (result?.type !== "tool" || result.status === "error" || typeof result.content !== "string") {
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
    const envelope = DirectResponseEnvelopeSchema.safeParse(JSON.parse(result.content));
    if (!envelope.success) return undefined;
    return JSON.stringify(envelope.data.content);
  } catch {
    return undefined;
  }
}

export function getMasterPlanTaskResult(messages: readonly MessageLike[]): string | undefined {
  return getPlanTaskResult(messages, ["generate_master_plan"]);
}

/** Avoid an LLM round-trip that can rewrite a structured generated plan. */
export function createPlanPassthroughMiddleware() {
  return createMiddleware({
    name: "PlanPassthroughMiddleware",
    wrapModelCall: async (request, handler) => {
      const result = getMasterPlanTaskResult(request.messages as MessageLike[]);
      return result === undefined ? handler(request) : new AIMessage({ content: result });
    },
  });
}
