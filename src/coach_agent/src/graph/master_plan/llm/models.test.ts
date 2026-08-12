import assert from "node:assert/strict";
import test from "node:test";
import type { ModelConfig } from "../../../config/config.js";
import { createMasterPlanLlmModels } from "./models.js";

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
