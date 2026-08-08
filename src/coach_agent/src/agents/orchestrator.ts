import { Command, END, type GraphNode } from "@langchain/langgraph";
import { ChatOpenAIResponses } from "@langchain/openai";
import { SystemMessage } from "@langchain/core/messages";
import type { ModelConfig } from "../config/config.js";
import { AgentsState, IntentClassificationSchema, type IntentLabel } from "./state.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger("orchestrator");

function buildResponsesModel(model: ModelConfig): ChatOpenAIResponses {
    if (model.provider !== 'openai-compatible' || model.api_kind !== 'responses') {
        throw new Error(
            `ChatOpenAIResponses requires an openai-compatible Responses model; ` +
            `"${model.name}" is provider=${model.provider} api_kind=${model.api_kind}`,
        );
    }

    // Agent Maestro accepts any bearer token but still requires a non-empty value.
    const apiKey = (model.api_key_env ? process.env[model.api_key_env] : undefined) ?? 'agent-maestro-local';

    return new ChatOpenAIResponses({
        model: model.model,
        apiKey,
        maxTokens: model.max_tokens,
        timeout: model.timeout_s * 1000,
        configuration: { baseURL: model.endpoint },
        ...(model.reasoning_effort ? { reasoning: { effort: model.reasoning_effort } } : {}),
        ...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
    });
}

function getAgentPrompt(agentName: string): string {
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
    const prompt = getAgentPrompt("orchestrator");

    const node: GraphNode<typeof AgentsState> = async (state) => {
        const raw = await structuredLlm.invoke([
            new SystemMessage(prompt),
            ...state.messages,
        ]);

        // The structured decode is best-effort: a local model may return an
        // off-schema / empty object. Degrade to "other" instead of crashing the
        // graph on the strict `intent` channel.
        const parsed = IntentClassificationSchema.safeParse(raw);
        const classification = parsed.success ? parsed.data : { intent: "other" as const };
        if (!parsed.success) {
            logger.warn(
                { raw, issues: parsed.error.issues },
                "orchestrator: intent classification did not match schema; defaulting to 'other'",
            );
        }

        // Route inside the node via Command goto — the graph injects the
        // intent→node table; unrouted intents fall through to END.
        const goto = routes[classification.intent] ?? END;
        return new Command({ update: { intent: classification, llmCalls: 1 }, goto });
    };

    return node;
}
