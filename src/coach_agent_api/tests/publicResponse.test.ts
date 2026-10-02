import assert from "node:assert/strict";
import test from "node:test";
import { toPublicHistory, toPublicResponse, warnOnDegradedReply } from "../src/publicResponse.js";

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

// ── card 信封投影（信封挂在回复消息自身，见 docs/coach_agent/structured-artifacts.md §2）──

const envelope = { $type: "race-strategy", data: { race_name: "杭州马拉松", pace_segments: [{ segment: "0–10 km" }] } };

function cardAi(content: string) {
  return { _getType: () => "ai", content, additional_kwargs: { card: envelope } };
}

test("toPublicResponse projects the card from the reply message itself (checkpoint-recovery shape)", () => {
  // recoverTurn 只回放 messages（无 intent/channel）——信封在消息上才不丢。
  const response = toPublicResponse({ messages: [cardAi("初稿如下……")] });
  assert.deepEqual(response, { status: "completed", message: "初稿如下……", card: envelope });
});

test("toPublicResponse omits the card when the reply message carries none", () => {
  const response = toPublicResponse({ messages: [ai("不客气！")] });
  assert.deepEqual(response, { status: "completed", message: "不客气！" });
});

test("a malformed card envelope is dropped, not forwarded", () => {
  const bad = { _getType: () => "ai", content: "初稿", additional_kwargs: { card: { $type: "", data: {} } } };
  assert.deepEqual(toPublicResponse({ messages: [bad] }), { status: "completed", message: "初稿" });
});

test("toPublicHistory restores cards per artifact turn and keeps legacy rows plain text", () => {
  const wrapped = (text: string) => JSON.stringify({ timestamp: "2026-10-01T20:00:00+08:00", message: text });
  const history = toPublicHistory([
    { type: "human", content: wrapped("帮我制定策略") },
    cardAi("初稿如下……"),
    { type: "human", content: wrapped("谢谢") },
    ai("不客气！"),
  ]);
  assert.deepEqual(history, [
    { role: "user", content: "帮我制定策略" },
    { role: "assistant", content: "初稿如下……", card: envelope },
    { role: "user", content: "谢谢" },
    { role: "assistant", content: "不客气！" },
  ]);
});
