import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";

type CallStatus = "running" | "completed" | "failed";

export interface LlmTokenUsageCall {
	index: number;
	agent: string;
	model: string;
	inputTokens: number | null;
	outputTokens: number | null;
	totalTokens: number | null;
	status: CallStatus;
}

export interface LlmTokenUsageSummary {
	callCount: number;
	reportedCallCount: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	calls: LlmTokenUsageCall[];
}

interface MutableCall extends LlmTokenUsageCall {
	runId: string;
}

interface TokenCounts {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
}

/**
 * Per-invocation LLM usage collector. Pass one instance through RunnableConfig
 * callbacks; Deep Agents propagates that config into delegated subagents, so a
 * single collector covers both the orchestrator and master-plan generator.
 */
export class LlmTokenUsageTracker extends BaseCallbackHandler {
	name = "LlmTokenUsageTracker";

	private readonly calls: MutableCall[] = [];
	private readonly callsByRunId = new Map<string, MutableCall>();

	handleChatModelStart(
		_llm: unknown,
		_messages: unknown,
		runId: string,
		_parentRunId?: string,
		extraParams?: Record<string, unknown>,
		_tags?: string[],
		metadata?: Record<string, unknown>,
	): void {
		this.startCall(runId, extraParams, metadata);
	}

	handleLLMStart(
		_llm: unknown,
		_prompts: string[],
		runId: string,
		_parentRunId?: string,
		extraParams?: Record<string, unknown>,
		_tags?: string[],
		metadata?: Record<string, unknown>,
	): void {
		this.startCall(runId, extraParams, metadata);
	}

	handleLLMEnd(output: LLMResult, runId: string): void {
		const call = this.getOrCreateCall(runId);
		const usage = extractTokenCounts(output);
		if (usage) {
			call.inputTokens = usage.inputTokens;
			call.outputTokens = usage.outputTokens;
			call.totalTokens = usage.totalTokens;
		}
		call.status = "completed";
	}

	handleLLMError(_error: unknown, runId: string): void {
		this.getOrCreateCall(runId).status = "failed";
	}

	summary(): LlmTokenUsageSummary {
		const calls = this.calls.map(({ runId: _runId, ...call }) => ({ ...call }));
		const reportedCalls = calls.filter((call) => call.totalTokens !== null);

		return {
			callCount: calls.length,
			reportedCallCount: reportedCalls.length,
			inputTokens: sum(reportedCalls, "inputTokens"),
			outputTokens: sum(reportedCalls, "outputTokens"),
			totalTokens: sum(reportedCalls, "totalTokens"),
			calls,
		};
	}

	private startCall(
		runId: string,
		extraParams?: Record<string, unknown>,
		metadata?: Record<string, unknown>,
	): void {
		if (this.callsByRunId.has(runId)) return;

		const call: MutableCall = {
			index: this.calls.length + 1,
			runId,
			agent: readString(metadata, "lc_agent_name") ?? "orchestrator",
			model:
				readString(metadata, "ls_model_name") ??
				readNestedString(extraParams, "invocation_params", "model") ??
				"unknown",
			inputTokens: null,
			outputTokens: null,
			totalTokens: null,
			status: "running",
		};
		this.calls.push(call);
		this.callsByRunId.set(runId, call);
	}

	private getOrCreateCall(runId: string): MutableCall {
		this.startCall(runId);
		const call = this.callsByRunId.get(runId);
		if (!call) throw new Error(`failed to register LLM call ${runId}`);
		return call;
	}
}

export function formatTokenUsageReport(summary: LlmTokenUsageSummary): string {
	const lines = [
		"===== Master plan LLM token usage =====",
		`LLM calls: ${summary.callCount}`,
	];

	for (const call of summary.calls) {
		lines.push(
			`#${call.index} agent=${call.agent} model=${call.model} ` +
				`input=${formatCount(call.inputTokens)} ` +
				`output=${formatCount(call.outputTokens)} ` +
				`total=${formatCount(call.totalTokens)} status=${call.status}`,
		);
	}

	const completeness =
		summary.reportedCallCount === summary.callCount
			? "complete"
			: `partial (${summary.reportedCallCount}/${summary.callCount} calls reported usage)`;
	lines.push(
		`TOTAL input=${summary.inputTokens} output=${summary.outputTokens} ` +
			`total=${summary.totalTokens} usage=${completeness}`,
	);

	return lines.join("\n");
}

function extractTokenCounts(output: LLMResult): TokenCounts | undefined {
	for (const generations of output.generations) {
		for (const generation of generations) {
			const message = (generation as { message?: unknown }).message;
			const usage = readRecord(message, "usage_metadata");
			const counts = readCounts(
				usage,
				"input_tokens",
				"output_tokens",
				"total_tokens",
			);
			if (counts) return counts;
		}
	}

	const estimated = readRecord(output.llmOutput, "estimatedTokenUsage");
	return readCounts(
		estimated,
		"promptTokens",
		"completionTokens",
		"totalTokens",
	);
}

function readCounts(
	value: Record<string, unknown> | undefined,
	inputKey: string,
	outputKey: string,
	totalKey: string,
): TokenCounts | undefined {
	if (!value) return undefined;
	const inputTokens = readCount(value[inputKey]);
	const outputTokens = readCount(value[outputKey]);
	if (inputTokens === undefined || outputTokens === undefined) return undefined;
	return {
		inputTokens,
		outputTokens,
		totalTokens: readCount(value[totalKey]) ?? inputTokens + outputTokens,
	};
}

function readCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

function readRecord(
	value: unknown,
	key: string,
): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object") return undefined;
	const nested = (value as Record<string, unknown>)[key];
	return nested && typeof nested === "object"
		? (nested as Record<string, unknown>)
		: undefined;
}

function readString(
	value: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	const candidate = value?.[key];
	return typeof candidate === "string" && candidate.length > 0
		? candidate
		: undefined;
}

function readNestedString(
	value: Record<string, unknown> | undefined,
	recordKey: string,
	stringKey: string,
): string | undefined {
	return readString(readRecord(value, recordKey), stringKey);
}

function sum(
	calls: LlmTokenUsageCall[],
	key: "inputTokens" | "outputTokens" | "totalTokens",
): number {
	return calls.reduce((total, call) => total + (call[key] ?? 0), 0);
}

function formatCount(value: number | null): string {
	return value === null ? "unavailable" : String(value);
}
