import { SystemMessage } from "@langchain/core/messages";
import { Command, END, type GraphNode } from "@langchain/langgraph";
import { buildModel, getLogger } from "@stride/common";
import type { ModelConfig } from "../config/config.js";
import { type AgentsState, IntentClassificationSchema, type IntentLabel } from "./state.js";

const logger = getLogger("orchestrator");

function getAgentPrompt(): string {
  return `Analyze the user's utterance and classify their intent into one of the following categories. Only output the classification result in a structured format, without providing any answers or training advice.
- "weekly_plan"：查看或调整某一周的训练计划
- "master_plan"：制定或重新制定赛季 / 总体训练计划（生成一份完整的新计划）
- "race_strategy"：为一场具体比赛制定或调整执行策略（分段配速、补给、赛道应对）
- "training_question"：关于训练状态、疲劳、指标或跑步知识的问答；查看/解读已生成的计划
- "other"：不属于以上任何一类

判断依据是用户的**意图**，不是句中出现了「周 / 计划」：问训练跑得怎样、状态如何属于 training_question；查看已写好的计划（周或赛季）分别属于 weekly_plan / training_question；只有要**生成**或**整体重排**赛季计划才是 master_plan（耗时数分钟的完整规划）。
示例（message → intent）：
- "我这周跑的怎么样？" → training_question
- "最近状态怎么样，累不累？" → training_question
- "帮我看下这周的训练计划" → weekly_plan
- "下周计划调整一下，周三改成休息" → weekly_plan
- "帮我看下赛季计划" → training_question
- "帮我制定一份下赛季的全马训练计划" → master_plan
- "赛季计划重新规划一下" → master_plan
- "帮我制定杭马的分段配速和补给策略" → race_strategy
- "我想和你聊聊这场比赛的比赛策略" → race_strategy
- "比赛时前半程该跑多快？" → race_strategy
- "2:55" → race_strategy（比赛策略对话中回答目标完赛时间，继续生成策略）
- "再帮我出一版 250 的策略" → race_strategy
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
    const msg = state.messages.at(-1)?.content ?? "";

    logger.info({ classification, input: msg }, "orchestrator: classified intent.");
    // Route inside the node via Command goto — the graph injects the
    // intent→node table; unrouted intents fall through to the `other` node
    // (which produces a reply) and only hit END when no `other` route exists.
    const goto = routes[classification.intent] ?? routes.other ?? END;
    // Clear the race-strategy channel every turn: it is a per-turn artifact, and
    // a stale value from an earlier turn would otherwise ride along in the
    // checkpointed state (a later plain-text turn must not re-persist the old
    // draft over the runner's manual edits).
    return new Command({
      update: { intent: classification, llmCalls: 1, raceStrategy: null },
      goto,
    });
  };

  return node;
}
