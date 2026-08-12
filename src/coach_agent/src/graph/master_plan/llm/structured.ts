import { OutputParserException } from "@langchain/core/output_parsers";
import type { Runnable } from "@langchain/core/runnables";
import { z } from "zod/v4";
import { buildResponsesModel } from "../../../agents/common.js";
import type { ModelConfig } from "../../../config/config.js";
import { ModelContractError } from "../nodes.js";

export type PromptMessage = ["system" | "user", string];

interface StructuredSchema<Output> {
	parse(value: unknown): Output;
}

interface StructuredOutputDependencies {
	buildStructuredModel?: (
		model: ModelConfig,
		schema: StructuredSchema<unknown>,
		name: string,
	) => Pick<Runnable, "invoke">;
}

export async function invokeStructured<Output>(
	model: ModelConfig,
	schema: StructuredSchema<Output>,
	name: string,
	messages: PromptMessage[],
	validate: (value: Output) => Output = (value) => value,
	dependencies: StructuredOutputDependencies = {},
): Promise<Output> {
	let lastError: unknown;
	const buildStructured =
		dependencies.buildStructuredModel ?? defaultStructuredModel;

	for (let attempt = 1; attempt <= 3; attempt += 1) {
		const structured = buildStructured(model, schema, name);
		let output: unknown;
		try {
			output = await structured.invoke([
				...messages,
				...retryMessage(lastError, attempt),
			]);
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

	throw new ModelContractError(
		`Structured output contract failed after retries for ${name}`,
	);
}

function defaultStructuredModel(
	model: ModelConfig,
	schema: StructuredSchema<unknown>,
	name: string,
) {
	return buildResponsesModel(model).withStructuredOutput(schema as never, {
		name,
		method: "functionCalling",
		strict: true,
	});
}

function retryMessage(lastError: unknown, attempt: number): PromptMessage[] {
	if (attempt === 1) return [];
	const detail =
		lastError instanceof Error
			? lastError.message
			: "unknown contract violation";
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
	return new ModelContractError(
		error instanceof Error ? error.message : "unknown contract violation",
	);
}
