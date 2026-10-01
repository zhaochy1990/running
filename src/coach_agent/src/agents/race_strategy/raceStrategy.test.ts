import assert from "node:assert/strict";
import test from "node:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { RaceStrategy } from "@stride/contract";
import { RACE_STRATEGY_PROMPT } from "../prompts.js";
import { CoachTargetRef } from "../turnScope.js";
import { makeRaceStrategyNode } from "./node.js";
import { extractRaceStrategyResult, parseRaceStrategyFromText, raceStrategyMessage, renderRaceStrategyMarkdown } from "./render.js";

const strategy: RaceStrategy = {
  race_name: "杭州马拉松",
  item_type: "Marathon",
  target_finish_time: "3:59:59",
  summary: "前 30km 稳在基线配速，最后 12km 视状态渐进提速。",
  // 分段与目标自洽（superRefine：累计差 >60s 拒绝）：
  // 10 km × 5:45/km + 32.195 km × 5:40/km = 3:59:56，与 3:59:59 差 3s。
  pace_segments: [
    { segment: "0–10 km", distance_km: 10, pace: "5:45/km", segment_time: "57:30", cumulative_time: "57:30", note: "压住兴奋，稳定输出" },
    { segment: "10–42.195 km", distance_km: 32.195, pace: "5:40/km", segment_time: "3:02:26", cumulative_time: "3:59:56", note: "半程后视状态渐进提速" },
  ],
  fueling_plan: [
    { time_point: "赛前 30 分钟", content: "能量胶 1 支 + 水 200ml" },
    { time_point: "20 km", content: "能量胶 1 支" },
  ],
  course_tips: ["32km 钱塘江大桥爬坡提前降档"],
  weather_tips: ["11 月杭州早晨 12–16℃，穿背心+臂套"],
  basis_note: "依据近 90 天 L4 全马估计与校准阈值；赛道数据来自调研内容。",
};

test("race target requires race_event_id and item_type", () => {
  CoachTargetRef.parse({ kind: "race", race_event_id: 30, item_type: "Marathon" });
  assert.throws(() => CoachTargetRef.parse({ kind: "race" }), /race target requires/);
  assert.throws(() => CoachTargetRef.parse({ kind: "race", race_event_id: 30 }), /race target requires item_type/);
  // 既有 target 形态不受影响
  CoachTargetRef.parse({ kind: "session", date: "2026-10-01", session_index: 0 });
});

test("race-strategy prompt gates generation on race content and declares gaps", () => {
  assert.match(RACE_STRATEGY_PROMPT, /kind=race/);
  assert.match(RACE_STRATEGY_PROMPT, /get_race_calendar_context/);
  assert.match(RACE_STRATEGY_PROMPT, /get_performance_baseline/);
  assert.match(RACE_STRATEGY_PROMPT, /赛道内容暂未调研/);
  assert.match(RACE_STRATEGY_PROMPT, /basis_note/);
});

test("extractRaceStrategyResult takes the return_direct envelope, structure-checked only", () => {
  // 内容有效性由 ToolStrategy 解析 + 校验中间件（失败即 throw）在到达前保证；
  // 这里只钉结构：无信封 / 非 return_direct / 无 content → 普通回复。
  assert.deepEqual(extractRaceStrategyResult({ structuredResponse: { disposition: "return_direct", content: strategy } }), strategy);
  assert.equal(extractRaceStrategyResult({ structuredResponse: { disposition: "continue" } }), undefined);
  assert.equal(extractRaceStrategyResult({ structuredResponse: { disposition: "return_direct" } }), undefined);
  assert.equal(extractRaceStrategyResult({}), undefined);
  assert.equal(extractRaceStrategyResult(null), undefined);
});

test("renderRaceStrategyMarkdown covers the #385 display contract", () => {
  const markdown = renderRaceStrategyMarkdown(strategy);
  assert.match(markdown, /目标成绩 3:59:59/);
  assert.match(markdown, /0–10 km｜5:45\/km｜本段 57:30｜累计 57:30/);
  assert.match(markdown, /赛前 30 分钟｜能量胶 1 支 \+ 水 200ml/);
  assert.match(markdown, /钱塘江大桥爬坡/);
  assert.match(markdown, /依据：/);
});

