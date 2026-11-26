import assert from "node:assert/strict";
import test from "node:test";
import { AIMessage, type BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { StructuredTool } from "@langchain/core/tools";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { getQaTools } from "../agents/qa/agent.js";
import type { Activity, DataProvider, ManualStrengthRecord } from "../data/dataProvider.js";

test("ordinary Coach uses hand-entered sets without reading overlapping watch data", async () => {
  const startedAt = new Date("2026-11-25T16:05:00Z");
  const record = {
    id: "manual-1",
    name: "夜间力量",
    startedAt,
    endedAt: new Date("2026-11-25T16:30:00Z"),
    note: "左侧发力更稳",
    actions: [{ name: "单腿蹲", sets: [{ load: "12", load_unit: "kg", quantity: 8, quantity_unit: "reps" }] }],
  };
  const store = {
    async getManualStrengthSummaries(userId: string, startDay: string, endDay: string) {
      assert.deepEqual([userId, startDay, endDay], ["athlete-a", "2026-11-26", "2026-11-26"]);
      return [record];
    },
    async getManualStrengthDetail(userId: string, recordId: string) {
      assert.deepEqual([userId, recordId], ["athlete-a", "manual-1"]);
      return record;
    },
    async getWatchStrengthSummaries() {
      throw new Error("watch data was not requested");
    },
  } as unknown as DataProvider;
  const tools: StructuredTool[] = getQaTools(store);
  const tool = tools.find((candidate) => candidate.name === "get_strength_training_review");
  assert.ok(tool, "the tool must be registered on the ordinary Coach question-answering path");

  const review = await tool.invoke({ startDay: "2026-11-26" }, { context: { userId: "athlete-a", asof: "2026-11-26" } });
  assert.deepEqual(review, {
    status: "found",
    source: "manual",
    scope: { startDay: "2026-11-26", endDay: "2026-11-26" },
    record: {
      id: "manual-1",
      name: "夜间力量",
      startedAt: "2026-11-26T00:05:00.000+08:00",
      endedAt: "2026-11-26T00:30:00.000+08:00",
      note: "左侧发力更稳",
      actions: [{ name: "单腿蹲", sets: [{ load: "12", load_unit: "kg", quantity: 8, quantity_unit: "reps" }] }],
    },
  });
});

const day = "2026-11-26";
const manualRecord: ManualStrengthRecord = {
  id: "manual-a",
  name: "早晨力量",
  startedAt: new Date("2026-11-26T00:15:00Z"),
  endedAt: new Date("2026-11-26T00:39:00Z"),
  note: "单侧发力",
  actions: [
    {
      name: "平板支撑",
      sets: [
        { load: "", load_unit: "bodyweight", quantity: 40, quantity_unit: "seconds" },
        { load: "蓝色弹力带", load_unit: "kg", quantity: 11, quantity_unit: "reps" },
      ],
    },
  ],
};
const secondManual = { ...manualRecord, id: "manual-b", name: "晚间力量", startedAt: new Date("2026-11-26T11:30:00Z") };
const watchA = { id: "watch-a", name: "手表早晨力量", startedAt: new Date("2026-11-26T00:05:00Z"), provider: "coros" };
const watchB = { id: "watch-b", name: "手表晚上力量", startedAt: new Date("2026-11-26T10:30:00Z"), provider: "garmin" };

function fixture(manualRecords: ManualStrengthRecord[], watches = [watchA, watchB]) {
  const detailReads: string[] = [];
  const store = {
    async getManualStrengthSummaries(owner: string) {
      return owner === "athlete-a" ? manualRecords : [];
    },
    async getManualStrengthDetail(owner: string, id: string) {
      detailReads.push(id);
      return owner === "athlete-a" ? (manualRecords.find((record) => record.id === id) ?? null) : null;
    },
    async getWatchStrengthSummaries(owner: string) {
      return owner === "athlete-a" ? watches : [];
    },
    async getActivityDetail(owner: string, id: string) {
      detailReads.push(id);
      if (owner !== "athlete-a" || !watches.some((watch) => watch.id === id)) return null;
      return {
        userId: owner,
        labelId: id,
        sport: "strength",
        isStrength: true,
        shanghaiDay: day,
        name: "手表记录",
        avgHr: id === "watch-b" ? 137 : null,
        maxHr: null,
        durationS: 1450,
        sportNote: "其他手表数据",
        laps: [
          { lapIndex: 1, lapType: "type2", mode: null, exerciseNameKey: "PLANK", durationS: 43, avgHr: null, maxHr: null },
          { lapIndex: 2, lapType: "type2", mode: 15, exerciseNameKey: null, durationS: 10, avgHr: null, maxHr: null },
          { lapIndex: 3, lapType: "type2", mode: null, exerciseNameKey: "T1123", durationS: 10, avgHr: null, maxHr: null },
        ],
      } as Activity;
    },
    async getActivitySummariesByDateRange(owner: string) {
      if (owner !== "athlete-a") return [];
      return [
        { labelId: watchA.id, isStrength: true, date: watchA.startedAt, shanghaiDay: day, avgHr: 128, durationS: 1450, sportNote: "手表备注" } as Activity,
      ];
    },
  } satisfies Pick<
    DataProvider,
    "getManualStrengthSummaries" | "getManualStrengthDetail" | "getWatchStrengthSummaries" | "getActivityDetail" | "getActivitySummariesByDateRange"
  >;
  return { store: store as unknown as DataProvider, detailReads };
}

async function execute(
  store: DataProvider,
  message: string,
  args: Record<string, unknown>,
  userId = "athlete-a",
  name = "get_strength_training_review",
  history: BaseMessage[] = [],
) {
  const tools: StructuredTool[] = getQaTools(store);
  const node = new ToolNode(tools, { handleToolErrors: false });
  const config = { tags: [], context: { userId, asof: day } };
  const output = await node.invoke(
    {
      messages: [
        ...history,
        new HumanMessage(JSON.stringify({ timestamp: "2026-11-26T18:30:00+08:00", message })),
        new AIMessage({ content: "", tool_calls: [{ name, args, id: "read-strength" }] }),
      ],
    },
    config,
  );
  assert.equal(typeof output.messages[0]?.content, "string");
  return JSON.parse(output.messages[0].content);
}

test("two same-day manual candidates are listed without giving an undesignated record's sets", async () => {
  const { store, detailReads } = fixture([manualRecord, secondManual]);
  const ambiguous = await execute(store, "帮我复盘 11 月 26 日的力量训练", { startDay: day });
  assert.deepEqual(ambiguous, {
    status: "ambiguous",
    source: "manual",
    scope: { startDay: day, endDay: day },
    candidates: [
      { id: "manual-a", name: "早晨力量", startedAt: "2026-11-26T08:15:00.000+08:00" },
      { id: "manual-b", name: "晚间力量", startedAt: "2026-11-26T19:30:00.000+08:00" },
    ],
    truncated: false,
  });
  assert.equal((await execute(store, "帮我复盘 11 月 26 日的力量训练", { startDay: day, recordId: "manual-b" })).status, "ambiguous");
  assert.deepEqual(detailReads, []);

  const chosen = await execute(store, "复盘「早晨力量」那条", { startDay: day, recordId: "manual-a" });
  assert.deepEqual(chosen.record.actions, manualRecord.actions);
  assert.deepEqual(detailReads, ["manual-a"]);
});

test("an explicit watch selection permits only the chosen watch's heart rate", async () => {
  const { store, detailReads } = fixture([manualRecord]);
  const unrequested = await execute(store, "只复盘手录，看看平板支撑多少秒", { startDay: day, watchReference: "18:30" });
  assert.equal(unrequested.watchSupplementStatus, "needs_explicit_reference");
  const inferred = await execute(store, "也看看手表的心率", { startDay: day, watchReference: watchB.id });
  assert.equal(inferred.watchSupplementStatus, "needs_explicit_reference");
  const result = await execute(store, "复盘手录，补充 18:30 那条手表的心率", { startDay: day, watchReference: "18:30" });
  assert.deepEqual(result.watchHeartRate, {
    id: "watch-b",
    source: "watch",
    name: "手表晚上力量",
    provider: "garmin",
    startedAt: "2026-11-26T18:30:00.000+08:00",
    avgHr: 137,
    maxHr: null,
  });
  assert.deepEqual(result.record.actions, manualRecord.actions);
  assert.deepEqual(detailReads, ["manual-a", "manual-a", "manual-a", "watch-b"]);
});

test("watch-only fallback preserves unknown measurements and other users cannot select the record", async () => {
  const { store, detailReads } = fixture([], [watchA]);
  const result = await execute(store, "今天力量训练做了哪些组", { startDay: day });
  assert.equal(result.source, "watch");
  assert.deepEqual(result.record.sets, [{ lapIndex: 1, exerciseNameKey: "PLANK", durationS: 43, avgHr: null, maxHr: null, reps: null, load: null }]);
  assert.equal(result.record.avgHr, null);
  assert.deepEqual(await execute(store, "查 watch-a", { startDay: day, recordId: watchA.id, userId: "athlete-a" }, "athlete-b"), { status: "missing" });
  assert.deepEqual(detailReads, ["watch-a"]);
});

test("generic Coach activity reads withhold watch strength measurements", async () => {
  const { store } = fixture([manualRecord]);
  const detail = await execute(store, "今天力量训练", { labelId: watchA.id }, "athlete-a", "get_activity_details");
  assert.equal(detail.activity, null);
  assert.equal(detail.reviewTool, "get_strength_training_review");
  const summaries = await execute(store, "今天有哪些活跃记录", { startDay: day }, "athlete-a", "get_activities_by_date_range");
  assert.deepEqual(Object.keys(summaries.activities[0]).sort(), ["date", "labelId", "laps", "reviewTool", "shanghaiDay", "sport"].sort());
  assert.equal(summaries.activities[0].labelId, watchA.id);

  const watchOnly = await execute(fixture([]).store, "今天有哪些活跃记录", { startDay: day }, "athlete-a", "get_activities_by_date_range");
  assert.equal(watchOnly.activities[0].durationS, 1450);
  assert.equal(watchOnly.activities[0].avgHr, 128);
  const watchOnlyDetail = await execute(fixture([]).store, "这条手表运动的心率", { labelId: watchB.id }, "athlete-a", "get_activity_details");
  assert.equal(watchOnlyDetail.activity.avgHr, 137);
});

test("a substring of an explicitly named time cannot select a different watch record", async () => {
  const earlier = { ...watchA, startedAt: new Date("2026-11-26T00:30:00Z") };
  const { store, detailReads } = fixture([manualRecord], [earlier, watchB]);
  const rejected = await execute(store, "补充 18:30 那条手表记录的心率", { startDay: day, watchReference: "8:30" });
  assert.equal(rejected.watchSupplementStatus, "needs_explicit_reference");
  assert.deepEqual(detailReads, ["manual-a"]);
  const result = await execute(store, "补充 18点30分 那条手表记录的心率", { startDay: day, watchReference: "18点30分" });
  assert.equal(result.watchHeartRate.id, "watch-b");
});

test("effective manual choice survives follow-up in the same scope and supports numbered clarification", async () => {
  const { store } = fixture([manualRecord, secondManual]);
  const first = await execute(store, "复盘今天的力量训练", { startDay: day });
  assert.equal(first.status, "ambiguous");
  const firstTurn = [
    new HumanMessage("复盘今天的力量训练"),
    new AIMessage({ content: "", tool_calls: [{ name: "get_strength_training_review", args: { startDay: day }, id: "first" }] }),
    new ToolMessage({ name: "get_strength_training_review", tool_call_id: "first", content: JSON.stringify(first) }),
    new AIMessage("你想复盘第几条？"),
  ];
  const rejected = await execute(
    store,
    "不要第二条，先看第一条",
    { startDay: day, recordId: "manual-b" },
    "athlete-a",
    "get_strength_training_review",
    firstTurn,
  );
  assert.equal(rejected.status, "ambiguous");
  const affirmed = await execute(
    store,
    "不要第二条，先看第一条",
    { startDay: day, recordId: "manual-a" },
    "athlete-a",
    "get_strength_training_review",
    firstTurn,
  );
  assert.equal(affirmed.record.id, "manual-a");
  const rejectedName = await execute(store, "今天只复盘晚间力量以外的那条", { startDay: day, recordId: "manual-b" });
  assert.equal(rejectedName.status, "ambiguous");
  const choice = await execute(store, "第二条", { startDay: day, recordId: "manual-b" }, "athlete-a", "get_strength_training_review", firstTurn);
  assert.equal(choice.record.id, "manual-b");
  const previousTurn = [
    ...firstTurn,
    new HumanMessage("第二条"),
    new AIMessage({ content: "", tool_calls: [{ name: "get_strength_training_review", args: { startDay: day, recordId: "manual-b" }, id: "choice" }] }),
    new ToolMessage({ name: "get_strength_training_review", tool_call_id: "choice", content: JSON.stringify(choice) }),
    new AIMessage("晚间力量第一组是 40 秒。"),
  ];
  const followUp = await execute(store, "第二组做了几次？", { recordId: "manual-b" }, "athlete-a", "get_strength_training_review", previousTurn);
  assert.equal(followUp.record.actions[0].sets[1].quantity, 11);
  const differentWorkout = await execute(
    store,
    "今天还有另外一条力量训练，那条做了什么？",
    { startDay: day, recordId: "manual-b" },
    "athlete-a",
    "get_strength_training_review",
    previousTurn,
  );
  assert.equal(differentWorkout.status, "ambiguous");
  const newDay = await execute(store, "看看昨天", { startDay: day, recordId: "manual-b" }, "athlete-a", "get_strength_training_review", previousTurn);
  assert.deepEqual(newDay, { status: "scope_mismatch", expectedDay: "2026-11-25" });
});

test("unsupported latest and mismatched day do not authorize a read", async () => {
  const { store, detailReads } = fixture([manualRecord]);
  for (const args of [{ startDay: day }, { latest: true }]) {
    const result = await execute(store, "复盘昨天的力量训练", args);
    assert.deepEqual(result, { status: "scope_mismatch", expectedDay: "2026-11-25" });
  }
  assert.deepEqual(detailReads, []);
});

test("the default date-based name does not select an ambiguous session", async () => {
  const { store } = fixture([{ ...manualRecord, name: `${day} 力量训练` }, secondManual]);
  const answer = await execute(store, `复盘 ${day} 力量训练`, { startDay: day, recordId: "manual-a" });
  assert.equal(answer.status, "ambiguous");
});

test("only a positive watch-local reference can authorize a supplement", async () => {
  const { store, detailReads } = fixture([manualRecord]);
  for (const question of [
    "不要看手表，复盘 18:30 的手录",
    "复盘18:30那条手录，手表心率不用看",
    "手表 8:05 和手录 18:30，补充手表的心率",
    "复盘手录，不要看 18:30 的手表心率",
    "复盘手录，手表 18:30 记录错误，手表 8:05 请补充心率",
  ]) {
    const answer = await execute(store, question, { startDay: day, watchReference: "18:30" });
    assert.equal(answer.watchSupplementStatus, "needs_explicit_reference", question);
  }
  assert.deepEqual(detailReads, ["manual-a", "manual-a", "manual-a", "manual-a", "manual-a"]);
});

test("a relative date used as a range endpoint does not narrow the review to one day", async () => {
  const result = await execute(fixture([manualRecord]).store, "复盘截至昨天的本周力量训练", {
    startDay: "2026-11-23",
    endDay: "2026-11-25",
  });
  assert.equal(result.status, "found");
  assert.deepEqual(result.scope, { startDay: "2026-11-23", endDay: "2026-11-25" });
});

test("a second watch record in the same affirmative clause stops heart rate attribution", async () => {
  const { store, detailReads } = fixture([manualRecord]);
  const result = await execute(store, "补充手表 watch-a 的心率（手表 watch-b 记录错误）", { startDay: day, watchReference: watchB.id });
  assert.equal(result.watchSupplementStatus, "ambiguous");
  assert.deepEqual(detailReads, ["manual-a"]);
});

test("a watch detail cannot bypass the manual policy during a multi-day strength review", async () => {
  const base = fixture([]).store;
  const detail = await execute(base, "复盘 11 月 25 日到 26 日的力量训练", { labelId: watchB.id }, "athlete-a", "get_activity_details");
  assert.equal(detail.activity, null);
  assert.equal(detail.reviewTool, "get_strength_training_review");
});
