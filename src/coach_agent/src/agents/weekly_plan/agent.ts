import { buildResponsesModel } from "@stride/common";
import type { ModelConfig } from "../../config/config.js";
import type { DataProvider } from "../../data/dataProvider.js";
import { DataProviderWeeklyPlanContextProvider } from "../../data/weeklyPlanContextProvider.js";
import { createActivitiesTools } from "../../tools/activities.js";
import { createPlanTools } from "../../tools/plan.js";
import { createRaceTools } from "../../tools/races.js";
import { createRunningCalibrationTools } from "../../tools/runningCalibration.js";
import { createTrainingLoadTools } from "../../tools/trainingLoad.js";
import { createWeeklyPlanContextTools } from "../../tools/weeklyPlanContext.js";
import { createLoggingMiddleware } from "../middleware.js";
import { WeeklyPlanPrompt } from "../prompts.js";
import { createTurnScopeMiddleware } from "../turnScope.js";

/**
 * #858 PR-F：聊天侧周课「生成」路径退役（票面拍板：周课统一由 master 首批
 * 物化 + 滚动投影产出，聊天只读库讲解 + 引导建计划）。generate_weekly_plan
 * 装配（responseFormat 直出 + /generate-weekly-plan/ skill）已删除；本装配
 * 只剩读/讲解 subagent，工具集与退役前完全一致（行为不变面）。
 */
export function getCoachSubagent(store: DataProvider, config: ModelConfig) {
  const activitiesTools = createActivitiesTools(store);
  const trainingLoadTools = createTrainingLoadTools(store);
  const planTools = createPlanTools(store);
  const raceTools = createRaceTools(store);
  const runningCalibrationTools = createRunningCalibrationTools(store);
  const weeklyPlanContextProvider = new DataProviderWeeklyPlanContextProvider(store);
  const weeklyPlanContextTools = createWeeklyPlanContextTools(weeklyPlanContextProvider);
  return {
    name: "weekly_plan",
    description: "read, explain, or discuss an existing weekly training plan",
    systemPrompt: WeeklyPlanPrompt,
    tools: [...weeklyPlanContextTools, ...planTools, ...activitiesTools, ...trainingLoadTools, ...raceTools, ...runningCalibrationTools],
    model: buildResponsesModel(config),
    middleware: [createTurnScopeMiddleware(), createLoggingMiddleware("agent:weekly_plan")],
  };
}
