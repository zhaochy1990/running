/**
 * LLM client construction for STRIDE's OpenAI-compatible model endpoints.
 *
 * This is the single place that knows how to turn a `ModelConfig` into a
 * LangChain chat model (auth, endpoint, thinking switches, Responses vs Chat
 * Completions). The chat agents, the planning graphs and the worker all build
 * their clients here instead of each keeping a copy.
 */

import { ChatOpenAI, ChatOpenAIResponses } from "@langchain/openai";
import { getLogger } from "../logger.js";

export type ModelApiKind = "chat-completions" | "responses";
export type ReasoningEffort = "low" | "medium" | "high" | "max";

export interface ModelConfig {
  name: string;
  model: string;
  endpoint: string;
  api_key_env: string;
  api_kind: ModelApiKind;
  temperature?: number;
  max_tokens: number;
  timeout_s: number;
  reasoning_effort?: ReasoningEffort;
  /** DeepSeek 思考模式开关。缺省 = 保持模型默认（思考模式打开，effort 默认 high）。 */
  thinking?: "enabled" | "disabled";
}

const logger = getLogger("llm:models");

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
  logger.info({ model: config.model, api_kind: config.api_kind, thinking: config.thinking, reasoning_effort: config.reasoning_effort }, "build model config");

  if (config.api_kind === "responses") {
    return buildResponsesModel(config);
  } else if (config.api_kind === "chat-completions") {
    return buildChatModel(config);
  } else {
    throw new Error(`Unsupported model api_kind: ${config.api_kind}`);
  }
}

export function buildResponsesModel(config: ModelConfig): ChatOpenAIResponses {
  // Callers reach this builder directly (not only through `buildModel`), so the
  // api_kind guard is the one runtime check that catches a misconfigured role.
  if (config.api_kind !== "responses") {
    throw new Error(`ChatOpenAIResponses requires a Responses model; "${config.name}" is api_kind=${config.api_kind}`);
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
  // DeepSeek 的思考开关只在 Chat Completions 生效（extra_body）；Responses API 不认。
  // 注意：`stream_options` 只能在 `stream: true` 时携带，否则 DeepSeek 报 400；
  // 这里刻意不放它，避免非流式调用（如意图分类器的 structured output）失败。
  const modelKwargs: Record<string, unknown> = {};
  if (config.thinking === "disabled" || config.thinking === "enabled") {
    modelKwargs.thinking = { type: config.thinking };
  }
  if (config.thinking === "enabled" && config.reasoning_effort !== undefined) {
    modelKwargs.reasoning_effort = config.reasoning_effort;
  }

  return new ChatOpenAI({
    model: config.model,
    apiKey: resolveApiKey(config),
    maxTokens: config.max_tokens,
    timeout: config.timeout_s * 1000,

    configuration: {
      baseURL: config.endpoint,
    },

    modelKwargs,

    // TypeScript 特有：禁用 TS 的 Responses API 预设，使 extraBody 生效并切换回普通模式
    useResponsesApi: false,
    temperature: config.temperature ?? 0.4,
  });
}
