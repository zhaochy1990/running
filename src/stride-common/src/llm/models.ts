/**
 * LLM client construction for STRIDE's OpenAI-compatible model endpoints.
 *
 * This is the single place that knows how to turn a `ModelConfig` into a
 * LangChain chat model (auth, endpoint, thinking switches, Responses vs Chat
 * Completions). The chat agents, the planning graphs and the worker all build
 * their clients here instead of each keeping a copy.
 *
 * Adding a `structured` request to the config returns a schema-bound runnable
 * instead: one call, one schema-validated submission, with the caller's domain
 * rules applied on top.
 */

import { OutputParserException } from "@langchain/core/output_parsers";
import { ChatOpenAI, ChatOpenAIResponses } from "@langchain/openai";
import { z } from "zod/v4";
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

/** A prompt as `[role, content]` pairs — the message shape LangChain accepts. */
export type PromptMessage = ["system" | "user", string];

/**
 * Raised when a model's answer violated its schema or the caller's domain rules.
 * Callers use it to tell a contract failure (a quality problem, never retried by
 * the job layer) apart from a provider failure (infrastructure, worth retrying).
 */
export class ModelContractError extends Error {}

/** What a caller must supply to get a schema-bound model out of {@link buildModel}. */
export interface StructuredRequest<Output> {
  schema: { parse(value: unknown): Output };
  /** Names the submission function and identifies the call in logs and errors. */
  name: string;
  /**
   * Rules a schema cannot express — "the verdict must agree with the
   * authoritative facts", "the plan must pass the deterministic rule filter".
   * A rejection surfaces as a {@link ModelContractError}.
   */
  validate?: (value: Output) => Output;
}

/** A model config that also carries the schema its answers must satisfy. */
export type StructuredModelConfig<Output> = ModelConfig & { structured: StructuredRequest<Output> };

/** A model bound to one schema: one call, one validated-or-rejected submission. */
export interface StructuredRunnable<Output> {
  readonly name: string;
  invoke(messages: PromptMessage[]): Promise<Output>;
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

/** A model carrying a `structured` request comes back schema-bound; otherwise it is a plain chat model. */
export function buildModel<Output>(config: StructuredModelConfig<Output>): StructuredRunnable<Output>;
export function buildModel(config: ModelConfig): ChatOpenAI | ChatOpenAIResponses;
export function buildModel<Output>(config: ModelConfig | StructuredModelConfig<Output>): ChatOpenAI | ChatOpenAIResponses | StructuredRunnable<Output> {
  logger.info({ model: config.model, api_kind: config.api_kind, thinking: config.thinking, reasoning_effort: config.reasoning_effort }, "build model config");

  if ("structured" in config) {
    const { schema, name, validate } = config.structured;
    // DeepSeek thinking models reject the forced `tool_choice` that functionCalling
    // emits (400 "Thinking mode does not support this tool_choice"), so use the
    // response_format path instead.
    const runnable = buildResponsesModel(config).withStructuredOutput(schema as never, {
      name,
      method: "jsonSchema",
      strict: true,
    });
    return {
      name,
      async invoke(messages: PromptMessage[]): Promise<Output> {
        let output: Output;
        try {
          output = (await runnable.invoke(messages)) as Output;
        } catch (error) {
          throw isDecodeFailure(error) ? asContractError(error) : error;
        }
        // The caller's domain rules run outside the try above on purpose: their
        // rejection is a contract failure, but a provider error must stay
        // classified as infrastructure.
        try {
          return validate ? validate(output) : output;
        } catch (error) {
          throw asContractError(error);
        }
      },
    };
  }

  if (config.api_kind === "responses") {
    return buildResponsesModel(config);
  } else if (config.api_kind === "chat-completions") {
    return buildChatModel(config);
  } else {
    throw new Error(`Unsupported model api_kind: ${config.api_kind}`);
  }
}

/** A rejection by the structured decoder, as opposed to a provider-side failure. */
function isDecodeFailure(error: unknown): boolean {
  return error instanceof OutputParserException || error instanceof z.ZodError;
}

function asContractError(error: unknown): ModelContractError {
  return new ModelContractError(error instanceof Error ? error.message : "unknown contract violation");
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
    configuration: { baseURL: config.endpoint, fetch: jsonSchemaSanitizingFetch },

    reasoning: {
      effort: config.reasoning_effort ?? "high",
    },
    temperature: config.temperature ?? 0.4,
  });
}

