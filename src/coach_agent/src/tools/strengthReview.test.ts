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
    async getUserProfile(userId: string) {
      assert.equal(userId, "athlete-a");
      return { runningAgeRange: "3-5年" };
    },
    async getUserInjuries(userId: string) {
      assert.equal(userId, "athlete-a");
      return [{ description: "旧踝伤", recoveryStatus: "恢复中", runningRestriction: "避免跳跃" }];
    },
    async getMasterPlanMetadataForDate(userId: string, recordDay: string) {
      assert.deepEqual([userId, recordDay], ["athlete-a", "2026-11-26"]);
      return { content: { phases: [{ name: "专项期", start_date: "2026-11-20", end_date: "2026-12-10", focus: "跑步专项" }] } };
    },
    async getRaceTarget(userId: string) {
      assert.equal(userId, "athlete-a");
      return { race_date: "2026-12-20", race_name: "冬季半马", race_distance: "HM", target_finish_time: "01:50:00" };
    },
    async getPlanSessions(userId: string, from: string, to: string) {
      assert.deepEqual([userId, from, to], ["athlete-a", "2026-11-23", "2026-11-29"]);
      return [
        { date: "2026-11-27", name: "轻松跑", source: "weekly", kind: "run", summary: "8 km" },
        { date: "2026-11-27", name: "手表课表", source: "watch", kind: "run" },
      ];
    },
    async getActivityDetail() {
      assert.fail("a manual review must not query watch activities");
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
      recordingStartedAt: "2026-11-26T00:05:00.000+08:00",
      note: "左侧发力更稳",
      actions: [{ name: "单腿蹲", sets: [{ load: "12", load_unit: "kg", quantity: 8, quantity_unit: "reps" }] }],
    },
    athleteContext: {
      asOfDay: "2026-11-26",
      runningAgeRange: "3-5年",
      injuries: [{ description: "旧踝伤", recoveryStatus: "恢复中", runningRestriction: "避免跳跃" }],
      phase: { name: "专项期", start_date: "2026-11-20", end_date: "2026-12-10", focus: "跑步专项" },
      currentRaceGoal: { name: "冬季半马", date: "2026-12-20", distance: "HM", targetFinishTime: "01:50:00" },
      plannedRuns: [{ date: "2026-11-27", name: "轻松跑", summary: "8 km" }],
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
const run = { labelId: "morning-run", sport: "running", shanghaiDay: day, avgHr: 145, durationS: 1800 } as Activity;

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
    async getUserProfile() {
      return null;
    },
    async getUserInjuries() {
      return [];
    },
    async getMasterPlanMetadataForDate() {
      return null;
    },
    async getRaceTarget() {
      return null;
    },
    async getPlanSessions() {
      return [];
    },
    async getActivityDetail(owner: string, id: string, options?: { excludeStrength?: boolean }) {
      if (owner === "athlete-a" && id === run.labelId) {
        detailReads.push(id);
        return run;
      }
      if (options?.excludeStrength) return null;
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
    async getActivitySummariesByDateRange(owner: string, _start: string, _end: string, options?: { excludeStrength?: boolean }) {
      if (owner !== "athlete-a") return [];
      if (options?.excludeStrength) return [run];
      return [
        { labelId: watchA.id, isStrength: true, date: watchA.startedAt, shanghaiDay: day, avgHr: 128, durationS: 1450, sportNote: "手表备注" } as Activity,
      ];
    },
  } satisfies Pick<
    DataProvider,
    | "getManualStrengthSummaries"
    | "getManualStrengthDetail"
    | "getActivityDetail"
    | "getActivitySummariesByDateRange"
    | "getUserProfile"
    | "getUserInjuries"
    | "getMasterPlanMetadataForDate"
    | "getRaceTarget"
    | "getPlanSessions"
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
  strengthReviewRecordId?: string,
) {
  const tools: StructuredTool[] = getQaTools(store);
  const node = new ToolNode(tools, { handleToolErrors: false });
  const config = { tags: [], context: { userId, asof: day, strengthReviewRecordId } };
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
      { id: "manual-a", name: "早晨力量", recordingStartedAt: "2026-11-26T08:15:00.000+08:00" },
      { id: "manual-b", name: "晚间力量", recordingStartedAt: "2026-11-26T19:30:00.000+08:00" },
    ],
    truncated: false,
  });
  assert.equal((await execute(store, "帮我复盘 11 月 26 日的力量训练", { startDay: day, recordId: "manual-b" })).status, "ambiguous");
  assert.deepEqual(detailReads, []);

  const chosen = await execute(store, "复盘「早晨力量」那条", { startDay: day, recordId: "manual-a" });
  assert.deepEqual(chosen.record.actions, manualRecord.actions);
  assert.deepEqual(detailReads, ["manual-a"]);
});

test("old watch references are ignored, with or without a saved manual strength record", async () => {
  const manual = fixture([manualRecord]);
  const args = { startDay: day, watchReference: watchA.id };
  const review = await execute(manual.store, "复盘力量训练，也查手表 watch-a 心率", args);
  assert.equal(review.source, "manual");
  assert.deepEqual(manual.detailReads, [manualRecord.id]);
  assert.equal("watchHeartRate" in review, false);
  assert.equal("endedAt" in review.record, false);
  const missing = fixture([]);
  assert.deepEqual(await execute(missing.store, "今天力量训练做了哪些组", args), { status: "missing", source: "manual" });
  assert.deepEqual(await execute(manual.store, "复盘力量训练", args, "athlete-b"), { status: "missing", source: "manual" });
  assert.deepEqual(missing.detailReads, []);
});

