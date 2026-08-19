import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryStore, MemorySaver } from "@langchain/langgraph";
import type {
	BaseCheckpointSaver,
	BaseStore,
} from "@langchain/langgraph-checkpoint";
import { createDeepAgent, FilesystemBackend } from "deepagents";
import type { ToolRuntime } from "langchain";
import { z } from "zod/v4";
import { type CoachAgentConfig, getAgentConfig } from "../config/config.js";
import type { DataProvider } from "../data/dataProvider.js";
import { getLogger } from "../utils/logger.js";
import { buildResponsesModel } from "./common.js";
import {
	getMasterPlanGeneratorSubagent,
	getMasterPlanSubagent,
} from "./master_plan/agent.js";
import { createPlanPassthroughMiddleware } from "./masterPlanPassthrough.js";
import { memoryTools } from "./memory.js";
import { createLoggingMiddleware } from "./middleware.js";
import { ORCHESTRATOR_PROMPT } from "./prompts.js";
import { getQaSubagent } from "./qa/agent.js";
import { CoachTurnScope, createTurnScopeMiddleware } from "./turnScope.js";
import {
	getCoachSubagent,
	getWeeklyPlanGeneratorSubagent,
} from "./weekly_plan/agent.js";

export const CoachContext = z
	.object({
		userId: z.string().min(1),
		asof: z.iso.date(),
		target: CoachTurnScope.shape.target,
		reviewContext: CoachTurnScope.shape.reviewContext,
	})
	.strict()
	.superRefine((value, context) => {
		const scoped = CoachTurnScope.safeParse({
			target: value.target,
			reviewContext: value.reviewContext,
		});
		if (!scoped.success) {
			for (const issue of scoped.error.issues) {
				context.addIssue({
					code: "custom",
					message: issue.message,
					path: issue.path,
				});
			}
		}
	});
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

export interface CoachAgentOptions {
	/** Runtime-owned LangGraph checkpointer adapter. */
	checkpointer?: BaseCheckpointSaver;
	/** Runtime-owned LangGraph long-term memory adapter. */
	store?: BaseStore;
}

export async function createCoachAgent(
	dataProvider: DataProvider,
	config: CoachAgentConfig,
	options: CoachAgentOptions = {},
) {
	const modelConfig = getAgentConfig(config, "orchestrator");
	const model = buildResponsesModel(modelConfig);

	const qaSubagent = getQaSubagent(dataProvider, getAgentConfig(config, "qa"));
	const weeklySubagent = getCoachSubagent(
		dataProvider,
		getAgentConfig(config, "weekly_plan"),
	);
	const weeklyPlanGenerator = getWeeklyPlanGeneratorSubagent(
		dataProvider,
		getAgentConfig(config, "weekly_plan"),
	);

	const masterSubagent = getMasterPlanSubagent(
		dataProvider,
		getAgentConfig(config, "master_plan"),
	);
	const masterPlanGenerator = getMasterPlanGeneratorSubagent(
		dataProvider,
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
			createTurnScopeMiddleware(),
			createPlanPassthroughMiddleware(),
			createLoggingMiddleware("agent"),
		],
		// Skill paths are virtual (for example `/generate-master-plan/SKILL.md`).
		// Without virtualMode, an absolute path escapes rootDir and targets the OS root.
		backend: new FilesystemBackend({ rootDir: SKILLS_DIR, virtualMode: true }),
		checkpointer: options.checkpointer ?? new MemorySaver(),
		store: options.store ?? new InMemoryStore(),
	});
}
