import { buildResponsesModel } from "../common.js";
import { createActivitiesTools } from "../../tools/activities.js";
import { createTrainingLoadTools } from "../../tools/trainingLoad.js";
import { createPlanTools } from "../../tools/plan.js";
import { createCurrentTimeTools } from "../../tools/currentTime.js";
import { createRaceTools } from "../../tools/races.js";
import { createRunningCalibrationTools } from "../../tools/runningCalibration.js";
import { createLoggingMiddleware } from "../middleware.js";
import type { StrideDataStore } from "../../persistence/index.js";
import type { ModelConfig } from "../../config/config.js";
import { MASTER_PLAN_PROMPT } from "../prompts.js";
import { getLogger } from "../../logging/index.js";

const logger = getLogger("coachAgent:master_plan");

export function getMasterPlanSubagent(store: StrideDataStore, config: ModelConfig) {
    const activitiesTools = createActivitiesTools(store);
    const trainingLoadTools = createTrainingLoadTools(store);
    const planTools = createPlanTools(store);
    const currentTimeTools = createCurrentTimeTools();
    const raceTools = createRaceTools(store);
    const runningCalibrationTools = createRunningCalibrationTools(store);

    logger.info(`creating master_plan subagent with model ${config.name} (${config.model})`);

    return {
        name: "master_plan",
        description: "查看或调整赛季/总体训练计划（阶段、里程碑、周期）；生成新赛季计划前会回看历史比赛并在必要时向运动员追问。",
        systemPrompt: MASTER_PLAN_PROMPT,
        tools: [...activitiesTools, ...trainingLoadTools, ...planTools, ...currentTimeTools, ...raceTools, ...runningCalibrationTools],
        model: buildResponsesModel(config),
        middleware: [createLoggingMiddleware("agent:master_plan")],
        // Skill loaded via SkillsMiddleware from the deep agent's FilesystemBackend
        // (rooted at `dist/agents/skills/` in coachAgent.ts). The agent reads the
        // full SKILL.md on demand via read_file. Path is relative to that root.
        skills: ["/analyze-activity/", "/analyze-race/", "/generate-master-plan/"],
    };
}
