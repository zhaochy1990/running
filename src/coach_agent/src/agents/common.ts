import { ChatOpenAI, ChatOpenAIResponses } from "@langchain/openai";
import { getLogger } from "@stride/common";
import type { ModelConfig } from "../config/config.js";

const logger = getLogger("coachAgent:model");

/** Config comes from leniently-parsed YAML, so the runtime presence of the key env var is not type-guaranteed. */
function resolveApiKey(config: ModelConfig): string {
  if (!config.api_key_env) {
    throw new Error(`Model "${config.name}" does not define api_key_env`);
  }
  const apiKey = process.env[config.api_key_env];
  if (!apiKey?.trim()) {
    throw new Error(`Environment variable "${config.api_key_env}" is required for model "${config.name}"`);
  }
  return apiKey;
}

export function buildModel(config: ModelConfig): ChatOpenAI | ChatOpenAIResponses {
  logger.info(config, "build model config");

  if (config.api_kind === "responses") {
    return buildResponsesModel(config);
  } else if (config.api_kind === "chat-completions") {
    return buildChatModel(config);
  } else {
    throw new Error(`Unsupported model api_kind: ${config.api_kind}`);
  }
}

export function buildResponsesModel(config: ModelConfig): ChatOpenAIResponses {
  if (config.provider !== "openai-compatible" || config.api_kind !== "responses") {
    throw new Error(
      `ChatOpenAIResponses requires an openai-compatible Responses model; "${config.name}" is provider=${config.provider} api_kind=${config.api_kind}`,
    );
  }

  return new ChatOpenAIResponses({
    model: config.model,
    apiKey: resolveApiKey(config),
    maxTokens: config.max_tokens,
    timeout: config.timeout_s * 1000,
    configuration: { baseURL: config.endpoint },

    reasoning: {
      effort: config.reasoning_effort ?? "high",
    },
    temperature: config.temperature ?? 0.4,
  });
}

export function buildChatModel(config: ModelConfig): ChatOpenAI {
  var res = new ChatOpenAI({
    model: config.model,
    apiKey: resolveApiKey(config),
    maxTokens: config.max_tokens,
    timeout: config.timeout_s * 1000,

    configuration: {
      baseURL: config.endpoint,
    },

    modelKwargs: {
      thinking: {
        type: "disabled",
      },
      stream_options: { include_usage: true },
    },

    // TypeScript 特有：禁用 TS 的 Responses API 预设，使 extraBody 生效并切换回普通模式
    useResponsesApi: false,
    temperature: config.temperature ?? 0.4,
  });

  return res;
}
