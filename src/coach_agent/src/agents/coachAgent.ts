import { createDeepAgent, FilesystemBackend } from "deepagents";
import { InMemoryStore, MemorySaver } from "@langchain/langgraph";
import { z } from "zod/v4";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentConfig, type CoachAgentConfig } from "../config/config.js";
import { buildResponsesModel } from "./common.js";
import { memoryTools } from "./memory.js";
import type { ToolRuntime } from "langchain";
import { getQaSubagent } from "./qa/agent.js";
import { createLoggingMiddleware } from "./middleware.js";
import type { StrideDataStore } from "../persistence/index.js";
import { getCoachSubagent, getWeeklyPlanGeneratorSubagent } from "./weekly_plan/agent.js";
import { getLogger } from "../utils/logger.js";
import {
	getMasterPlanGeneratorSubagent,
	getMasterPlanSubagent,
} from "./master_plan/agent.js";
import { ORCHESTRATOR_PROMPT } from "./prompts.js";
import { createPlanPassthroughMiddleware } from "./masterPlanPassthrough.js";

export const CoachContext = z
	.object({
		userId: z.string().min(1),
		asof: z.iso.date(),
	})
	.strict();
export type CoachToolRuntime = ToolRuntime<unknown, typeof CoachContext>;

// Skills live next to the compiled agents (`dist/agents/skills/**`, copied from
// `src/agents/skills/**` by `npm run build`). Root the deep agent's filesystem
// backend here so subagents can `read_file` a SKILL.md via SkillsMiddleware.
const SKILLS_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"skills",
);
const logger = getLogger("coachAgent");
logger.info(`loading skills from dir: ${SKILLS_DIR}`);

export async function createCoachAgent(
	store: StrideDataStore,
	config: CoachAgentConfig,
) {
	const modelConfig = getAgentConfig(config, "orchestrator");
	const model = buildResponsesModel(modelConfig);

	const qaSubagent = getQaSubagent(store, getAgentConfig(config, "qa"));
	const weeklySubagent = getCoachSubagent(
		store,
		getAgentConfig(config, "weekly_plan"),
	);
	const weeklyPlanGenerator = getWeeklyPlanGeneratorSubagent(
		store,
		getAgentConfig(config, "weekly_plan"),
	);

	const masterSubagent = getMasterPlanSubagent(
		store,
		getAgentConfig(config, "master_plan"),
	);
	const masterPlanGenerator = getMasterPlanGeneratorSubagent(
		store,
		getAgentConfig(config, "master_plan"),
	);

	logger.info(
		`creating orchestrator with model ${modelConfig.name} (${modelConfig.model})`,
	);

	return createDeepAgent({
		model,
		systemPrompt: ORCHESTRATOR_PROMPT,
		tools: memoryTools,
		subagents: [
			qaSubagent,
			weeklySubagent,
			weeklyPlanGenerator,
			masterSubagent,
			masterPlanGenerator,
		],
		contextSchema: CoachContext,
		middleware: [
			createPlanPassthroughMiddleware(),
			createLoggingMiddleware("agent"),
		],
		// Skill paths are virtual (for example `/generate-master-plan/SKILL.md`).
		// Without virtualMode, an absolute path escapes rootDir and targets the OS root.
		backend: new FilesystemBackend({ rootDir: SKILLS_DIR, virtualMode: true }),
		checkpointer: new MemorySaver(),
		store: new InMemoryStore(),
	});
}
