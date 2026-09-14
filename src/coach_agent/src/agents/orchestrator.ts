import { SystemMessage } from "@langchain/core/messages";
import { Command, END, type GraphNode } from "@langchain/langgraph";
import { getLogger } from "@stride/common";
import type { ModelConfig } from "../config/config.js";
import { buildModel } from "./common.js";
import { type AgentsState, IntentClassificationSchema, type IntentLabel } from "./state.js";

const logger = getLogger("orchestrator");

function getAgentPrompt(): string {
  return `Analyze the user's utterance and classify their intent into one of the following categories. Only output the classification result in a structured format, without providing any answers or training advice.
- "weekly_plan"：查看或调整某一周的训练计划
- "master_plan"：查看或调整赛季 / 总体训练计划
- "training_question"：关于训练状态、疲劳、指标或跑步知识的问答
- "other"：不属于以上任何一类

判断依据是用户的**意图**，不是句中出现了「周 / 计划」：问训练跑得怎样、状态如何属于 training_question，只有想查看或修改已写好的计划才是 weekly_plan。
示例（message → intent）：
- "我这周跑的怎么样？" → training_question
- "最近状态怎么样，累不累？" → training_question
- "帮我看下这周的训练计划" → weekly_plan
- "下周计划调整一下，周三改成休息" → weekly_plan
- "帮我看下赛季计划" → master_plan
- "今天天气怎么样" → other

Provide classification including intent.
        `;
}

export function getOrchestratorNode(modelConfig: ModelConfig, routes: Partial<Record<IntentLabel, string>> = {}): GraphNode<typeof AgentsState> {
  const model = buildModel(modelConfig);
  // Create structured LLM that returns an IntentClassification object.
  // DeepSeek Chat Completions does not support the `json_schema` response_format,
  // so force function-calling (tool-calling) mode for the structured decode.
  const structuredLlm = model.withStructuredOutput(IntentClassificationSchema, { method: "functionCalling" });
  const prompt = getAgentPrompt();

  const node: GraphNode<typeof AgentsState> = async (state) => {
    const raw = await structuredLlm.invoke([new SystemMessage(prompt), ...state.messages]);

    // The structured decode is best-effort: a local model may return an
    // off-schema / empty object. Degrade to "other" instead of crashing the
    // graph on the strict `intent` channel.
    const parsed = IntentClassificationSchema.safeParse(raw);
    const classification = parsed.success ? parsed.data : { intent: "other" as const };
    if (!parsed.success) {
      logger.warn({ raw, issues: parsed.error.issues }, "orchestrator: intent classification did not match schema; defaulting to 'other'");
    }

    // Route inside the node via Command goto — the graph injects the
    // intent→node table; unrouted intents fall through to the `other` node
    // (which produces a reply) and only hit END when no `other` route exists.
    const goto = routes[classification.intent] ?? routes.other ?? END;
    return new Command({
      update: { intent: classification, llmCalls: 1 },
      goto,
    });
  };

  return node;
}
