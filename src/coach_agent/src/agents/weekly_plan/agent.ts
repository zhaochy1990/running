import type { ModelConfig } from "../../config/config.js";
import {
	MySqlWeeklyPlanContextProvider,
	type StrideDataStore,
} from "../../persistence/index.js";
import { createActivitiesTools } from "../../tools/activities.js";
import { createPlanTools } from "../../tools/plan.js";
import { createRaceTools } from "../../tools/races.js";
import { createRunningCalibrationTools } from "../../tools/runningCalibration.js";
import { createTrainingLoadTools } from "../../tools/trainingLoad.js";
import { createWeeklyPlanContextTools } from "../../tools/weeklyPlanContext.js";
import { createWeeklyPlanLoadTools } from "../../tools/weeklyPlanLoad.js";
import { buildResponsesModel } from "../common.js";
import { createLoggingMiddleware } from "../middleware.js";
import { WeeklyPlanPrompt } from "../prompts.js";
import { WeeklyPlanDirectResponseSchema } from "./schema.js";

function createWeeklyPlanSubagent(
	store: StrideDataStore,
	config: ModelConfig,
	generatesPlan: boolean,
) {
	const activitiesTools = createActivitiesTools(store);
	const trainingLoadTools = createTrainingLoadTools(store);
	const planTools = createPlanTools(store);
	const raceTools = createRaceTools(store);
	const runningCalibrationTools = createRunningCalibrationTools(store);
	const weeklyPlanContextProvider = new MySqlWeeklyPlanContextProvider(store);
	const weeklyPlanContextTools = createWeeklyPlanContextTools(
		weeklyPlanContextProvider,
	);
	const weeklyPlanLoadTools = createWeeklyPlanLoadTools(
		weeklyPlanContextProvider,
	);

	return {
		name: generatesPlan ? "generate_weekly_plan" : "weekly_plan",
		description: generatesPlan
			? "generate a new structured weekly training plan"
			: "read, explain, or discuss an existing weekly training plan",
		systemPrompt: WeeklyPlanPrompt,
		tools: [
			...weeklyPlanContextTools,
			...planTools,
			...activitiesTools,
			...trainingLoadTools,
			...raceTools,
			...runningCalibrationTools,
			...(generatesPlan ? weeklyPlanLoadTools : []),
		],
		model: buildResponsesModel(config),
		...(generatesPlan
			? { responseFormat: WeeklyPlanDirectResponseSchema }
			: {}),
		middleware: [
			createLoggingMiddleware(
				generatesPlan ? "agent:generate_weekly_plan" : "agent:weekly_plan",
			),
		],
		// Skill loaded via SkillsMiddleware from the deep agent's FilesystemBackend
		// (rooted at `dist/agents/skills/` in coachAgent.ts). The agent reads the
		// full SKILL.md on demand via read_file. Path is relative to that root.
		skills: generatesPlan ? ["/generate-weekly-plan/"] : [],
	};
}

export function getCoachSubagent(store: StrideDataStore, config: ModelConfig) {
	return createWeeklyPlanSubagent(store, config, false);
}

export function getWeeklyPlanGeneratorSubagent(
	store: StrideDataStore,
	config: ModelConfig,
) {
	return createWeeklyPlanSubagent(store, config, true);
}
