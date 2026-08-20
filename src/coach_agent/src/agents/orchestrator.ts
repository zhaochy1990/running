import { SystemMessage } from "@langchain/core/messages";
import { Command, END, type GraphNode } from "@langchain/langgraph";
import type { ModelConfig } from "../config/config.js";
import { getLogger } from "../utils/logger.js";
import { buildResponsesModel } from "./common.js";
import {
	type AgentsState,
	IntentClassificationSchema,
	type IntentLabel,
} from "./state.js";

const logger = getLogger("orchestrator");

function getAgentPrompt(): string {
	return `Analyze the user's utterance and classify their intent into one of the following categories. Only output the classification result in a structured format, without providing any answers or training advice.
- "weekly_plan"：查看或调整某一周的训练计划
- "master_plan"：查看或调整赛季 / 总体训练计划
- "training_question"：关于训练状态、疲劳、指标或跑步知识的问答
- "other"：不属于以上任何一类

Provide classification including intent.
        `;
}

export function getOrchestratorNode(
	modelConfig: ModelConfig,
	routes: Partial<Record<IntentLabel, string>> = {},
): GraphNode<typeof AgentsState> {
	const model = buildResponsesModel(modelConfig);
	// Create structured LLM that returns an IntentClassification object.
	const structuredLlm = model.withStructuredOutput(IntentClassificationSchema);
	const prompt = getAgentPrompt();

	const node: GraphNode<typeof AgentsState> = async (state) => {
		const raw = await structuredLlm.invoke([
			new SystemMessage(prompt),
			...state.messages,
		]);

		// The structured decode is best-effort: a local model may return an
		// off-schema / empty object. Degrade to "other" instead of crashing the
		// graph on the strict `intent` channel.
		const parsed = IntentClassificationSchema.safeParse(raw);
		const classification = parsed.success
			? parsed.data
			: { intent: "other" as const };
		if (!parsed.success) {
			logger.warn(
				{ raw, issues: parsed.error.issues },
				"orchestrator: intent classification did not match schema; defaulting to 'other'",
			);
		}

		// Route inside the node via Command goto — the graph injects the
		// intent→node table; unrouted intents fall through to END.
		const goto = routes[classification.intent] ?? END;
		return new Command({
			update: { intent: classification, llmCalls: 1 },
			goto,
		});
	};

	return node;
}
