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
import { buildResponsesModel } from "../common.js";
import { createLoggingMiddleware } from "../middleware.js";
import { WeeklyPlanPrompt } from "../prompts.js";
import { WeeklyPlanDirectResponseSchema } from "./schema.js";

export function getCoachSubagent(store: StrideDataStore, config: ModelConfig) {
	const activitiesTools = createActivitiesTools(store);
	const trainingLoadTools = createTrainingLoadTools(store);
	const planTools = createPlanTools(store);
	const raceTools = createRaceTools(store);
	const runningCalibrationTools = createRunningCalibrationTools(store);
	const weeklyPlanContextTools = createWeeklyPlanContextTools(
		new MySqlWeeklyPlanContextProvider(store),
	);

	return {
		name: "weekly_plan",
		description:
			"generate or adjust the training plan for a week or adjust the training plan for a specific day",
		systemPrompt: WeeklyPlanPrompt,
		tools: [
			...weeklyPlanContextTools,
			...planTools,
			...activitiesTools,
			...trainingLoadTools,
			...raceTools,
			...runningCalibrationTools,
		],
		model: buildResponsesModel(config),
		responseFormat: WeeklyPlanDirectResponseSchema,
		middleware: [createLoggingMiddleware("agent:weekly_plan")],
		// Skill loaded via SkillsMiddleware from the deep agent's FilesystemBackend
		// (rooted at `dist/agents/skills/` in coachAgent.ts). The agent reads the
		// full SKILL.md on demand via read_file. Path is relative to that root.
		skills: ["/generate-weekly-plan/"],
	};
}
