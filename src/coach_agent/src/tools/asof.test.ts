import assert from "node:assert/strict";
import test from "node:test";
import type { DataProvider } from "../data/dataProvider.js";
import { createActivitiesTools } from "./activities.js";
import { createRaceTools } from "./races.js";
import { createTrainingLoadTools } from "./trainingLoad.js";

test("date-range tools default their inclusive end to context.asof", async () => {
  const activityCalls: string[][] = [];
  const loadCalls: string[][] = [];
  const store = {
    async getActivitySummariesByDateRange(...args: string[]) {
      activityCalls.push(args);
      return [];
    },
    async getDailyTrainingLoadByDateRange(...args: string[]) {
      loadCalls.push(args);
      return [];
    },
  } as unknown as DataProvider;
  const [activities] = createActivitiesTools(store);
  const [loads] = createTrainingLoadTools(store);
  assert.ok(activities);
  assert.ok(loads);
  const config = { context: { userId: "athlete", asof: "2026-05-15" } };

  await activities.invoke({ startDay: "2026-05-01" }, config);
  await loads.invoke({ startDay: "2026-05-01" }, config);

  assert.deepEqual(activityCalls, [["athlete", "2026-05-01", "2026-05-15"]]);
  assert.deepEqual(loadCalls, [["athlete", "2026-05-01", "2026-05-15"]]);
});

test("date-range tools cap results and flag truncation", async () => {
  // 3 activities, dates ascending; summaries carry no laps (that is the provider's contract).
  const activities = [
    { labelId: "a", date: new Date("2026-05-01T01:00:00Z"), distanceM: 1 },
    { labelId: "b", date: new Date("2026-05-02T01:00:00Z"), distanceM: 2 },
    { labelId: "c", date: new Date("2026-05-03T01:00:00Z"), distanceM: 3 },
  ] as never[];
  const store = {
    async getActivitySummariesByDateRange() {
      return activities;
    },
  } as unknown as DataProvider;
  const [tool] = createActivitiesTools(store);
  assert.ok(tool);
  const config = { context: { userId: "athlete", asof: "2026-05-15" } };
  type Result = { activities: Array<{ labelId: string }>; truncated: boolean };

  // default: no truncation (only 3 activities)
  const defaultResult = (await tool.invoke({ startDay: "2026-05-01" }, config)) as Result;
  assert.equal(defaultResult.truncated, false);
  assert.equal(defaultResult.activities.length, 3);

  // limit=2 keeps the two newest (b, c) and flags truncation
  const limitedResult = (await tool.invoke({ startDay: "2026-05-01", limit: 2 }, config)) as Result;
  assert.equal(limitedResult.truncated, true);
  assert.deepEqual(
    limitedResult.activities.map((a) => a.labelId),
    ["b", "c"],
  );
});

test("get_activity_details returns one activity with its laps", async () => {
  const detail = {
    labelId: "b",
    date: new Date("2026-05-02T01:00:00Z"),
    laps: [{ lapIndex: 1 }, { lapIndex: 2 }],
  } as never;
  const store = {
    async getActivityDetail() {
      return detail;
    },
  } as unknown as DataProvider;
  const tools = createActivitiesTools(store);
  const detailTool = tools[1];
  assert.ok(detailTool);

  const result = (await detailTool.invoke({ labelId: "b" }, { context: { userId: "athlete" } })) as {
    activity: { labelId: string; laps: unknown[] };
  };
  assert.equal(result.activity.labelId, "b");
  assert.deepEqual(result.activity.laps, [{ lapIndex: 1 }, { lapIndex: 2 }]);
});

test("get_activity_details returns null when the activity does not exist", async () => {
  const store = {
    async getActivityDetail() {
      return null;
    },
  } as unknown as DataProvider;
  const tools = createActivitiesTools(store);
  const detailTool = tools[1];
  assert.ok(detailTool);

  const result = (await detailTool.invoke({ labelId: "missing" }, { context: { userId: "athlete" } })) as {
    activity: unknown;
  };
  assert.equal(result.activity, null);
});

test("date-range tools require asof even when an explicit end is supplied", async () => {
  const store = {
    async getActivitiesByDateRange() {
      return [];
    },
  } as unknown as DataProvider;
  const [activities] = createActivitiesTools(store);
  assert.ok(activities);

  await assert.rejects(() => activities.invoke({ startDay: "2026-05-01", endDay: "2026-05-02" }, { context: { userId: "athlete" } }), /missing asof/);
});

test("race-history tools bound results to context.asof", async () => {
  const raceCalls: unknown[][] = [];
  const pbCalls: unknown[][] = [];
  const store = {
    async getRaceHistory(...args: unknown[]) {
      raceCalls.push(args);
      return [];
    },
    async getPersonalBests(...args: unknown[]) {
      pbCalls.push(args);
      return [];
    },
  } as unknown as DataProvider;
  const [raceHistory, personalBests] = createRaceTools(store);
  assert.ok(raceHistory);
  assert.ok(personalBests);
  const config = { context: { userId: "athlete", asof: "2026-06-10" } };

  await raceHistory.invoke({ minDistanceKm: 10, limit: 3 }, config);
  await personalBests.invoke({}, config);

  assert.deepEqual(raceCalls, [["athlete", { asOfDate: "2026-06-10", minDistanceKm: 10, limit: 3 }]]);
  assert.deepEqual(pbCalls, [["athlete", "2026-06-10"]]);
});

test("race-history tools require context.asof", async () => {
  const store = {
    async getRaceHistory() {
      return [];
    },
    async getPersonalBests() {
      return [];
    },
  } as unknown as DataProvider;
  const [raceHistory, personalBests] = createRaceTools(store);
  assert.ok(raceHistory);
  assert.ok(personalBests);

  await assert.rejects(() => raceHistory.invoke({}, { context: { userId: "athlete" } }), /missing asof/);
  await assert.rejects(() => personalBests.invoke({}, { context: { userId: "athlete" } }), /missing asof/);
});

test("daily training-load tools cap results and flag truncation", async () => {
  // 40 days, ascending; summaries carry no other fields needed by the tool.
  const days = Array.from({ length: 40 }, (_, i) => ({ date: `d${i}`, trainingDose: 1 })) as never[];
  const store = {
    async getDailyTrainingLoadByDateRange() {
      return days;
    },
  } as unknown as DataProvider;
  const [tool] = createTrainingLoadTools(store);
  assert.ok(tool);
  const config = { context: { userId: "athlete", asof: "2026-06-30" } };
  type Result = { stride_training_load: Array<{ date: string }>; truncated: boolean };

  // default limit 30: keeps the newest 30 (d10..d39), flags truncation
  const defaultResult = (await tool.invoke({ startDay: "2026-05-01" }, config)) as Result;
  assert.equal(defaultResult.truncated, true);
  assert.equal(defaultResult.stride_training_load.length, 30);
  assert.equal(defaultResult.stride_training_load[0]?.date, "d10");
  assert.equal(defaultResult.stride_training_load[29]?.date, "d39");

  // limit=2 keeps the two newest (d38, d39) and still flags truncation
  const limitedResult = (await tool.invoke({ startDay: "2026-05-01", limit: 2 }, config)) as Result;
  assert.equal(limitedResult.truncated, true);
  assert.deepEqual(
    limitedResult.stride_training_load.map((d) => d.date),
    ["d38", "d39"],
  );
});