test("manual reviews bypass watch reads while independent watch activity queries stay available", async () => {
  const { store } = fixture([manualRecord]);
  const detail = await execute(store, "今天力量训练", { labelId: watchA.id }, "athlete-a", "get_activity_details");
  assert.equal(detail.activity, null);
  assert.equal(detail.reviewTool, "get_strength_training_review");
  const summaries = await execute(store, "今天有哪些活跃记录", { startDay: day }, "athlete-a", "get_activities_by_date_range");
  assert.equal(summaries.activities[0].labelId, watchA.id);
  const watchOnlyDetail = await execute(store, "这条手表力量训练的平均心率是多少？", { labelId: watchB.id }, "athlete-a", "get_activity_details");
  assert.equal(watchOnlyDetail.activity.avgHr, 137);
});

test("a follow-up after missing manual evidence cannot fall back to watch heart rate", async () => {
  const { store, detailReads } = fixture([]);
  const history = [
    new HumanMessage("复盘今天的力量训练"),
    new AIMessage({ content: "", tool_calls: [{ name: "get_strength_training_review", args: { startDay: day }, id: "manual" }] }),
    new ToolMessage({ name: "get_strength_training_review", tool_call_id: "manual", content: JSON.stringify({ status: "missing", source: "manual" }) }),
    new AIMessage("今天没有手动记录"),
  ];
  for (const question of ["那平均心率呢？", "那一共练了多久？"]) {
    const followUp = await execute(store, question, { labelId: watchB.id }, "athlete-a", "get_activity_details", history);
    assert.equal(followUp.activity, null);
    assert.equal(followUp.reviewTool, "get_strength_training_review");
  }
  assert.deepEqual(detailReads, []);
  const list = await execute(store, "那平均心率呢？", { startDay: day }, "athlete-a", "get_activities_by_date_range", history);
  assert.deepEqual(list.activities, []);
  assert.equal(list.reviewTool, "get_strength_training_review");
  const supplement = await execute(store, "那手表测到的心率呢？", { labelId: watchB.id }, "athlete-a", "get_activity_details", history);
  assert.equal(supplement.activity, null);
  assert.deepEqual(detailReads, []);
  const newTopic = await execute(store, "换个话题，这条手表力量训练的平均心率是多少？", { labelId: watchB.id }, "athlete-a", "get_activity_details", history);
  assert.equal(newTopic.activity.avgHr, 137);
  const syncDetail = await execute(store, "高驰上同步的那次力量训练平均心率是多少？", { labelId: watchB.id }, "athlete-a", "get_activity_details", history);
  assert.equal(syncDetail.activity.avgHr, 137);
  const runDetail = await execute(store, "今天晨跑平均心率是多少？", { labelId: run.labelId }, "athlete-a", "get_activity_details", history);
  assert.equal(runDetail.activity.avgHr, 145);
});

test("a combined run and strength question can read the run, excluding watch strength", async () => {
  const { store, detailReads } = fixture([manualRecord]);
  const question = "今天的跑步和力量训练各用了多久？";
  const list = await execute(store, question, { startDay: day }, "athlete-a", "get_activities_by_date_range");
  assert.deepEqual(
    list.activities.map((activity: Activity) => activity.labelId),
    [run.labelId],
  );
  const strength = await execute(store, question, { labelId: watchB.id }, "athlete-a", "get_activity_details");
  assert.equal(strength.activity, null);
  const running = await execute(store, question, { labelId: run.labelId }, "athlete-a", "get_activity_details");
  assert.equal(running.activity.durationS, 1800);
  assert.deepEqual(detailReads, [run.labelId]);
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

test("a relative date used as a range endpoint does not narrow the review to one day", async () => {
  const result = await execute(fixture([manualRecord]).store, "复盘截至昨天的本周力量训练", {
    startDay: "2026-11-23",
    endDay: "2026-11-25",
  });
  assert.equal(result.status, "found");
  assert.deepEqual(result.scope, { startDay: "2026-11-23", endDay: "2026-11-25" });
});

test("a watch detail cannot bypass the manual policy during a multi-day strength review", async () => {
  const base = fixture([]).store;
  const detail = await execute(base, "复盘 11 月 25 日到 26 日的力量训练", { labelId: watchB.id }, "athlete-a", "get_activity_details");
  assert.equal(detail.activity, null);
  assert.equal(detail.reviewTool, "get_strength_training_review");
});

test("parallel tool calls cannot expose broad-scope watch data before manual selection finishes", async () => {
  const yesterday = "2026-11-25";
  const { store, detailReads } = fixture([manualRecord]);
  const adapter: DataProvider = {
    ...store,
    getManualStrengthSummaries: async (_, start, end) => (start === yesterday && end === day ? [manualRecord] : []),
  };
  const tools: StructuredTool[] = getQaTools(adapter);
  const node = new ToolNode(tools, { handleToolErrors: false });
  const config = { tags: [], context: { userId: "athlete-a", asof: day } };
  const output = await node.invoke(
    {
      messages: [
        new HumanMessage("从昨天到今天的力量训练做了哪些组？平均心率呢？"),
        new AIMessage({
          content: "",
          tool_calls: [
            { name: "get_strength_training_review", args: { startDay: yesterday, endDay: day }, id: "manual" },
            { name: "get_activity_details", args: { labelId: watchB.id }, id: "watch" },
          ],
        }),
      ],
    },
    config,
  );
  assert.equal(JSON.parse(output.messages[0].content).source, "manual");
  assert.equal(JSON.parse(output.messages[1].content).activity, null);
  assert.deepEqual(detailReads, [manualRecord.id]);
});
