import assert from "node:assert/strict";
import test from "node:test";
import { AIMessage, type BaseMessage, HumanMessage } from "@langchain/core/messages";
import { type CustomWorkoutCard, renderRunWorkoutSummary } from "@stride/contract";
import { CUSTOM_WORKOUT_PROMPT } from "../prompts.js";
import { makeCustomWorkoutNode } from "./node.js";
import { customWorkoutCardMessage, extractCustomWorkoutDraft, parseCustomWorkoutFromText, renderCustomWorkoutMarkdown } from "./render.js";

const spec = {
  schema: "run-workout/v1" as const,
  name: "4km×3 组 + 400m×6 间歇",
  date: "2026-10-20",
  note: null,
  blocks: [
    {
      repeat: 3,
      steps: [
        {
          step_kind: "work" as const,
          duration: { kind: "distance_m" as const, value: 4000 },
          target: { kind: "pace_s_km" as const, low: 230, high: 240 },
          note: null,
          hr_cap_bpm: null,
          rest: { kind: "time_s" as const, value: 180 },
        },
      ],
    },
    {
      repeat: 6,
      steps: [
        {
          step_kind: "work" as const,
          duration: { kind: "distance_m" as const, value: 400 },
          target: { kind: "pace_s_km" as const, low: 205, high: 215 },
          note: null,
          hr_cap_bpm: null,
          rest: { kind: "time_s" as const, value: 90 },
        },
      ],
    },
  ],
};

const draft = { date: "2026-10-20", name: spec.name, summary: "3 组 4km 巡航 + 6 个 400m", spec };
const envelope = { disposition: "return_direct" as const, content: draft };

test("node renders the card message with deterministic scalars (save_token/totals/dose)", async () => {
  const seen: Array<{ userId: string; asof: string }> = [];
  const node = makeCustomWorkoutNode({
    agent: {
      async invoke(input) {
        assert.equal((input as { messages: unknown[] }).messages.length, 1);
        return { messages: [], structuredResponse: envelope };
      },
    },
    resolveCalibration: async (userId, asof) => {
      seen.push({ userId, asof });
      return { thresholdSpeedMps: 3.5, thresholdHr: 170, rhrBaseline: 55 };
    },
  });
  const config = { context: { userId: "u-1", asof: "2026-10-19" } };
  const update = (await node({ intent: { intent: "custom_workout" }, messages: [new HumanMessage("x")] } as never, config)) as {
    messages: AIMessage[];
  };
  assert.equal(update.messages.length, 1);
  const card = update.messages[0]?.additional_kwargs?.card as { $type: string; data: CustomWorkoutCard };
  assert.equal(card.$type, "custom-workout");
  assert.equal(card.data.save_token.length, 36);
  assert.equal(card.data.total_distance_m, 14400);
  assert.equal(card.data.total_duration_s, null);
  assert.equal(typeof card.data.estimated_dose, "number");
  assert.deepEqual(seen, [{ userId: "u-1", asof: "2026-10-19" }]);
});

test("node keeps estimated_dose null when calibration is missing (un-calibrated athlete)", async () => {
  const node = makeCustomWorkoutNode({
    agent: {
      async invoke() {
        return { messages: [], structuredResponse: envelope };
      },
    },
    resolveCalibration: async () => null,
  });
  const update = (await node({ intent: { intent: "custom_workout" }, messages: [] } as never, { context: { userId: "u-1", asof: "2026-10-19" } })) as {
    messages: AIMessage[];
  };
  const card = update.messages[0]?.additional_kwargs?.card as { data: CustomWorkoutCard };
  assert.equal(card.data.estimated_dose, null);
  // totals 与 dose 无关，照常补齐。
  assert.equal(card.data.total_distance_m, 14400);
});

test("node falls back to a plain business node when no structured envelope is produced", async () => {
  const reply = new AIMessage("想安排到哪一天？");
  const input = [new HumanMessage("帮我排一节间歇课")];
  const node = makeCustomWorkoutNode({
    agent: {
      async invoke(payload) {
        const prior = (payload as { messages: BaseMessage[] }).messages;
        return { messages: [...prior, reply] };
      },
    },
  });
  const state = { intent: { intent: "custom_workout" }, messages: input } as never;
  const update = (await node(state, {})) as { messages: AIMessage[] };
  assert.deepEqual(update.messages, [reply]);
});

