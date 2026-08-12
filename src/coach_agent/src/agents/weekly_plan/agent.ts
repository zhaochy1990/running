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
import { WeeklyPlanPrompt } from "../prompts.js";

export function getCoachSubagent(store: StrideDataStore, config: ModelConfig) {
	const activitiesTools = createActivitiesTools(store);
	const trainingLoadTools = createTrainingLoadTools(store);
	const planTools = createPlanTools(store);
	const currentTimeTools = createCurrentTimeTools();
	const raceTools = createRaceTools(store);
	const runningCalibrationTools = createRunningCalibrationTools(store);

	return {
		name: "weekly_plan",
		description: "查看或调整某一天的训练计划",
		systemPrompt: WeeklyPlanPrompt,
		tools: [
			...activitiesTools,
			...trainingLoadTools,
			...planTools,
			...currentTimeTools,
			...raceTools,
			...runningCalibrationTools,
		],
		model: buildResponsesModel(config),
		middleware: [createLoggingMiddleware("agent:weekly_plan")],
		// Skill loaded via SkillsMiddleware from the deep agent's FilesystemBackend
		// (rooted at `dist/agents/skills/` in coachAgent.ts). The agent reads the
		// full SKILL.md on demand via read_file. Path is relative to that root.
		// skills: ["/analyze-activity/"],
	};
}
