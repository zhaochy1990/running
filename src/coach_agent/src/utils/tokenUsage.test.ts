import assert from "node:assert/strict";
import test from "node:test";
import type { LLMResult } from "@langchain/core/outputs";
import { formatTokenUsageReport, LlmTokenUsageTracker } from "./tokenUsage.js";

test("tracks every LLM call and aggregates provider-reported usage", () => {
	const tracker = new LlmTokenUsageTracker();

	tracker.handleChatModelStart(
		{},
		[],
		"run-1",
		undefined,
		{ invocation_params: { model: "gpt-orchestrator" } },
		undefined,
		{},
	);
	tracker.handleLLMEnd(
		{
			generations: [
				[
					{
						text: "",
						message: {
							content: "",
							usage_metadata: {
								input_tokens: 100,
								output_tokens: 20,
								total_tokens: 120,
							},
						},
					},
				],
			],
		} as unknown as LLMResult,
		"run-1",
	);

	tracker.handleChatModelStart(
		{},
		[],
		"run-2",
		undefined,
		undefined,
		undefined,
		{ lc_agent_name: "generate_master_plan", ls_model_name: "gpt-plan" },
	);
	tracker.handleLLMEnd(
		{
			generations: [[{ text: "" }]],
			llmOutput: {
				estimatedTokenUsage: {
					promptTokens: 300,
					completionTokens: 80,
					totalTokens: 380,
				},
			},
		},
		"run-2",
	);

	assert.deepEqual(tracker.summary(), {
		callCount: 2,
		reportedCallCount: 2,
		inputTokens: 400,
		outputTokens: 100,
		totalTokens: 500,
		calls: [
			{
				index: 1,
				agent: "orchestrator",
				model: "gpt-orchestrator",
				inputTokens: 100,
				outputTokens: 20,
				totalTokens: 120,
				status: "completed",
			},
			{
				index: 2,
				agent: "generate_master_plan",
				model: "gpt-plan",
				inputTokens: 300,
				outputTokens: 80,
				totalTokens: 380,
				status: "completed",
			},
		],
	});
});

test("reports missing usage without silently treating it as zero", () => {
	const tracker = new LlmTokenUsageTracker();
	tracker.handleChatModelStart({}, [], "run-missing");
	tracker.handleLLMEnd(
		{ generations: [[{ text: "no usage" }]] },
		"run-missing",
	);

	const summary = tracker.summary();
	assert.equal(summary.callCount, 1);
	assert.equal(summary.reportedCallCount, 0);
	assert.equal(summary.calls[0]?.totalTokens, null);
	assert.match(formatTokenUsageReport(summary), /usage=partial \(0\/1/);
});

test("retains failed LLM calls in the final report", () => {
	const tracker = new LlmTokenUsageTracker();
	tracker.handleChatModelStart(
		{},
		[],
		"run-failed",
		undefined,
		{ invocation_params: { model: "gpt-plan" } },
		undefined,
		{ lc_agent_name: "generate_master_plan" },
	);
	tracker.handleLLMError(new Error("provider unavailable"), "run-failed");

	const summary = tracker.summary();
	assert.equal(summary.callCount, 1);
	assert.equal(summary.reportedCallCount, 0);
	assert.equal(summary.calls[0]?.status, "failed");
	assert.match(
		formatTokenUsageReport(summary),
		/#1 agent=generate_master_plan model=gpt-plan .*status=failed/,
	);
});
