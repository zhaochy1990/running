import { getLogger } from "@stride/common";
import { createAgent } from "langchain";
import type { ModelConfig } from "../../config/config.js";
import { buildModel } from "../common.js";
import { CoachContext } from "../context.js";
import { memoryTools } from "../memory.js";
import { createLoggingMiddleware } from "../middleware.js";

const logger = getLogger("coachAgent:other");

// `other` 承接本版本未接线的意图（weekly_plan / master_plan 读写）以及纯闲聊。
const OTHER_PROMPT = `你是 STRIDE 跑步教练的总控助手。当前版本只接入了「训练问答」能力，你负责处理其余情况：
1. 与跑步训练无关的问题（天气、闲聊等）：礼貌说明你只负责跑步训练相关的问题。
2. 关于训练计划的查看 / 调整 / 生成（周计划、赛季计划）：说明「计划功能正在迁移，暂未接入」，不要擅自生成或修改任何计划。
你可以用记忆工具记住运动员表达的长期目标 / 事实，或读取之前记住的目标。只依据工具数据说话，不要凭空臆测。
`;

/** `other` 业务节点：极简 ReAct agent，兜底回复 + 长期记忆读写。 */
export function getOtherAgent(config: ModelConfig) {
  logger.info(`creating other agent with model ${config.name} (${config.model})`);
  return createAgent({
    model: buildModel(config),
    tools: memoryTools,
    systemPrompt: OTHER_PROMPT,
    contextSchema: CoachContext,
    middleware: [createLoggingMiddleware("agent:other")],
  });
}