test("race-strategy node writes a rendered reply and the artifact for a structured turn", async () => {
  const userMessage = new HumanMessage("帮我制定杭马策略");
  const innerTrail = [userMessage, new AIMessage("")];
  const node = makeRaceStrategyNode({
    async invoke(input) {
      assert.deepEqual((input as { messages: unknown[] }).messages, [userMessage]);
      return { messages: innerTrail, structuredResponse: { disposition: "return_direct", content: strategy } };
    },
  });
  const update = (await node({ messages: [userMessage] } as never, {} as never)) as {
    messages: BaseMessageLike[];
    raceStrategy: RaceStrategy | null;
  };
  assert.equal(update.messages.length, 1);
  assert.match(String(update.messages[0]?.content), /目标成绩 3:59:59/);
  assert.deepEqual(update.raceStrategy, strategy);
});

test("race-strategy node behaves like a plain business node without structured output", async () => {
  const userMessage = new HumanMessage("这场赛事内容没调研过吗");
  const reply = new AIMessage("该赛事的赛道内容暂未调研，暂无法制定有依据的策略。");
  const node = makeRaceStrategyNode({
    async invoke() {
      return { messages: [userMessage, reply] };
    },
  });
  const update = (await node({ messages: [userMessage] } as never, {} as never)) as {
    messages: BaseMessageLike[];
    raceStrategy: RaceStrategy | null;
  };
  assert.deepEqual(update.messages, [reply]);
  assert.equal(update.raceStrategy, null);
});

test("race-strategy node recovers an envelope leaked as plain text (weak-model fallback)", async () => {
  // 弱模型偶发不走 ToolStrategy 伪工具调用、把信封 JSON 当正文输出；节点必须
  // 捞回成正常路径（渲染 markdown + 填 channel），而不是把原始 JSON 透传给用户。
  const userMessage = new HumanMessage("帮我制定杭马策略");
  const leaked = new AIMessage(JSON.stringify({ disposition: "return_direct", content: strategy }));
  const node = makeRaceStrategyNode({
    async invoke() {
      return { messages: [userMessage, leaked] };
    },
  });
  const update = (await node({ messages: [userMessage] } as never, {} as never)) as {
    messages: BaseMessageLike[];
    raceStrategy: RaceStrategy | null;
  };
  assert.equal(update.messages.length, 1);
  assert.match(String(update.messages[0]?.content), /目标成绩 3:59:59/);
  assert.doesNotMatch(String(update.messages[0]?.content), /disposition/);
  assert.deepEqual(update.raceStrategy, strategy);
});

test("parseRaceStrategyFromText accepts envelope, bare and fenced JSON; rejects everything else", () => {
  const envelopeText = JSON.stringify({ disposition: "return_direct", content: strategy });
  assert.deepEqual(parseRaceStrategyFromText(envelopeText), strategy);
  assert.deepEqual(parseRaceStrategyFromText(JSON.stringify(strategy)), strategy);
  assert.deepEqual(parseRaceStrategyFromText(`\`\`\`json\n${envelopeText}\n\`\`\``), strategy);
  // 普通 prose / 坏 JSON / 形似但缺字段的 JSON 都按普通回复透传
  assert.equal(parseRaceStrategyFromText("该赛事内容暂未调研，无法制定策略。"), undefined);
  assert.equal(parseRaceStrategyFromText("0–10 km 未完待续 {"), undefined);
  assert.equal(parseRaceStrategyFromText('{"race_name":"杭州马拉松"}'), undefined);
  assert.equal(parseRaceStrategyFromText(""), undefined);
});

test("defensive parse only unwraps a whole-document fence, not embedded code", () => {
  // 整段围栏（泄漏形态）能捞回；正文中间夹的代码块不是信封泄漏，不动。
  assert.deepEqual(parseRaceStrategyFromText("```\n" + JSON.stringify(strategy) + "\n```"), strategy);
  assert.equal(parseRaceStrategyFromText(`开头正文\n\`\`\`json\n${JSON.stringify(strategy)}\n\`\`\`\n结尾`), undefined);
});

test("raceStrategyMessage produces a plain AI reply message", () => {
  const message = raceStrategyMessage(strategy);
  assert.equal(message._getType(), "ai");
  assert.equal(message.tool_calls?.length ?? 0, 0);
});

interface BaseMessageLike {
  content: unknown;
}
