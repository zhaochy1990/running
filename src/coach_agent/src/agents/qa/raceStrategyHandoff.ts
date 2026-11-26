import { AIMessage, type BaseMessage, ToolMessage } from "@langchain/core/messages";
import { Command, END, type GraphNode } from "@langchain/langgraph";
import { z } from "zod/v4";
import { defineCoachTool } from "../../tools/common.js";
import { normalizeMessageContent } from "../messages.js";
import type { AgentsState } from "../state.js";

export const RACE_STRATEGY_REQUEST = "生成比赛策略";

const handoffSchema = z.object({
  action: z.enum(["generate", "offer"]),
  answer: z.string().trim().min(1).max(2000).optional().describe("offer 时对用户问题的简短中文回答"),
});

export const raceStrategyHandoffTool = defineCoachTool({
  name: "handoff_race_strategy",
  description: "在当前会话继续比赛策略。明确要生成或修改用 generate；只问已有聊天建议在哪里看、为何赛事页没有策略，用 offer 并填写 answer。",
  schema: handoffSchema,
  returnDirect: true,
  handler: (input) => JSON.stringify(input),
});

interface InnerQaAgent {
  invoke(input: unknown, config?: unknown): Promise<{ messages: BaseMessage[] }>;
}

export function makeQaNode(agent: InnerQaAgent): GraphNode<typeof AgentsState> {
  return async (state, config) => {
    const result = await agent.invoke({ messages: state.messages }, config);
    const messages = result.messages.slice(state.messages.length);
    const handoff = messages.findLast((message): message is ToolMessage => ToolMessage.isInstance(message) && message.name === raceStrategyHandoffTool.name);
    const decision = handoff?.status === "error" ? undefined : parseHandoff(handoff?.content);
    if (decision?.action === "generate") {
      return new Command({ goto: "race_strategy", update: { intent: { intent: "race_strategy" } } });
    }
    if (decision?.action === "offer") {
      const answer = decision.answer ?? "如果你想把刚才的建议整理成比赛策略，可以在这段对话里继续。";
      const reply = new AIMessage({
        content: `${answer}\n\n回复「${RACE_STRATEGY_REQUEST}」即可继续。`,
        additional_kwargs: { card: { $type: "race-strategy-offer", data: {} } },
      });
      return new Command({ goto: END, update: { messages: [reply] } });
    }
    if (handoff) {
      const reply = new AIMessage("你是想生成比赛策略，还是查看已经保存的版本？");
      return new Command({ goto: END, update: { messages: [reply] } });
    }
    return new Command({ goto: END, update: { messages: messages.map(normalizeMessageContent) } });
  };
}

function parseHandoff(content: BaseMessage["content"] | undefined): z.infer<typeof handoffSchema> | undefined {
  if (typeof content !== "string") return undefined;
  try {
    const result = handoffSchema.safeParse(JSON.parse(content));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
