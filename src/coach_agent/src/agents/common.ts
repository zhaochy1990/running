import { ChatOpenAIResponses } from "@langchain/openai";
import type { ModelConfig } from "../config/config.js";

export function buildResponsesModel(model: ModelConfig): ChatOpenAIResponses {
	if (
		model.provider !== "openai-compatible" ||
		model.api_kind !== "responses"
	) {
		throw new Error(
			`ChatOpenAIResponses requires an openai-compatible Responses model; ` +
			`"${model.name}" is provider=${model.provider} api_kind=${model.api_kind}`,
		);
	}

	// Agent Maestro accepts any bearer token but still requires a non-empty value.
	const apiKey =
		(model.api_key_env ? process.env[model.api_key_env] : undefined) ??
		"agent-maestro-local";

	return new ChatOpenAIResponses({
		model: model.model,
		apiKey,
		maxTokens: model.max_tokens,
		timeout: model.timeout_s * 1000,
		configuration: { baseURL: model.endpoint },
		...(model.reasoning_effort
			? { reasoning: { effort: model.reasoning_effort } }
			: {}),
		...(model.temperature !== undefined
			? { temperature: model.temperature }
			: {}),
	});
}
