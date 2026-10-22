import assert from "node:assert/strict";
import test from "node:test";
import { type AIMessage, type BaseMessage, HumanMessage, type SystemMessage } from "@langchain/core/messages";
import type { DaySessionRow } from "../../data/dataProvider.js";
import { makeWorkoutManageNode, WORKOUT_MANAGE_PROMPT } from "./node.js";

/** 近 7 天至未来 14 天窗口内的已存课（三源各一 + 第二个 custom，供指认/防幻觉用例）。 */
const rows: DaySessionRow[] = [
  {
    workout_id: "wk-1",
    date: "2026-10-21",
    source: "weekly",
    kind: "run",
    name: "周三有氧",
    summary: "周计划课",
    spec_json: null,
    save_token: null,
    pushed: false,
  },
  {
    workout_id: "cu-1",
    date: "2026-10-23",
    source: "custom",
    kind: "run",
    name: "4km×3组",
    summary: "3 组 4km 巡航",
    spec_json: null,
    save_token: "tok-1",
    pushed: false,
  },
  {
    workout_id: "cu-2",
    date: "2026-10-25",
    source: "custom",
    kind: "run",
    name: "10k 有氧",
    summary: null,
    spec_json: null,
    save_token: "tok-2",
    pushed: true,
  },
  { workout_id: "wa-1", date: "2026-10-26", source: "watch", kind: "run", name: "手表同步课", summary: null, spec_json: null, save_token: null, pushed: true },
];

const CONFIG = { context: { userId: "u-1", asof: "2026-10-22" } };
const STATE = { intent: { intent: "workout_manage" as const }, messages: [new HumanMessage("把明天的课删了")] } as never;

interface ModelCall {
  messages: BaseMessage[];
  options: unknown;
}

/** JSON-mode 假模型：记录调用并回放决策 JSON。 */
function fakeModel(payload: string) {
  const calls: ModelCall[] = [];
  return {
    calls,
    model: {
      async invoke(messages: BaseMessage[], options?: unknown) {
        calls.push({ messages, options });
        return { text: payload };
      },
    },
  };
}

function fakeSessions() {
  const calls: Array<{ userId: string; dateFrom: string; dateTo: string }> = [];
  return {
    calls,
    resolver: async (userId: string, dateFrom: string, dateTo: string) => {
      calls.push({ userId, dateFrom, dateTo });
      return rows;
    },
  };
}

function makeNode(payload: string) {
  const { calls, model } = fakeModel(payload);
  const sessions = fakeSessions();
  return { node: makeWorkoutManageNode({ model, listSessions: sessions.resolver }), model: calls, sessions: sessions.calls };
}

test("delete hit issues a workout-op confirmation card for the resolved custom session", async () => {
  const { node, model, sessions } = makeNode(JSON.stringify({ action: "delete", workout_id: "cu-1", reply: "好的" }));
  const update = (await node(STATE, CONFIG)) as { messages: AIMessage[]; llmCalls: number };

  // 指认窗口：asof-7d .. asof+14d。
  assert.deepEqual(sessions, [{ userId: "u-1", dateFrom: "2026-10-15", dateTo: "2026-11-05" }]);
  // JSON-mode 单次调用（DeepSeek 实测可靠路径），SystemMessage 带今天与全量列表。
  assert.equal(model.length, 1);
  assert.deepEqual(model[0]?.options, { response_format: { type: "json_object" } });
  const system = model[0]?.messages[0] as SystemMessage;
  assert.match(String(system.content), /今天（Asia\/Shanghai 日历日）是 2026-10-22/);
  assert.match(String(system.content), /workout_id=cu-1/);
  assert.match(String(system.content), /source=weekly/);
  assert.equal(update.llmCalls, 1);

  const card = update.messages[0]?.additional_kwargs?.card as { $type: string; data: Record<string, unknown> };
  assert.equal(card.$type, "workout-op");
  assert.deepEqual(card.data, {
    op: "delete",
    workout_id: "cu-1",
    date: "2026-10-23",
    name: "4km×3组",
    kind: "run",
    summary: "3 组 4km 巡航",
    pushed: false,
  });
  assert.equal("new_date" in card.data, false, "delete card carries no new_date");
  assert.match(update.messages[0]?.content as string, /删除 2026-10-23 的「4km×3组」/);
});

test("move hit carries the resolved new_date and the watch note for a pushed session", async () => {
  const { node } = makeNode(JSON.stringify({ action: "move", workout_id: "cu-2", new_date: "2026-10-30", reply: "好的" }));
  const update = (await node(STATE, CONFIG)) as { messages: AIMessage[] };
  const card = update.messages[0]?.additional_kwargs?.card as { data: Record<string, unknown> };
  assert.equal(card.data.op, "move");
  assert.equal(card.data.new_date, "2026-10-30");
  assert.equal(card.data.pushed, true);
  assert.match(update.messages[0]?.content as string, /改期到 2026-10-30/);
  assert.match(update.messages[0]?.content as string, /已推送到手表/);
});

