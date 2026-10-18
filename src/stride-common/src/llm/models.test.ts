import assert from "node:assert/strict";
import test from "node:test";
import { ChatOpenAIResponses } from "@langchain/openai";
import { z } from "zod/v4";
import {
  buildModel,
  buildResponsesModel,
  enforceStrictRequired,
  inlineRefs,
  type ModelConfig,
  ModelContractError,
  type PromptMessage,
  renameOneOf,
  stripUnsupportedFormats,
  type StructuredRunnable,
} from "./models.js";

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
function withApiKey(body: () => unknown): unknown {
  const envName = MODEL.api_key_env;
  const previous = process.env[envName];
  process.env[envName] = "test-key";
  try {
    return body();
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

/** Canned Responses API reply; the sanitizer must still see a json_schema request on the wire. */
function withFakeResponsesApi(response: Record<string, unknown>, capture: { wireFormat?: Record<string, unknown> }, body: () => Promise<void>): Promise<void> {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body === "string" && String(input).includes("/responses")) {
      const parsedBody = JSON.parse(init.body) as { text?: { format?: Record<string, unknown> } };
      if (parsedBody?.text?.format?.type === "json_schema") capture.wireFormat = parsedBody.text.format;
      return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
    }
    return previous(input as Request, init);
  }) as typeof fetch;
  return body().finally(() => {
    globalThis.fetch = previous;
  });
}

const structuredModel = (schema: { parse(value: unknown): { ok: boolean } }): StructuredRunnable<{ ok: boolean }> =>
  buildModel({ ...MODEL, structured: { schema, name: "submit_probe" } });

// 真实 zod schema —— 生产 structured 调用全部走 zod，必须覆盖这条分支
// （zod v4 的 toJsonSchema 产物带 ~standard，会触发 langchain 的 broken fallback）。
const zodSchema = z.object({ ok: z.boolean() });

const JUDGE_MESSAGES: PromptMessage[] = [["user", "probe"]];

/** 票 #612 回归：响应 incomplete（只有 reasoning，无 message）时必须报 contract
 * 错误（可重试、归入 quality），而不是把 content 数组当字符串解析出 undefined。 */
test("structured decode turns an incomplete responses payload into a contract error", async () => {
  await withApiKey(async () => {
    const capture: { wireFormat?: Record<string, unknown> } = {};
    const response = {
      id: "resp_test_incomplete",
      object: "response",
      created_at: 1,
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      model: MODEL.model,
      output: [{ type: "reasoning", id: "rs_1", summary: [] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    await withFakeResponsesApi(response, capture, async () => {
      await assert.rejects(
        structuredModel(zodSchema).invoke(JUDGE_MESSAGES),
        (error: unknown) => error instanceof ModelContractError && !error.message.includes("undefined"),
      );
    });
    assert.equal(capture.wireFormat?.name, "submit_probe");
    assert.equal(capture.wireFormat?.strict, true);
    assert.ok(capture.wireFormat?.schema);
  });
});

test("structured decode parses the message text of a complete responses payload", async () => {
  await withApiKey(async () => {
    const capture: { wireFormat?: Record<string, unknown> } = {};
    const response = {
      id: "resp_test_ok",
      object: "response",
      created_at: 1,
      status: "completed",
      incomplete_details: null,
      model: MODEL.model,
      output: [
        { type: "reasoning", id: "rs_2", summary: [] },
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: '{"ok":true}', annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    await withFakeResponsesApi(response, capture, async () => {
      const parsed = await structuredModel(zodSchema).invoke(JUDGE_MESSAGES);
      assert.deepEqual(parsed, { ok: true });
    });
    assert.equal(capture.wireFormat?.name, "submit_probe");
  });
});

test("structured decode rejects schema-violating message text as a contract error", async () => {
  await withApiKey(async () => {
    const response = {
      id: "resp_test_bad",
      object: "response",
      created_at: 1,
      status: "completed",
      incomplete_details: null,
      model: MODEL.model,
      output: [
        {
          type: "message",
          id: "msg_2",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: '{"ok":"not-a-boolean"}', annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    await withFakeResponsesApi(response, {}, async () => {
      await assert.rejects(structuredModel(zodSchema).invoke(JUDGE_MESSAGES), ModelContractError);
    });
  });
});

test("format stripper keeps DeepSeek-supported formats and drops the rest", () => {
  const wire = {
    type: "object",
    properties: {
      day: { type: "string", format: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      at: { type: "string", format: "date-time" },
      mail: { type: "string", format: "email" },
    },
  };
  const stripped = stripUnsupportedFormats(wire) as Record<string, any>;
  assert.deepEqual(stripped.properties.day, { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
  assert.deepEqual(stripped.properties.at, { type: "string" });
  assert.equal(stripped.properties.mail.format, "email");
});

test("json schema sanitizer renames oneOf, inlines refs, and completes strict required", () => {
  const wire = {
    type: "object",
    properties: {
      kind: {
        oneOf: [
          { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false },
          { type: "object", properties: { b: { $ref: "#/$defs/Unit" } }, required: ["b"], additionalProperties: false },
        ],
      },
      note: { type: "string" },
    },
    required: ["kind"],
    additionalProperties: false,
    $defs: { Unit: { type: "string", enum: ["km"] } },
  };
  const sanitized = enforceStrictRequired(inlineRefs(renameOneOf(wire))) as Record<string, any>;

  assert.equal(JSON.stringify(sanitized).includes('"oneOf"'), false);
  assert.equal(sanitized.$defs, undefined);
  assert.deepEqual(sanitized.required, ["kind", "note"]);
  assert.ok(Array.isArray(sanitized.properties.note.anyOf));
  assert.ok((sanitized.properties.note.anyOf as unknown[]).some((branch) => (branch as Record<string, unknown>).type === "null"));
  const branches = sanitized.properties.kind.anyOf as Array<Record<string, any>>;
  assert.equal(branches.length, 2);
  assert.deepEqual(branches[1]?.properties.b, { type: "string", enum: ["km"] });
});
