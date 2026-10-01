import assert from "node:assert/strict";
import test from "node:test";
import type { RaceCalendarContext } from "../data/dataProvider.js";
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
  });
  const tool = tools.find((candidate) => candidate.name === "get_race_calendar_context");
  assert.ok(tool);
  await assert.rejects(() => tool.invoke({}, { context: { userId: "athlete-1", asof: "2026-10-01" } }), /no race target/);
  await assert.rejects(
    () => tool.invoke({}, { context: { userId: "athlete-1", asof: "2026-10-01", target: { kind: "session", date: "2026-10-01", session_index: 0 } } }),
    /no race target/,
  );
});

test("the strategy toolset no longer exposes performance data (target is the athlete's own decision)", () => {
  const tools = createRaceStrategyContextTools({
    async getRaceCalendarContext() {
      return null;
    },
  });
  assert.equal(
    tools.some((candidate) => candidate.name === "get_performance_baseline"),
    false,
  );
});
