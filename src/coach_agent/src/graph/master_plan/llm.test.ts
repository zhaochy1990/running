import assert from "node:assert/strict";
import test from "node:test";
import { OutputParserException } from "@langchain/core/output_parsers";
import type { ModelConfig } from "../../config/config.js";
import { createMasterPlanLlmModels } from "./llm/models.js";
import {
	athleteAssessmentPrompt,
	goalAssessmentPrompt,
	reviewPrompt,
	strategyPrompt,
} from "./llm/prompts.js";
import { invokeStructured } from "./llm/structured.js";

const MODEL: ModelConfig = {
	name: "test-responses",
	provider: "openai-compatible",
	model: "test-model",
	deployment: "test-model",
	endpoint: "http://127.0.0.1:1/v1",
	auth: "api-key",
	api_kind: "responses",
	max_tokens: 1024,
	timeout_s: 1,
};

test("createMasterPlanLlmModels loads every graph model without invoking an LLM", async () => {
	const models = await createMasterPlanLlmModels({
		masterPlanModel: MODEL,
		reviewerModel: MODEL,
	});

	assert.deepEqual(Object.keys(models).sort(), [
		"assessmentModel",
		"goalAssessmentModel",
		"judgmentModel",
		"reviewModel",
		"skeletonModel",
		"strategyModel",
	]);
	for (const model of Object.values(models)) {
		assert.equal(typeof model.invoke, "function");
	}
});

test("prompt builders keep runtime data in user messages", () => {
	const input = {
		request: { id: "request" },
		facts: { id: "facts" },
		snapshot: { id: "snapshot" },
	};
	const athleteMessages = athleteAssessmentPrompt(input);
	const goalMessages = goalAssessmentPrompt({
		...input,
		athleteAssessment: { id: "assessment" },
	});

	assert.equal(athleteMessages[0]?.[0], "system");
	assert.deepEqual(JSON.parse(athleteMessages[1]?.[1] ?? ""), {
		task: "Assess the athlete's current capability and safe planning entry point",
		request: input.request,
		assessment_facts: input.facts,
		snapshot: input.snapshot,
	});
	assert.deepEqual(JSON.parse(goalMessages[1]?.[1] ?? ""), {
		task: "Assess the confirmed race goal against the athlete assessment",
		request: input.request,
		assessment_facts: input.facts,
		athlete_assessment: { id: "assessment" },
		snapshot: input.snapshot,
	});
});

test("prompt builders append doctrine and review rubrics to system messages", () => {
	const input = { id: "input" };
	const strategyMessages = strategyPrompt(input, "DOCTRINE");
	const reviewMessages = reviewPrompt(input, "RUBRIC");

	assert.match(strategyMessages[0]?.[1] ?? "", /\n\nDOCTRINE$/);
	assert.match(reviewMessages[0]?.[1] ?? "", /\n\nRUBRIC$/);
	assert.equal(strategyMessages[1]?.[1], JSON.stringify(input));
	assert.equal(reviewMessages[1]?.[1], JSON.stringify(input));
});

test("invokeStructured retries deterministic validation failures", async () => {
	const calls: unknown[] = [];
	const values = [{ accepted: false }, { accepted: true }];
	const result = await invokeStructured(
		MODEL,
		{ parse: (value) => value as { accepted: boolean } },
		"submit_test",
		[["user", "test"]],
		(value) => {
			if (!value.accepted) throw new Error("deterministic rule failed");
			return value;
		},
		{
			buildStructuredModel: () => ({
				async invoke(messages) {
					calls.push(messages);
					return values.shift();
				},
			}),
		},
	);

	assert.deepEqual(result, { accepted: true });
	assert.equal(calls.length, 2);
	assert.match(JSON.stringify(calls[1]), /deterministic rule failed/);
});

test("invokeStructured retries typed parser failures", async () => {
	let calls = 0;
	const result = await invokeStructured(
		MODEL,
		{ parse: (value) => value as { accepted: boolean } },
		"submit_test",
		[["user", "test"]],
		(value) => value,
		{
			buildStructuredModel: () => ({
				async invoke() {
					calls += 1;
					if (calls === 1) {
						throw new OutputParserException("invalid model output");
					}
					return { accepted: true };
				},
			}),
		},
	);

	assert.deepEqual(result, { accepted: true });
	assert.equal(calls, 2);
});

test("invokeStructured does not retry provider failures based on message text", async () => {
	let calls = 0;
	await assert.rejects(
		invokeStructured(
			MODEL,
			{ parse: (value) => value },
			"submit_test",
			[["user", "test"]],
			(value) => value,
			{
				buildStructuredModel: () => ({
					async invoke() {
						calls += 1;
						throw new Error("schema service unavailable");
					},
				}),
			},
		),
		/schema service unavailable/,
	);
	assert.equal(calls, 1);
});
