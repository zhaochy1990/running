import { SystemMessage } from "@langchain/core/messages";
import { Command, END, type GraphNode } from "@langchain/langgraph";
import { buildChatModel, getLogger } from "@stride/common";
import type { ModelConfig } from "../config/config.js";
import { normalizeMessageContent } from "./messages.js";
import { type AgentsState, IntentClassificationSchema, type IntentLabel } from "./state.js";

const logger = getLogger("orchestrator");

/** 意图分类提示（导出供边界路由样本单测锁定；devops#587 增 custom_workout，devops#697 增 workout_manage）。 */
export const ORCHESTRATOR_INTENT_PROMPT = `Analyze the user's utterance and classify their intent into one of the following categories. Only output the classification result in a structured format, without providing any answers or training advice.
- "weekly_plan"：查看或调整某一周的训练计划
- "master_plan"：制定或重新制定赛季 / 总体训练计划（生成一份完整的新计划）
- "race_strategy"：为一场具体比赛制定或调整执行策略（分段配速、补给、赛道应对）
- "custom_workout"：创建一次具体的训练课（用户给出组数/距离/配速/休息等课表结构，要生成可保存的单次训练课）；**修改某节已保存训练课的内容**（改组数/配速/时长等，含同时改日期的混合请求）也归这里
- "workout_manage"：**删除**或**改期**一节已保存的训练课（只动日期/存废，不改课表内容）
- "training_question"：关于训练状态、疲劳、指标或跑步知识的问答；查看/解读已生成的计划；**查询赛事日历信息**（某场比赛的时间/城市/项目，一段时间内有哪些比赛——只问事实，不制定策略）
- "other"：不属于以上任何一类

判断依据是用户的**意图**，不是句中出现了「周 / 计划」：问训练跑得怎样、状态如何属于 training_question；查看已写好的计划（周或赛季）分别属于 weekly_plan / training_question；**赛事问答按问的是事实还是方案划界——问赛事事实（时间/城市/项目/赛道/爬升）是 training_question，问怎么跑（配速分段/补给方案）才是 race_strategy**；只有要**生成**或**整体重排**赛季计划才是 master_plan（耗时数分钟的完整规划）；要**创建**单次训练课就是 custom_workout——结构没说全（缺配速/日期/组数）也是 custom_workout（后续会追问补齐），不必等结构完整；描述一节具体课表（组数/距离/配速/休息）要落成单次训练课时才是 custom_workout——调整周计划里的某一天仍是 weekly_plan，「明天跑什么」这类提问仍是 training_question。**对已保存的课只动存废或日期是 workout_manage；动课表内容（改时长/组数/配速，无论是否同时改日期）是 custom_workout**——「把这节课改成 12 分钟 3 组」「改成后天 12 分钟 3 组」都是 custom_workout；「把明天的课删了」「今天训练挪到周五」是 workout_manage；调整周计划（改某天的安排/改成休息）仍是 weekly_plan。
示例（message → intent）：
- "我这周跑的怎么样？" → training_question
- "最近状态怎么样，累不累？" → training_question
- "明天跑什么？" → training_question
- "杭州马拉松什么时候开跑？" → training_question（查赛事信息，不是制定策略）
- "11 月有哪些马拉松？" → training_question
- "杭马的赛道难不难？" → training_question（问赛道事实；要配速/补给方案才是 race_strategy）
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
- "我明天想跑3组4km，每个4k配速350-400，组间休息3分钟，第三个4k跑完接着跑6个400m，配速325-335，组间休息90秒" → custom_workout
- "帮我建一节课：10km 有氧，配速530-600" → custom_workout
- "帮我生成单次训练课程" → custom_workout（想建课但还没给结构，先追问补齐）
- "配速430" → custom_workout（课程创建追问中的回答，结合上文）
- "把明天的课删了" → workout_manage（删除已保存的课）
- "今天训练挪到周五" → workout_manage（只改日期）
- "把这节课改成 12 分钟 3 组" → custom_workout（改课表内容，不是 workout_manage）
- "改成后天 12 分钟 3 组" → custom_workout（改期+改内容的混合请求，归 custom_workout）
- "今天天气怎么样" → other

Provide classification including intent. Respond with a single JSON object: {"intent": "<label>"}.
        `;

export function getOrchestratorNode(modelConfig: ModelConfig, routes: Partial<Record<IntentLabel, string>> = {}): GraphNode<typeof AgentsState> {
  // 角色 yaml 固定 api_kind=chat-completions（DeepSeek），直接取 ChatOpenAI。
  const model = buildChatModel(modelConfig);
  // DeepSeek Chat Completions 两条结构化路都不可靠：response_format json_schema
  // 直接 400（"This response_format type is unavailable now"，2026-10 实证）；
  // functionCalling 依赖 flash 触发 tool call，偶发不触发时 langchain 静默返回
  // undefined，该轮分类必挂兜底（10-20 生产实证：追问轮连挂两次掉 qa）。所以
  // 走 JSON mode（json_object 只保证合法 JSON 文本）+ 本地 zod 硬校验。
  const prompt = ORCHESTRATOR_INTENT_PROMPT;

  const node: GraphNode<typeof AgentsState> = async (state) => {
    // The structured decode is best-effort: a local model may return an
    // off-schema / empty object. Degrade to the previous turn's intent
    // (追问延续的先验：上一轮已进入某任务的对话，本轮更可能是延续而非换题；
    // 首轮 intent 为 null 落 "other") instead of crashing the graph on the
    // strict `intent` channel.
    let parsed: ReturnType<typeof IntentClassificationSchema.safeParse> = { success: false, error: undefined as never };
    try {
      // devops#833：存量 checkpoint 里 responses API 落下的数组 content 消息会被
      // langchain 原样回传，DeepSeek 格式模仿破坏 json_object 约束（纯空白输出）。
      // 分类输入在此归一化——只影响本次调用，不改写 checkpoint。
      const raw = await model.invoke([new SystemMessage(prompt), ...state.messages.map(normalizeMessageContent)], {
        response_format: { type: "json_object" },
      });
      parsed = IntentClassificationSchema.safeParse(JSON.parse(raw.text));
    } catch (error) {
      logger.warn({ error }, "orchestrator: intent decode failed");
    }

    const classification = parsed.success ? parsed.data : (state.intent ?? { intent: "other" as const });
    if (!parsed.success) {
      logger.warn({ fallback: classification }, "orchestrator: intent classification failed; keeping previous intent");
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
