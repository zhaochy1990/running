import type { StructuredTool } from "@langchain/core/tools";
import { buildModel, getLogger } from "@stride/common";
import { RaceStrategyDirectResponseSchema } from "@stride/contract";
import { createAgent, ToolStrategy } from "langchain";
import type { ModelConfig } from "../../config/config.js";
import type { DataProvider } from "../../data/dataProvider.js";
import { createAskUserForGoalTool, createRaceStrategyContextTools } from "../../tools/raceStrategyContext.js";
import { CoachContext } from "../context.js";
import { createLoggingMiddleware } from "../middleware.js";
import { RACE_STRATEGY_PROMPT } from "../prompts.js";
import { createTurnScopeMiddleware } from "../turnScope.js";
import { createRaceStrategyValidationMiddleware } from "./validationMiddleware.js";

const logger = getLogger("coachAgent:race_strategy");

/**
 * race_strategy 业务节点：一个带结构化输出的内层 ReAct agent。生成流程由
 * RACE_STRATEGY_PROMPT 硬约束——先取赛事内容；目标成绩只来自运动员本人的
 * 消息，没有就调用 ask_user_for_goal（一句话追问文案由工具查 race_goal 后
 * 确定性生成，外层节点检测到该调用后直接采用工具文案，不透传模型自己的
 * 追问）；内容齐全才提交 return_direct 信封。DeepSeek chat-completions 不
 * 支持 json_schema response_format，结构化输出走 ToolStrategy（function
 * calling），与 orchestrator 的做法一致。
 *
 * 注意不挂 askUserQuestionTool：内层 agent 不带 checkpointer 编译，interrupt()
 * 会直接抛错；且客户端对追问的下一条消息走新 message 而非 resume，中断语义
 * 两头都不成立。追问一律走 ask_user_for_goal 工具 + 节点替换。
 */
export function getRaceStrategyAgent(store: DataProvider, config: ModelConfig) {
  logger.info(`creating race_strategy agent with model ${config.name} (${config.model})`);

  const tools: StructuredTool[] = [...createRaceStrategyContextTools(store), createAskUserForGoalTool(store)];

  return createAgent({
    model: buildModel(config),
    tools,
    systemPrompt: RACE_STRATEGY_PROMPT,
    contextSchema: CoachContext,
    responseFormat: ToolStrategy.fromSchema(RaceStrategyDirectResponseSchema),
    middleware: [createTurnScopeMiddleware(), createRaceStrategyValidationMiddleware(), createLoggingMiddleware("agent:race_strategy")],
  });
}
