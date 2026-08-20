import assert from "node:assert/strict";
import test from "node:test";
import type { ModelConfig } from "../config/config.js";
import { buildResponsesModel } from "./common.js";

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

test("buildResponsesModel requires api_key_env", () => {
	assert.throws(
		() => buildResponsesModel(MODEL),
		/Model "test-responses" does not define api_key_env/,
	);
});

test("buildResponsesModel requires the configured API key environment variable", () => {
	const envName = "COACH_AGENT_TEST_API_KEY";
	const previous = process.env[envName];
	delete process.env[envName];

	try {
		assert.throws(
			() => buildResponsesModel({ ...MODEL, api_key_env: envName }),
			/Environment variable "COACH_AGENT_TEST_API_KEY" is required for model "test-responses"/,
		);
		process.env[envName] = "   ";
		assert.throws(() =>
			buildResponsesModel({ ...MODEL, api_key_env: envName }),
		);
	} finally {
		if (previous === undefined) delete process.env[envName];
		else process.env[envName] = previous;
	}
});

test("buildResponsesModel accepts a non-empty configured API key", () => {
	const envName = "COACH_AGENT_TEST_API_KEY";
	const previous = process.env[envName];
	process.env[envName] = "test-key";

	try {
		assert.doesNotThrow(() =>
			buildResponsesModel({ ...MODEL, api_key_env: envName }),
		);
	} finally {
		if (previous === undefined) delete process.env[envName];
		else process.env[envName] = previous;
	}
});