test("unclear answers with the model reply plus the custom-session listing, no card", async () => {
  const { node } = makeNode(JSON.stringify({ action: "unclear", reply: "想删哪节课？" }));
  const update = (await node(STATE, CONFIG)) as { messages: AIMessage[] };
  const content = update.messages[0]?.content as string;
  assert.match(content, /想删哪节课？/);
  assert.match(content, /2026-10-23「4km×3组」/);
  assert.match(content, /2026-10-25「10k 有氧」/);
  assert.equal(update.messages[0]?.additional_kwargs?.card, undefined);
});

test("a hallucinated workout_id never executes — falls back to clarification", async () => {
  const { node } = makeNode(JSON.stringify({ action: "delete", workout_id: "cu-999" }));
  const update = (await node(STATE, CONFIG)) as { messages: AIMessage[] };
  assert.equal(update.messages[0]?.additional_kwargs?.card, undefined);
  assert.match(update.messages[0]?.content as string, /不能确定你指的是哪节课/);
  assert.match(update.messages[0]?.content as string, /2026-10-23「4km×3组」/);
});

test("move without a valid YYYY-MM-DD target date asks for the date instead of guessing", async () => {
  const { node } = makeNode(JSON.stringify({ action: "move", workout_id: "cu-1", new_date: "周五" }));
  const update = (await node(STATE, CONFIG)) as { messages: AIMessage[] };
  assert.equal(update.messages[0]?.additional_kwargs?.card, undefined);
  assert.match(update.messages[0]?.content as string, /挪到哪一天/);
});

test("weekly and watch targets are politely rejected as unsupported", async () => {
  const weekly = makeNode(JSON.stringify({ action: "delete", workout_id: "wk-1" }));
  const weeklyUpdate = (await weekly.node(STATE, CONFIG)) as { messages: AIMessage[] };
  assert.equal(weeklyUpdate.messages[0]?.additional_kwargs?.card, undefined);
  assert.match(weeklyUpdate.messages[0]?.content as string, /周计划课，暂不支持在对话里删除或改期/);

  const watch = makeNode(JSON.stringify({ action: "move", workout_id: "wa-1", new_date: "2026-10-30" }));
  const watchUpdate = (await watch.node(STATE, CONFIG)) as { messages: AIMessage[] };
  assert.equal(watchUpdate.messages[0]?.additional_kwargs?.card, undefined);
  assert.match(watchUpdate.messages[0]?.content as string, /手表同步课，暂不支持/);
});

test("a decision that fails to decode clarifies instead of crashing the turn", async () => {
  const { node } = makeNode("这不是 JSON");
  const update = (await node(STATE, CONFIG)) as { messages: AIMessage[]; llmCalls: number };
  assert.equal(update.messages[0]?.additional_kwargs?.card, undefined);
  assert.match(update.messages[0]?.content as string, /不能确定你指的是哪节课/);
  assert.equal(update.llmCalls, 1);
});

test("a routing mismatch or missing runtime context never invokes the model", async () => {
  const { node, model } = makeNode("{}");
  const misrouted = (await node({ intent: { intent: "qa" }, messages: [] } as never, CONFIG)) as { messages: AIMessage[] };
  assert.equal(misrouted.messages.length, 1);
  assert.equal(model.length, 0);

  const noContext = (await node(STATE, {})) as { messages: AIMessage[] };
  assert.match(noContext.messages[0]?.content as string, /没能处理你的请求/);
  assert.equal(model.length, 0);

  const failing = makeNodeWithFailingList();
  const failed = (await failing(STATE, CONFIG)) as { messages: AIMessage[] };
  assert.match(failed.messages[0]?.content as string, /没能处理你的请求/);
});

function makeNodeWithFailingList() {
  return makeWorkoutManageNode({
    model: {
      async invoke() {
        throw new Error("must not be invoked");
      },
    },
    listSessions: async () => {
      throw new Error("db down");
    },
  });
}

test("prompt hard rules: id provenance, content-change boundary, no fabrication", () => {
  assert.match(WORKOUT_MANAGE_PROMPT, /workout_id 只能来自已存课列表，绝不臆造/);
  assert.match(WORKOUT_MANAGE_PROMPT, /改期\+改内容」混合请求时，不是本助手职责/);
  assert.match(WORKOUT_MANAGE_PROMPT, /列表为空时一律 unclear/);
});
