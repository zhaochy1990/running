/**
 * Structured (schema-validated) LLM invocation, with a bounded retry that feeds
 * the previous violation back to the model.
 *
 * This is the contract layer on top of a plain model call, and it is the only
 * thing STRIDE adds: the client itself comes from {@link buildResponsesModel}.
 * Callers pass a zod schema for shape and an optional `validate` callback for
 * domain rules that a schema cannot express (for example "the model's verdict
 * must agree with the authoritative facts").
 */

import { OutputParserException } from "@langchain/core/output_parsers";
import type { Runnable } from "@langchain/core/runnables";
import { z } from "zod/v4";
import { getLogger } from "../logger.js";
import { buildResponsesModel, type ModelConfig } from "./models.js";

const logger = getLogger("llm:structured");

/** Raised when a model could not satisfy its schema/domain contract after retries. */
export class ModelContractError extends Error {}

export type PromptMessage = ["system" | "user", string];

interface StructuredSchema<Output> {
  parse(value: unknown): Output;
}

interface StructuredOutputDependencies {
  buildStructuredModel?: (model: ModelConfig, schema: StructuredSchema<unknown>, name: string) => Pick<Runnable, "invoke">;
}

export async function invokeStructured<Output>(
  model: ModelConfig,
  schema: StructuredSchema<Output>,
  name: string,
  messages: PromptMessage[],
  validate: (value: Output) => Output = (value) => value,
  dependencies: StructuredOutputDependencies = {},
): Promise<Output> {
  logger.info({ model: model.name, name }, "Invoking structured output model");
  let lastError: unknown;
  const buildStructured = dependencies.buildStructuredModel ?? defaultStructuredModel;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const structured = buildStructured(model, schema, name);
    let output: unknown;
    try {
      output = await structured.invoke([...messages, ...retryMessage(lastError, attempt)]);
    } catch (error) {
      if (!isStructuredOutputError(error)) throw error;
      lastError = contractError(error);
      continue;
    }

    try {
      return validate(schema.parse(output));
    } catch (error) {
      lastError = contractError(error);
    }
  }

  const detail = lastError instanceof Error ? lastError.message : "unknown contract violation";
  throw new ModelContractError(`Structured output contract failed after retries for ${name}: ${detail}`);
}

function defaultStructuredModel(model: ModelConfig, schema: StructuredSchema<unknown>, name: string) {
  // DeepSeek thinking models reject the forced `tool_choice` that functionCalling
  // emits (400 "Thinking mode does not support this tool_choice"), so use the
  // response_format path instead.
  return buildResponsesModel(model).withStructuredOutput(schema as never, {
    name,
    method: "jsonSchema",
    strict: true,
  });
}

function retryMessage(lastError: unknown, attempt: number): PromptMessage[] {
  if (attempt === 1) return [];
  const detail = lastError instanceof Error ? lastError.message : "unknown contract violation";
  return [
    [
      "user",
      `The previous submission violated the required schema or deterministic contract: ${detail}. Submit a corrected value only; do not relax or reinterpret any fact.`,
    ],
  ];
}

function isStructuredOutputError(error: unknown): boolean {
  return error instanceof OutputParserException || error instanceof z.ZodError;
}

function contractError(error: unknown): ModelContractError {
  return new ModelContractError(error instanceof Error ? error.message : "unknown contract violation");
}
