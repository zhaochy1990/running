import type { StructuredTool } from "@langchain/core/tools";
import { buildModel, getLogger } from "@stride/common";
import { RaceStrategyDirectResponseSchema } from "@stride/contract";
import { createAgent, ToolStrategy } from "langchain";
import type { ModelConfig } from "../../config/config.js";
import type { DataProvider } from "../../data/dataProvider.js";
import { askUserQuestionTool } from "../../tools/askUserQuestions.js";
import { createRaceStrategyContextTools } from "../../tools/raceStrategyContext.js";
import { CoachContext } from "../context.js";
import { createLoggingMiddleware } from "../middleware.js";
import { RACE_STRATEGY_PROMPT } from "../prompts.js";
import { createTurnScopeMiddleware } from "../turnScope.js";
import { createRaceStrategyValidationMiddleware } from "./validationMiddleware.js";

const logger = getLogger("coachAgent:race_strategy");

/**
 * race_strategy 业务节点：一个带结构化输出的内层 ReAct agent。生成流程由
 * RACE_STRATEGY_PROMPT 硬约束——先取赛事内容与成绩基线，依据不足时以普通
 * 文本回复声明缺口；内容齐全才提交 return_direct 信封。DeepSeek
 * chat-completions 不支持 json_schema response_format，结构化输出走
 * ToolStrategy（function calling），与 orchestrator 的做法一致。
 */
export function getRaceStrategyAgent(store: DataProvider, config: ModelConfig) {
  logger.info(`creating race_strategy agent with model ${config.name} (${config.model})`);

  const tools: StructuredTool[] = [...createRaceStrategyContextTools(store), askUserQuestionTool];

  return createAgent({
    model: buildModel(config),
    tools,
    systemPrompt: RACE_STRATEGY_PROMPT,
    contextSchema: CoachContext,
    responseFormat: ToolStrategy.fromSchema(RaceStrategyDirectResponseSchema),
    middleware: [createTurnScopeMiddleware(), createRaceStrategyValidationMiddleware(), createLoggingMiddleware("agent:race_strategy")],
  });
}
