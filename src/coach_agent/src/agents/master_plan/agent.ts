import { buildResponsesModel, getLogger } from "@stride/common";
import type { ModelConfig } from "../../config/config.js";
import type { DataProvider } from "../../data/dataProvider.js";
import { createActivitiesTools } from "../../tools/activities.js";
import { askUserQuestionTool } from "../../tools/askUserQuestions.js";
import { createPlanTools } from "../../tools/plan.js";
import { createRaceTools } from "../../tools/races.js";
import { createRunningCalibrationTools } from "../../tools/runningCalibration.js";
import { createTrainingLoadTools } from "../../tools/trainingLoad.js";
import { MASTER_PLAN_READ_PROMPT } from "../prompts.js";
import { createLoggingMiddleware } from "../middleware.js";
import { createTurnScopeMiddleware } from "../turnScope.js";

const logger = getLogger("coachAgent:master_plan");

/** 只读赛季计划视图的子代理定义（讲解既有计划，不生成；R7 后聊天内生成已退役）。 */
export function getMasterPlanSubagent(store: DataProvider, config: ModelConfig) {
  const tools = [
    ...createActivitiesTools(store),
    ...createTrainingLoadTools(store),
    ...createPlanTools(store),
    ...createRaceTools(store),
    ...createRunningCalibrationTools(store),
    askUserQuestionTool,
  ];
  logger.info(`creating master_plan subagent with model ${config.name} (${config.model})`);
  return {
    name: "master_plan",
    description: "查看或讨论既有赛季/总体训练计划（阶段、里程碑、周期），不生成新的计划草案。",
    systemPrompt: MASTER_PLAN_READ_PROMPT,
    tools,
    model: buildResponsesModel(config),
    middleware: [createTurnScopeMiddleware(), createLoggingMiddleware("agent:master_plan")],
  };
}
