import assert from "node:assert/strict";
import test from "node:test";
import type { PerformanceBaseline, RaceCalendarContext } from "../data/dataProvider.js";
import { createRaceStrategyContextTools } from "./raceStrategyContext.js";

function raceContextFixture(): RaceCalendarContext {
  return {
    race_event_id: 30,
    name: "Hangzhou Marathon",
    name_cn: "杭州马拉松",
    race_date: "2026-11-01",
    province: "浙江省",
    city: "杭州市",
    climate: null,
    content_source: "WebSearch",
    items: [
      {
        item_type: "Marathon",
        name: "全程马拉松",
        distance_km: 42.195,
        start_point: "黄龙体育中心",
        finish_point: "奥体中心",
        route_description: "黄龙出发，经西湖……",
        total_ascent_m: 180,
        elevation_points: [],
        course_challenges: [{ distance_km: 32, description: "钱塘江大桥爬坡" }],
        aid_stations: [{ distance_km: 5, supplies: ["水", "能量胶"] }],
        cutoffs: [{ point: "35K", distance_km: 35, cutoff_at: "12:30" }],
        content_source: "WebSearch",
      },
    ],
    city_content: { city: "杭州市", overview: "……", food: "西湖醋鱼" },
  };
}

test("get_race_calendar_context resolves the race from the turn-scope target", async () => {
  const calls: number[] = [];
  const fixture = raceContextFixture();
  const tools = createRaceStrategyContextTools({
    async getRaceCalendarContext(raceEventId) {
      calls.push(raceEventId);
      return fixture;
    },
    async getPerformanceBaseline() {
      throw new Error("not called in this test");
    },
  });
  const tool = tools.find((candidate) => candidate.name === "get_race_calendar_context");
  assert.ok(tool);

  const result = await tool.invoke(
    {},
    { context: { userId: "athlete-1", asof: "2026-10-01", target: { kind: "race", race_event_id: 30, item_type: "Marathon" } } },
  );
  assert.deepEqual(calls, [30]);
  assert.equal((result as { found: boolean }).found, true);
  assert.equal((result as { name: string }).name, "Hangzhou Marathon");
  assert.equal((result as { content_source: string | null }).content_source, "WebSearch");
});

test("get_race_calendar_context reports found=false for an unknown race", async () => {
  const tools = createRaceStrategyContextTools({
    async getRaceCalendarContext() {
      return null;
    },
    async getPerformanceBaseline() {
      throw new Error("not called in this test");
    },
  });
  const tool = tools.find((candidate) => candidate.name === "get_race_calendar_context");
  assert.ok(tool);
  const result = await tool.invoke({}, { context: { userId: "athlete-1", asof: "2026-10-01", target: { kind: "race", race_event_id: 999 } } });
  assert.deepEqual(result, { race_event_id: 999, found: false, reason: "race not found or unpublished" });
});

test("get_race_calendar_context refuses a turn without a race target", async () => {
  const tools = createRaceStrategyContextTools({
    async getRaceCalendarContext() {
      throw new Error("provider must not be called");
    },
    async getPerformanceBaseline() {
      throw new Error("not called in this test");
    },
  });
  const tool = tools.find((candidate) => candidate.name === "get_race_calendar_context");
  assert.ok(tool);
  await assert.rejects(() => tool.invoke({}, { context: { userId: "athlete-1", asof: "2026-10-01" } }), /no race target/);
  await assert.rejects(
    () => tool.invoke({}, { context: { userId: "athlete-1", asof: "2026-10-01", target: { kind: "session", date: "2026-10-01", session_index: 0 } } }),
    /no race target/,
  );
});

test("get_performance_baseline loads the runtime user's bounded aggregation", async () => {
  const calls: Array<[string, string]> = [];
  const baseline: PerformanceBaseline = {
    as_of_date: "2026-10-01",
    race_predictions: [{ race_type: "FM", duration_s: 10800, avg_pace_s_km: 256 }],
    ability_l4: { as_of_date: "2026-09-30", composite: 62, marathon_training_s: 11000, marathon_race_s: 10700, hm_race_s: 5200 },
    running_calibration: null,
  };
  const tools = createRaceStrategyContextTools({
    async getRaceCalendarContext() {
      throw new Error("not called in this test");
    },
    async getPerformanceBaseline(userId, asOfDate) {
      calls.push([userId, asOfDate]);
      return baseline;
    },
  });
  const tool = tools.find((candidate) => candidate.name === "get_performance_baseline");
  assert.ok(tool);
  assert.equal(await tool.invoke({}, { context: { userId: "athlete-1", asof: "2026-10-01" } }), baseline);
  assert.deepEqual(calls, [["athlete-1", "2026-10-01"]]);
  await assert.rejects(() => tool.invoke({}, {}), /missing userId/);
  await assert.rejects(() => tool.invoke({}, { context: { userId: "athlete-1" } }), /missing asof/);
});
