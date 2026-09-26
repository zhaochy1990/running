import assert from "node:assert/strict";
import test from "node:test";
import { warnOnDegradedReply } from "../src/publicResponse.js";

const MAX_TOKENS = 16384;

function ai(content: string, usage?: Record<string, unknown>) {
  return { _getType: () => "ai", content, ...(usage ? { usage_metadata: usage } : {}) };
}

test("a normal reply is not reported as degraded", () => {
  const result = { messages: [ai("你的 2:50 目标……", { output_tokens: 5739, output_token_details: { reasoning: 4385 } })] };
  assert.equal(warnOnDegradedReply(result, MAX_TOKENS, {}), null);
});

// Observed on a real turn: reasoning_effort=max spent all 16384 output tokens on
// thinking and left `content` empty, yet the run completed normally.
test("an empty reply is reported even without usage metadata", () => {
  assert.equal(warnOnDegradedReply({ messages: [ai("")] }, MAX_TOKENS, {}), "empty_reply");
  assert.equal(warnOnDegradedReply({ messages: [ai("   \n")] }, MAX_TOKENS, {}), "empty_reply");
});

test("output tokens at the ceiling are reported once the reply has text", () => {
  const usage = { output_tokens: MAX_TOKENS, output_token_details: { reasoning: 12000 } };
  assert.equal(warnOnDegradedReply({ messages: [ai("答案", usage)] }, MAX_TOKENS, {}), "output_budget_exhausted");
});

test("tool-call steps and non-terminal states are ignored", () => {
  const toolStep = { _getType: () => "ai", content: "", tool_calls: [{ name: "get_master_plan" }] };
  assert.equal(warnOnDegradedReply({ messages: [toolStep] }, MAX_TOKENS, {}), null);
  assert.equal(warnOnDegradedReply({ __interrupt__: [{ value: {} }] }, MAX_TOKENS, {}), null);
  assert.equal(warnOnDegradedReply(undefined, MAX_TOKENS, {}), null);
});

test("an unset max_tokens disables the budget check but not the empty-reply check", () => {
  const usage = { output_tokens: 99999 };
  assert.equal(warnOnDegradedReply({ messages: [ai("答案", usage)] }, 0, {}), null);
  assert.equal(warnOnDegradedReply({ messages: [ai("", usage)] }, 0, {}), "empty_reply");
});
