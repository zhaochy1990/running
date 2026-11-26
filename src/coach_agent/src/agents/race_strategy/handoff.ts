import { AIMessage, type BaseMessage, ToolMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";
import { z } from "zod/v4";
import { defineCoachTool } from "../../tools/common.js";

export const RACE_STRATEGY_REQUEST = "生成比赛策略";

const viewSchema = z.object({
  answer: z.string().trim().min(1).max(2000).optional().describe("offer 时对用户问题的简短中文回答"),
  refersToPreviousReply: z.boolean().optional().describe("用户问如何查看上一条教练回复里的策略，且没有在问另一场比赛时为 true"),
});
const handoffSchema = viewSchema.extend({ action: z.enum(["generate", "offer"]) });

type StrategyHandoff = z.infer<typeof handoffSchema> | { action: "clarify" };

export const raceStrategyHandoffTool = defineCoachTool({
  name: "handoff_race_strategy",
  description: "在当前会话继续比赛策略。明确要生成或修改用 generate；只问已有建议或策略在哪里看用 offer 并填写 answer。",
  schema: handoffSchema,
  handler: (input) => JSON.stringify(input),
});

export const raceStrategyViewTool = defineCoachTool({
  name: "offer_race_strategy",
  description: "只在用户询问之前的建议或策略在哪里查看时调用，并填写简短回答。",
  schema: viewSchema,
  handler: (input) => JSON.stringify({ action: "offer", ...input }),
});

function isHandoffResult(message: BaseMessage): message is ToolMessage {
  return ToolMessage.isInstance(message) && (message.name === raceStrategyHandoffTool.name || message.name === raceStrategyViewTool.name);
}

/** End the inner turn after the tool batch so the outer graph can route or reply. */
export const raceStrategyHandoffMiddleware = createMiddleware({
  name: "RaceStrategyHandoffMiddleware",
  beforeModel: {
    canJumpTo: ["end"],
    hook: ({ messages }) => {
      // The tool batch is the contiguous set of tool results after the latest model call.
      for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (!message || !ToolMessage.isInstance(message)) break;
        if (isHandoffResult(message)) return { jumpTo: "end" as const };
      }
    },
  },
});

export function readRaceStrategyHandoff(messages: BaseMessage[]): StrategyHandoff | undefined {
  const handoff = messages.findLast(isHandoffResult);
  if (!handoff) return undefined;
  if (handoff.status === "error" || typeof handoff.content !== "string") return { action: "clarify" };
  try {
    const result = handoffSchema.safeParse(JSON.parse(handoff.content));
    return result.success ? result.data : { action: "clarify" };
  } catch {
    return { action: "clarify" };
  }
}

export function raceStrategyViewReply(handoff: StrategyHandoff, history: BaseMessage[]): AIMessage {
  if (handoff.action !== "offer") {
    return new AIMessage("你是想生成比赛策略，还是查看已经保存的版本？");
  }
  if (handoff.refersToPreviousReply) {
    const previous = history.findLast((message): message is AIMessage => AIMessage.isInstance(message) && !message.tool_calls?.length);
    const card = previous?.additional_kwargs.card;
    if (card && typeof card === "object" && "$type" in card && card.$type === "race-strategy") {
      return new AIMessage("刚才的策略在上方，可以直接查看策略卡。");
    }
  }
  const answer = handoff.answer ?? "可以把刚才的配速建议整理成比赛策略。";
  return new AIMessage({
    content: `${answer}\n\n回复「${RACE_STRATEGY_REQUEST}」即可继续。`,
    additional_kwargs: { card: { $type: "race-strategy-offer", data: {} } },
  });
}
