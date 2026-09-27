import assert from "node:assert/strict";
import test from "node:test";
import { ChatOpenAIResponses } from "@langchain/openai";
import { buildModel, buildResponsesModel, type ModelConfig } from "./models.js";

const MODEL: ModelConfig = {
  name: "test-responses",
  model: "test-model",
  endpoint: "http://127.0.0.1:1/v1",
  api_kind: "responses",
  max_tokens: 1024,
  api_key_env: "COACH_AGENT_TEST_API_KEY",
  timeout_s: 1,
};

test("buildResponsesModel requires api_key_env", () => {
  assert.throws(() => buildResponsesModel({ ...MODEL, api_key_env: "" }), /Model "test-responses" does not define api_key_env/);
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
    assert.throws(() => buildResponsesModel({ ...MODEL, api_key_env: envName }));
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
    assert.doesNotThrow(() => buildResponsesModel({ ...MODEL, api_key_env: envName }));
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  }
});

/** Run `body` with the test API key present, so building a model never throws on auth. */
function withApiKey(body: () => void): void {
  const envName = MODEL.api_key_env;
  const previous = process.env[envName];
  process.env[envName] = "test-key";
  try {
    body();
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  }
}

test("buildModel without a structured request returns a plain chat model", () => {
  withApiKey(() => {
    assert.ok(buildModel(MODEL) instanceof ChatOpenAIResponses);
  });
});

test("a structured request turns buildModel into a schema-bound runnable", () => {
  withApiKey(() => {
    const runnable = buildModel({
      ...MODEL,
      structured: { schema: { parse: (value) => value as { ok: boolean } }, name: "submit_test" },
    });

    assert.equal(runnable.name, "submit_test");
    assert.equal(typeof runnable.invoke, "function");
  });
});
