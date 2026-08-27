import { getLogger } from "@stride/common";
import { MasterPlanDirectResponseSchema } from "@stride/contract";
import type { ModelConfig } from "../../config/config.js";
import type { DataProvider } from "../../data/dataProvider.js";
import { DataProviderMasterPlanContextProvider } from "../../data/masterPlanContextProvider.js";
import { createActivitiesTools } from "../../tools/activities.js";
import { askUserQuestionTool } from "../../tools/askUserQuestions.js";
import { createMasterPlanContextTools } from "../../tools/masterPlanContext.js";
import { createPlanTools } from "../../tools/plan.js";
import { createRaceTools } from "../../tools/races.js";
import { createRunningCalibrationTools } from "../../tools/runningCalibration.js";
import { createTrainingLoadTools } from "../../tools/trainingLoad.js";
import { buildResponsesModel } from "../common.js";
import { createLoggingMiddleware } from "../middleware.js";
import { MASTER_PLAN_PROMPT, MASTER_PLAN_READ_PROMPT } from "../prompts.js";
import { createTurnScopeMiddleware } from "../turnScope.js";
import { createMasterPlanValidationMiddleware } from "./validationMiddleware.js";

const logger = getLogger("coachAgent:master_plan");

export function getMasterPlanSubagent(store: DataProvider, config: ModelConfig) {
  return createMasterPlanSubagent(store, config, false);
}

/** Dedicated generator: its final response requests direct MasterPlan delivery. */
export function getMasterPlanGeneratorSubagent(store: DataProvider, config: ModelConfig) {
  return createMasterPlanSubagent(store, config, true);
}

function createMasterPlanSubagent(store: DataProvider, config: ModelConfig, generatesPlan: boolean) {
  const activitiesTools = createActivitiesTools(store);
  const trainingLoadTools = createTrainingLoadTools(store);
  const planTools = createPlanTools(store);
  const raceTools = createRaceTools(store);
  const runningCalibrationTools = createRunningCalibrationTools(store);
  const masterPlanContextTools = createMasterPlanContextTools(new DataProviderMasterPlanContextProvider(store));

  const name = generatesPlan ? "generate_master_plan" : "master_plan";
  logger.info(`creating ${name} subagent with model ${config.name} (${config.model})`);

  const tools = generatesPlan
    ? [...planTools.filter((tool) => tool.name === "get_master_plan"), ...masterPlanContextTools, askUserQuestionTool]
    : [...activitiesTools, ...trainingLoadTools, ...planTools, ...raceTools, ...runningCalibrationTools, askUserQuestionTool];

  return {
    name,
    description: generatesPlan
      ? "生成新的结构化赛季训练计划；会回看历史比赛并在必要时向运动员追问。"
      : "查看或讨论既有赛季/总体训练计划（阶段、里程碑、周期），不生成新的计划草案。",
    systemPrompt: generatesPlan ? MASTER_PLAN_PROMPT : MASTER_PLAN_READ_PROMPT,
    tools,
    model: buildResponsesModel(config),
    ...(generatesPlan ? { responseFormat: MasterPlanDirectResponseSchema } : {}),
    middleware: [createTurnScopeMiddleware(), ...(generatesPlan ? [createMasterPlanValidationMiddleware()] : []), createLoggingMiddleware("agent:master_plan")],
    // Skill loaded via SkillsMiddleware from the deep agent's FilesystemBackend
    // (rooted at `dist/agents/skills/` in coachAgent.ts). The agent reads the
    // full SKILL.md on demand via read_file. Path is relative to that root.
    skills: generatesPlan ? ["/generate-master-plan/"] : ["/analyze-activity/", "/analyze-race/"],
  };
}
