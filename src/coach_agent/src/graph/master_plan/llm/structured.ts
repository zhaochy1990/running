import { buildResponsesModel } from "../../../agents/common.js";
import type { ModelConfig } from "../../../config/config.js";
import { ModelContractError } from "../nodes.js";

export type PromptMessage = ["system" | "user", string];

interface StructuredSchema<Output> {
	parse(value: unknown): Output;
}

export async function invokeStructured<Output>(
	model: ModelConfig,
	schema: StructuredSchema<Output>,
	name: string,
	messages: PromptMessage[],
	validate: (value: Output) => Output = (value) => value,
): Promise<Output> {
	let lastError: unknown;

	for (let attempt = 1; attempt <= 3; attempt += 1) {
		try {
			const structured = buildResponsesModel(model).withStructuredOutput(
				schema as never,
				{ name, method: "functionCalling", strict: true },
			);
			const detail =
				lastError instanceof Error
					? lastError.message
					: "unknown contract violation";
			const retryMessage: PromptMessage[] =
				attempt === 1
					? []
					: [
							[
								"user",
								`The previous submission violated the required schema or deterministic contract: ${detail}. Submit a corrected value only; do not relax or reinterpret any fact.`,
							],
						];

			return validate(
				schema.parse(await structured.invoke([...messages, ...retryMessage])),
			);
		} catch (error) {
			lastError = error;
			if (!isContractViolation(error)) throw error;
		}
	}

	throw new ModelContractError(
		`Structured output contract failed after retries for ${name}`,
	);
}

function isContractViolation(error: unknown): error is Error {
	return (
		error instanceof Error &&
		/Zod|schema|contract|conflict|fact|target|range|structured|parse/i.test(
			`${error.name} ${error.message}`,
		)
	);
}
