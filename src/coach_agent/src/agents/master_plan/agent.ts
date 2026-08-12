import { buildResponsesModel } from "../common.js";
import { createActivitiesTools } from "../../tools/activities.js";
import { createTrainingLoadTools } from "../../tools/trainingLoad.js";
import { createPlanTools } from "../../tools/plan.js";
import { createCurrentTimeTools } from "../../tools/currentTime.js";
import { createRaceTools } from "../../tools/races.js";
import { createRunningCalibrationTools } from "../../tools/runningCalibration.js";
import { askUserQuestionTool } from "../../tools/askUserQuestions.js";
import { createLoggingMiddleware } from "../middleware.js";
import type { StrideDataStore } from "../../persistence/index.js";
import type { ModelConfig } from "../../config/config.js";
import { MASTER_PLAN_PROMPT, MASTER_PLAN_READ_PROMPT } from "../prompts.js";
import { getLogger } from "../../logging/index.js";
import { MasterPlanSchema } from "./schema.js";

const logger = getLogger("coachAgent:master_plan");

export function getMasterPlanSubagent(
	store: StrideDataStore,
	config: ModelConfig,
) {
	return createMasterPlanSubagent(store, config, false);
}

/** Dedicated generator: its final response is a validated MasterPlan draft. */
export function getMasterPlanGeneratorSubagent(
	store: StrideDataStore,
	config: ModelConfig,
) {
	return createMasterPlanSubagent(store, config, true);
}

function createMasterPlanSubagent(
	store: StrideDataStore,
	config: ModelConfig,
	generatesPlan: boolean,
) {
	const activitiesTools = createActivitiesTools(store);
	const trainingLoadTools = createTrainingLoadTools(store);
	const planTools = createPlanTools(store);
	const currentTimeTools = createCurrentTimeTools();
	const raceTools = createRaceTools(store);
	const runningCalibrationTools = createRunningCalibrationTools(store);

	const name = generatesPlan ? "generate_master_plan" : "master_plan";
	logger.info(
		`creating ${name} subagent with model ${config.name} (${config.model})`,
	);

	return {
		name,
		description: generatesPlan
			? "生成新的结构化赛季训练计划；会回看历史比赛并在必要时向运动员追问。"
			: "查看或讨论既有赛季/总体训练计划（阶段、里程碑、周期），不生成新的计划草案。",
		systemPrompt: generatesPlan ? MASTER_PLAN_PROMPT : MASTER_PLAN_READ_PROMPT,
		tools: [
			...activitiesTools,
			...trainingLoadTools,
			...planTools,
			...currentTimeTools,
			...raceTools,
			...runningCalibrationTools,
			askUserQuestionTool,
		],
		model: buildResponsesModel(config),
		...(generatesPlan ? { responseFormat: MasterPlanSchema } : {}),
		middleware: [createLoggingMiddleware("agent:master_plan")],
		// Skill loaded via SkillsMiddleware from the deep agent's FilesystemBackend
		// (rooted at `dist/agents/skills/` in coachAgent.ts). The agent reads the
		// full SKILL.md on demand via read_file. Path is relative to that root.
		skills: generatesPlan
			? ["/analyze-activity/", "/analyze-race/", "/generate-master-plan/"]
			: ["/analyze-activity/", "/analyze-race/"],
	};
}
