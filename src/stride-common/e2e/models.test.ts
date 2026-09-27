/**
 * Live end-to-end coverage for the LLM layer in `src/llm/models.ts`.
 *
 * The config below is written out rather than read from `config/coach.yaml`:
 * keep it in step by hand when the business switches models.
 *
 * Not part of `npm test` — these calls reach the provider for real.
 *
 *     npm run test:e2e
 *
 * Without the API key every case skips.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { HumanMessage } from "@langchain/core/messages";
import { buildModel, ModelContractError, type StructuredModelConfig } from "@stride/common";
import { z } from "zod/v4";

const BASE = {
  model: "deepseek-v4-flash",
  endpoint: "https://api.deepseek.com",
  api_key_env: "DEEPSEEK_API_KEY",
  // Ceilings, not the roles' values: the shipped timeouts reach 600s.
  max_tokens: 2048,
  timeout_s: 60,
} as const;

const SKIP = process.env[BASE.api_key_env] ? false : `${BASE.api_key_env} is not set; skipping live LLM calls`;

const QUESTION = "用一句话说明什么是跑者的有氧基础。";
const LOAD_QUESTION = "运动员上周跑量 60km、静息心率平稳，本周负荷应该增加、维持还是减少？";

/** Chat Completions returns a string; the Responses API returns content blocks. */
function textOf(message: { content: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .flatMap((block) => (block && typeof block === "object" && "text" in block && typeof block.text === "string" ? [block.text] : []))
    .join("\n");
}

const Verdict = z.object({
  verdict: z.enum(["increase", "maintain", "decrease"]),
  reason: z.string(),
});

function verdictModel(name: string, validate?: (value: z.infer<typeof Verdict>) => z.infer<typeof Verdict>): StructuredModelConfig<z.infer<typeof Verdict>> {
  return {
    ...BASE,
    name,
    api_kind: "responses",
    structured: { schema: Verdict, name: "submit_verdict", ...(validate ? { validate } : {}) },
  };
}

test("the qa role chats on chat-completions with thinking off", { skip: SKIP }, async () => {
  const model = buildModel({ ...BASE, name: "e2e-qa", api_kind: "chat-completions", thinking: "disabled" });
  const reply = await model.invoke([new HumanMessage(QUESTION)]);

  assert.ok(textOf(reply).trim().length > 0, "expected a non-empty reply");
});

test("the production qa variant chats with thinking on", { skip: SKIP }, async () => {
  const model = buildModel({ ...BASE, name: "e2e-qa-thinking", api_kind: "chat-completions", thinking: "enabled", reasoning_effort: "low" });
  const reply = await model.invoke([new HumanMessage(QUESTION)]);

  assert.ok(textOf(reply).trim().length > 0, "expected a non-empty reply");
});

test("the master_plan role answers without a structured request", { skip: SKIP }, async () => {
  const model = buildModel({ ...BASE, name: "e2e-master-plan", api_kind: "responses" });
  const reply = await model.invoke([new HumanMessage(QUESTION)]);

  assert.ok(textOf(reply).trim().length > 0, "expected a non-empty reply");
});

test("a structured request returns schema-valid output", { skip: SKIP }, async () => {
  const runnable = buildModel(verdictModel("e2e-structured"));

  const result = await runnable.invoke([["user", LOAD_QUESTION]]);

  assert.equal(runnable.name, "submit_verdict");
  assert.doesNotThrow(() => Verdict.parse(result));
  assert.ok(result.reason.trim().length > 0, "expected the model to explain its verdict");
});

test("a passing validate can rewrite the accepted value", { skip: SKIP }, async () => {
  const runnable = buildModel(verdictModel("e2e-validate-pass", (value) => ({ ...value, reason: value.reason.trim().toUpperCase() })));

  const result = await runnable.invoke([["user", LOAD_QUESTION]]);

  assert.equal(result.reason, result.reason.toUpperCase(), "validate's rewrite should reach the caller");
});

test("a rejected domain rule surfaces as a ModelContractError", { skip: SKIP }, async () => {
  const runnable = buildModel(
    verdictModel("e2e-validate-reject", () => {
      throw new Error("readiness conflict");
    }),
  );

  await assert.rejects(runnable.invoke([["user", LOAD_QUESTION]]), (error: unknown) => {
    assert.ok(error instanceof ModelContractError, `expected ModelContractError, got ${String(error)}`);
    assert.match(error.message, /readiness conflict/);
    return true;
  });
});

// `nodes.ts` treats ModelContractError as a quality failure; a provider failure
// wrapped as one would make the worker retry work that can never succeed.

test("an auth failure is not misreported as a contract error", { skip: SKIP }, async () => {
  process.env.E2E_BAD_KEY = "sk-not-a-real-key";
  try {
    const runnable = buildModel({ ...verdictModel("e2e-bad-key"), api_key_env: "E2E_BAD_KEY" });

    await assert.rejects(runnable.invoke([["user", LOAD_QUESTION]]), (error: unknown) => {
      assert.ok(!(error instanceof ModelContractError), "an auth failure must stay an infrastructure failure");
      return true;
    });
  } finally {
    delete process.env.E2E_BAD_KEY;
  }
});

test("a provider-side rejection is not misreported as a contract error", { skip: SKIP }, async () => {
  // An unknown model, not an unreachable host: the SDK's own retry turns the
  // latter into a hundred-second test.
  const runnable = buildModel({ ...verdictModel("e2e-unknown-model"), model: "stride-e2e-model-that-does-not-exist" });

  await assert.rejects(runnable.invoke([["user", LOAD_QUESTION]]), (error: unknown) => {
    assert.ok(!(error instanceof ModelContractError), "a provider failure must stay an infrastructure failure");
    return true;
  });
});