test("node recovers an envelope leaked as plain text (weak-model fallback)", async () => {
  const node = makeCustomWorkoutNode({
    agent: {
      async invoke() {
        return { messages: [new AIMessage(JSON.stringify(envelope))] };
      },
    },
  });
  const update = (await node({ intent: { intent: "custom_workout" }, messages: [] } as never, {})) as {
    messages: AIMessage[];
  };
  const card = update.messages[0]?.additional_kwargs?.card as { $type: string };
  assert.equal(card.$type, "custom-workout");
});

test("node answers honestly on a routing mismatch instead of generating", async () => {
  const node = makeCustomWorkoutNode({
    agent: {
      async invoke() {
        throw new Error("must not be invoked");
      },
    },
  });
  const update = (await node({ intent: { intent: "qa" }, messages: [] } as never, {})) as { messages: AIMessage[] };
  assert.equal(update.messages.length, 1);
});

test("node fails the turn with copy when the inner agent throws or times out", async () => {
  const throwing = makeCustomWorkoutNode({
    agent: {
      async invoke() {
        throw new Error("boom");
      },
    },
  });
  const failed = (await throwing({ intent: { intent: "custom_workout" }, messages: [] } as never, {})) as { messages: AIMessage[] };
  assert.match(failed.messages[0]?.content as string, /没能解析成功/);

  const timingOut = makeCustomWorkoutNode({
    agent: {
      invoke: () => new Promise(() => undefined),
    },
    timeoutMs: 1,
  });
  const timedOut = (await timingOut({ intent: { intent: "custom_workout" }, messages: [] } as never, {})) as { messages: AIMessage[] };
  assert.match(timedOut.messages[0]?.content as string, /超出了限制/);
});

test("card message carries the markdown summary with the deterministic workout render", () => {
  const card: CustomWorkoutCard = {
    save_token: "t-1",
    date: "2026-10-20",
    name: spec.name,
    summary: draft.summary,
    total_distance_m: 14400,
    total_duration_s: null,
    estimated_dose: null,
    spec,
  };
  const message = customWorkoutCardMessage(card);
  assert.ok((message.content as string).includes(renderRunWorkoutSummary(spec)));
  const extracted = extractCustomWorkoutDraft({ structuredResponse: envelope });
  assert.equal(extracted?.date, "2026-10-20");
  assert.equal(extracted?.spec.blocks.length, 2);
});

test("defensive text parse: envelope and bare-draft shapes recover, prose does not", () => {
  assert.ok(parseCustomWorkoutFromText(JSON.stringify(envelope)));
  assert.ok(parseCustomWorkoutFromText(JSON.stringify(draft)));
  assert.ok(parseCustomWorkoutFromText(`\`\`\`json\n${JSON.stringify(envelope)}\n\`\`\``));
  assert.equal(parseCustomWorkoutFromText("想安排到哪一天？"), undefined);
  assert.equal(parseCustomWorkoutFromText('{"date":"2026-10-20"}'), undefined);
});

test("markdown renderer includes advice when present", () => {
  const card: CustomWorkoutCard = {
    save_token: "t-1",
    date: "2026-10-20",
    name: "x",
    summary: "y",
    advice: "400m 段配速已接近你的阈值，注意热身充分。",
    total_distance_m: 400,
    total_duration_s: null,
    estimated_dose: null,
    spec,
  };
  assert.ok(renderCustomWorkoutMarkdown(card).includes("注意热身充分"));
});

test("prompt hard rules: shorthand conversion, date anchor, and boundary routing samples", () => {
  assert.ok(CUSTOM_WORKOUT_PROMPT.includes("350-400 → 3:50–4:00/km 即 low=230, high=240"));
  assert.ok(CUSTOM_WORKOUT_PROMPT.includes('组间休息3分钟」→ rest {kind:"time_s", value:180}'));
  assert.ok(CUSTOM_WORKOUT_PROMPT.includes("想安排到哪一天"));
  // orchestrator 边界（误路由样本）：明天跑什么仍是问答，调整周计划仍走 weekly_plan。
  assert.ok(CUSTOM_WORKOUT_PROMPT.includes("不要把休息写成平级的 rest step"));
});
