import type { StructuredTool } from "@langchain/core/tools";
import { buildModel, getLogger } from "@stride/common";
import { CustomWorkoutLenientDirectResponseSchema } from "@stride/contract";
import { createAgent, ToolStrategy } from "langchain";
import type { ModelConfig } from "../../config/config.js";
import type { DataProvider } from "../../data/dataProvider.js";
import { createRunningCalibrationTools } from "../../tools/runningCalibration.js";
import { CoachContext } from "../context.js";
import { createCurrentDateMiddleware, createLoggingMiddleware } from "../middleware.js";
import { CUSTOM_WORKOUT_PROMPT } from "../prompts.js";
import { createCustomWorkoutValidationMiddleware } from "./validationMiddleware.js";

const logger = getLogger("coachAgent:custom_workout");

/**
 * custom_workout 业务节点的内层 agent：自然语言单次课表 → run-workout/v1 草稿
 * 信封（devops#587）。与 race_strategy 同模式——DeepSeek chat-completions 不
 * 支持 json_schema response_format，结构化输出走 ToolStrategy（function
 * calling）；信封走 lenient 契约，节点侧 normalize 后确定性补齐卡片标量。
 *
 * 不挂 askUserQuestionTool：追问一律普通文本回复（缺日期/缺关键结构时），
 * 理由与 race_strategy 相同（内层 agent 无 checkpointer，interrupt 语义不成立）。
 */
export function getCustomWorkoutAgent(store: DataProvider, config: ModelConfig) {
  logger.info(`creating custom_workout agent with model ${config.name} (${config.model})`);

  const tools: StructuredTool[] = [...createRunningCalibrationTools(store)];

  return createAgent({
    model: buildModel(config),
    tools,
    systemPrompt: CUSTOM_WORKOUT_PROMPT,
    contextSchema: CoachContext,
    responseFormat: ToolStrategy.fromSchema(CustomWorkoutLenientDirectResponseSchema),
    middleware: [createCurrentDateMiddleware(), createCustomWorkoutValidationMiddleware(), createLoggingMiddleware("agent:custom_workout")],
  });
}
