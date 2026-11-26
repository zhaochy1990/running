import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { AIMessage, type BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { RaceStrategy } from "@stride/contract";
import { RACE_STRATEGY_PROMPT } from "../prompts.js";
import { loadSkillMarkdown, loadSkillReference } from "../skillLoader.js";
import { CoachTargetRef } from "../turnScope.js";
import { getRaceStrategyAgent } from "./agent.js";
import { raceStrategyViewTool } from "./handoff.js";
import { makeRaceStrategyNode } from "./node.js";
import { extractRaceStrategyResult, parseRaceStrategyFromText, raceStrategyMessage, renderRaceStrategyMarkdown } from "./render.js";

/** agent.ts 实际下发的系统提示：prompt + 补给技能文档 + 规格参考，断言以其为准。 */
const systemPrompt = [RACE_STRATEGY_PROMPT, loadSkillMarkdown("race-strategy"), loadSkillReference("race-strategy", "fueling-products.md")].join("\n\n");

const strategy: RaceStrategy = {
  race_name: "杭州马拉松",
  item_type: "Marathon",
  target_finish_time: "3:59:59",
  summary: "前 30km 稳住目标配速建立节奏，最后 12km 视体感渐进提速。",
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
  fueling_checklist: [
    { item: "能量胶（普通）", count: 3, note: "前半程每 40 分钟一支" },
    { item: "双倍胶", count: 1, note: "30 km 起用，含咖啡因" },
  ],
  course_tips: ["32km 钱塘江大桥爬坡提前降档"],
  weather_tips: ["11 月杭州早晨 12–16℃，穿背心+臂套"],
  basis_note: "以 2025 届官方路线与调研的补给站信息为参考；2026 届路线待公布。",
};

test("race target requires race_event_id and item_type", () => {
  CoachTargetRef.parse({ kind: "race", race_event_id: 30, item_type: "Marathon" });
  assert.throws(() => CoachTargetRef.parse({ kind: "race" }), /race target requires/);
  assert.throws(() => CoachTargetRef.parse({ kind: "race", race_event_id: 30 }), /race target requires item_type/);
  // 既有 target 形态不受影响
  CoachTargetRef.parse({ kind: "session", date: "2026-10-01", session_index: 0 });
});

test("race-strategy prompt gates generation on race content and asks the athlete for the target", () => {
  assert.match(RACE_STRATEGY_PROMPT, /kind=race/);
  assert.match(RACE_STRATEGY_PROMPT, /get_race_calendar_context/);
  assert.match(RACE_STRATEGY_PROMPT, /赛道内容暂未调研/);
  assert.match(RACE_STRATEGY_PROMPT, /basis_note/);
  // 目标只来自运动员自己的表达；没有目标就纯文本追问，不自行依据数据选目标。
  assert.match(RACE_STRATEGY_PROMPT, /这场比赛你想以什么完赛时间作为目标/);
  assert.match(RACE_STRATEGY_PROMPT, /运动员自己的决策/);
  // 能力分析彻底退出策略内容：不查基线、不出现进取/能力口径。
  assert.doesNotMatch(RACE_STRATEGY_PROMPT, /get_performance_baseline/);
  assert.doesNotMatch(RACE_STRATEGY_PROMPT, /进取/);
  assert.doesNotMatch(RACE_STRATEGY_PROMPT, /能力 L4/);
  assert.match(RACE_STRATEGY_PROMPT, /不得包含对运动员跑步能力的分析/);
  // 补给口径（#396 补给优化）：水站交给客户端固定提示、胶分普通/双倍、
  // 盐丸分颗粒/液体、四款常备品二选一，打包清单按品类汇总；
  // 领域细节在 race-strategy 技能文档与规格参考里，随系统提示一起下发。
  assert.match(systemPrompt, /禁止写单纯的喝水\/补水行/);
  assert.match(systemPrompt, /每个水站都进站补水/);
  assert.match(systemPrompt, /双倍胶/);
  assert.match(systemPrompt, /颗粒盐丸/);
  assert.match(systemPrompt, /液体盐丸/);
  assert.match(systemPrompt, /赛速饮/);
  assert.match(systemPrompt, /速耐饮/);
  assert.match(systemPrompt, /酸轻片Pro/);
  assert.match(systemPrompt, /fueling_checklist/);
  assert.match(systemPrompt, /fueling-products\.md/);
});

test("race-strategy prompt asks first on generic entry before generating (#513)", () => {
  // 一键入口只带泛化意图时，先追问参赛意愿/目标成绩/调整点，不直接生成。
  assert.match(RACE_STRATEGY_PROMPT, /是否准备参加/);
  assert.match(RACE_STRATEGY_PROMPT, /跳过追问/);
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
  // 补给打包清单：品类 ×数量 + 用法小字
  assert.match(markdown, /补给打包清单/);
  assert.match(markdown, /能量胶（普通） ×3/);
  assert.match(markdown, /双倍胶 ×1/);
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

test("race-strategy card carries the trusted race ID even when the agent binds during this turn", async () => {
  const userMessage = new HumanMessage("帮我生成杭马的策略，目标三小时五十九分五十九秒");
  const raceTarget = { kind: "race", race_event_id: 76, item_type: "Marathon" } as const;
  let binding: typeof raceTarget | null = null;
  let courseRaceId = 76;
  const node = makeRaceStrategyNode(
    {
      async invoke() {
        binding = raceTarget;
        const course = new ToolMessage({
          name: "get_race_calendar_context",
          tool_call_id: "course",
          content: JSON.stringify({ found: true, race_event_id: courseRaceId, target_item_type: "Marathon" }),
        });
        return { messages: [userMessage, course], structuredResponse: { disposition: "return_direct", content: strategy } };
      },
    },
    {
      async get(threadId) {
        assert.equal(threadId, "regular-chat");
        return binding;
      },
      async bind() {},
      async rememberCandidates() {},
      async candidates() {
        return null;
      },
    },
  );
  const update = (await node({ messages: [userMessage] } as never, { context: { threadId: "regular-chat" } } as never)) as {
    messages: BaseMessage[];
    raceStrategy: RaceStrategy | null;
  };
  assert.deepEqual(update.messages[0]?.additional_kwargs.card, { $type: "race-strategy", data: { ...strategy, race_event_id: 76 } });

  const previousTarget = { kind: "race", race_event_id: 32, item_type: "Marathon" };
  const followUp = (await node(
    { messages: [userMessage] } as never,
    { context: { threadId: "regular-chat", target: previousTarget, raceTargetFromThread: true } } as never,
  )) as typeof update;
  assert.deepEqual(followUp.messages[0]?.additional_kwargs.card, { $type: "race-strategy", data: { ...strategy, race_event_id: 76 } });

  courseRaceId = 32;
  const staleCourse = (await node(
    { messages: [userMessage] } as never,
    { context: { threadId: "regular-chat", target: previousTarget, raceTargetFromThread: true } } as never,
  )) as typeof update;
  assert.equal(staleCourse.raceStrategy, null);
  assert.equal(staleCourse.messages[0]?.additional_kwargs.card, undefined);

  const fromCalendar = (await node(
    { messages: [userMessage] } as never,
    { context: { threadId: "regular-chat", target: previousTarget } } as never,
  )) as typeof update;
  assert.deepEqual(fromCalendar.messages[0]?.additional_kwargs.card, { $type: "race-strategy", data: { ...strategy, race_event_id: 32 } });
});

test("a view-only request routed to the real strategy agent exits after the offer tool", async () => {
  const userMessage = new HumanMessage("刚才的策略在哪里看？");
  const key = "STRIDE_TEST_STRATEGY_OFFER_KEY";
  process.env[key] = "local-test";
  let modelCalls = 0;
  const server = createServer((request, response) => {
    request.resume();
    modelCalls++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "strategy-offer-test",
        object: "chat.completion",
        model: "test-model",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "offer",
                  type: "function",
                  function: {
                    name: raceStrategyViewTool.name,
                    arguments: JSON.stringify({ answer: "刚才的配速建议在上方。" }),
                  },
                },
              ],
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const agent = getRaceStrategyAgent(
      {
        async getRaceCalendarContext() {
          throw new Error("viewing should not read the course");
        },
        async searchRaceCalendar() {
          throw new Error("viewing should not search the calendar");
        },
      },
      {
        name: "strategy-offer-test",
        model: "test-model",
        endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        api_key_env: key,
        api_kind: "chat-completions",
        max_tokens: 256,
        timeout_s: 5,
      },
    );
    const node = makeRaceStrategyNode(agent);
    const update = (await node({ messages: [userMessage] } as never, { context: { userId: "athlete-1", asof: "2026-11-26" } })) as {
      messages: BaseMessage[];
      raceStrategy: unknown;
    };
    assert.equal(modelCalls, 1);
    assert.equal(update.raceStrategy, null);
    assert.deepEqual(update.messages[0]?.additional_kwargs.card, { $type: "race-strategy-offer", data: {} });
  } finally {
    delete process.env[key];
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("race-strategy node normalizes array-content delta before writing back (devops#833)", async () => {
  // responses API 的回复 content 是 content-parts 数组（含空数组）；原样入会话
  // 历史会击穿下游 chat-completions 分类器。写回的增量必须是纯字符串 content，
  // additional_kwargs（card）原样保留。
  const userMessage = new HumanMessage("帮我制定杭马策略");
  const reply = new AIMessage({
    content: [{ type: "text", text: "先确认目标：" }],
    additional_kwargs: { card: { $type: "race-strategy" } },
  });
  const empty = new AIMessage({ content: [] });
  const node = makeRaceStrategyNode({
    async invoke() {
      return { messages: [userMessage, reply, empty] };
    },
  });
  const update = (await node({ messages: [userMessage] } as never, {} as never)) as {
    messages: BaseMessage[];
    raceStrategy: RaceStrategy | null;
  };
  assert.equal(update.messages.length, 2);
  assert.equal(update.messages[0]?.content, "先确认目标：");
  assert.deepEqual((update.messages[0] as AIMessage).additional_kwargs.card, { $type: "race-strategy" });
  assert.equal(update.messages[1]?.content, "");
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

test("raceStrategyMessage produces a plain AI reply message carrying the card envelope", () => {
  const message = raceStrategyMessage(strategy);
  assert.equal(message._getType(), "ai");
  assert.equal(message.tool_calls?.length ?? 0, 0);
  // 信封挂消息自身随 checkpoint 持久化：done/历史投影都从 additional_kwargs
  // 读取（见 coach_agent_api publicResponse），data 与产物本体逐字段一致。
  assert.deepEqual(message.additional_kwargs.card, { $type: "race-strategy", data: strategy });
});

interface BaseMessageLike {
  content: unknown;
}