/**
 * DeepSeek 的 json_schema 校验比 OpenAI 严两处：不认 `oneOf`（报错文案却写
 * `anyOf`）；strict 模式要求 `required` 覆盖全部 properties。发线前做等价改写：
 * oneOf→anyOf（判别并集语义等价）；strict 惯例补全——required 补成全量、原本
 * 可选的属性包一层 anyOf-null（OpenAI strict 的标准表达，zod 侧 nullish 字段
 * 均可接住 null）。strict 本身保持开启，约束解码不受影响。
 */
const jsonSchemaSanitizingFetch: typeof fetch = async (input, init) => {
  try {
    if (typeof init?.body === "string") {
      const body = JSON.parse(init.body) as { text?: { format?: Record<string, unknown> } };
      const format = body?.text?.format;
      if (format?.type === "json_schema" && format.schema != null) {
        format.schema = enforceStrictRequired(inlineRefs(renameOneOf(format.schema)));
        init = { ...init, body: JSON.stringify(body) };
      }
    }
  } catch {
    // 净化是尽力而为：解析失败就按原始请求发送，让服务端的报错可见。
  }
  return fetch(input, init);
};

export function renameOneOf(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(renameOneOf);
  if (node && typeof node === "object") {
    const { oneOf, ...rest } = node as Record<string, unknown> & { oneOf?: unknown[] };
    const source: Record<string, unknown> = oneOf !== undefined ? { ...rest, anyOf: oneOf } : rest;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) out[key] = renameOneOf(value);
    return out;
  }
  return node;
}

/** 内联 $ref 到 $defs：DeepSeek 对 anyOf 里的 $ref 分支同样挑剔，且这些
 * 引用只是 zod 对重复子 schema 的去重产物，内联是纯等价改写。 */
export function inlineRefs(node: unknown, defs: Record<string, unknown> = {}, depth = 0): unknown {
  if (depth > 24) return node;
  if (Array.isArray(node)) return node.map((item) => inlineRefs(item, defs, depth));
  if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if (typeof record.$ref === "string" && record.$ref.startsWith("#/$defs/")) {
      const def = defs[record.$ref.slice("#/$defs/".length)];
      if (def != null) return inlineRefs(def, defs, depth + 1);
    }
    if (record.$defs != null && typeof record.$defs === "object") {
      Object.assign(defs, record.$defs as Record<string, unknown>);
      const { $defs: _ignored, ...rest } = record;
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rest)) out[key] = inlineRefs(value, defs, depth + 1);
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) out[key] = inlineRefs(value, defs, depth + 1);
    return out;
  }
  return node;
}

/** 把对象 schema 改写成 strict 惯例：required 全量，可选属性可空化。已是
 * anyOf 的节点扁平追加 null 分支——嵌套 anyOf（无 type 的分支）DeepSeek 不收。 */
export function enforceStrictRequired(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(enforceStrictRequired);
  if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    const hasProps = record.type === "object" && record.properties != null && typeof record.properties === "object" && !Array.isArray(record.properties);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key === "required" && hasProps) continue;
      if (key === "properties" && hasProps) {
        const props = value as Record<string, unknown>;
        const required = new Set(Array.isArray(record.required) ? (record.required as unknown[]) : []);
        const patched: Record<string, unknown> = {};
        for (const [prop, schema] of Object.entries(props)) {
          patched[prop] = required.has(prop) ? enforceStrictRequired(schema) : strictNullable(enforceStrictRequired(schema));
        }
        out[key] = patched;
        out.required = Object.keys(props);
        continue;
      }
      out[key] = enforceStrictRequired(value);
    }
    return out;
  }
  return node;
}

function strictNullable(schema: unknown): unknown {
  if (schema && typeof schema === "object" && !Array.isArray(schema) && Array.isArray((schema as Record<string, unknown>).anyOf)) {
    const record = schema as Record<string, unknown> & { anyOf: unknown[] };
    if (record.anyOf.some((branch) => (branch as Record<string, unknown> | null)?.type === "null")) return schema;
    return { ...record, anyOf: [...record.anyOf, { type: "null" }] };
  }
  return { anyOf: [schema, { type: "null" }] };
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
