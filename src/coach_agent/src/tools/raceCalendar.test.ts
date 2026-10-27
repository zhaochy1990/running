import assert from "node:assert/strict";
import test from "node:test";
import type { RaceCalendarSearchQuery, RaceCalendarSummary } from "../data/dataProvider.js";
import { createRaceCalendarSearchTools } from "./raceCalendar.js";

function summaryFixture(): RaceCalendarSummary {
  return {
    race_event_id: 30,
    name: "Hangzhou Marathon",
    name_cn: "杭州马拉松",
    race_date: "2026-11-01",
    province: "浙江省",
    city: "杭州市",
    items: [
      { item_type: "Marathon", distance_km: 42.195 },
      { item_type: "HalfMarathon", distance_km: 21.0975 },
    ],
  };
}

function fakeStore(calls: RaceCalendarSearchQuery[]) {
  return {
    async searchRaceCalendar(query: RaceCalendarSearchQuery) {
      calls.push(query);
      return [summaryFixture()];
    },
    async getRaceCalendarContext() {
      throw new Error("detail fixture is per-test");
    },
  };
}

test("search_race_calendar passes explicit filters through with asofDate from the runtime context", async () => {
  const calls: RaceCalendarSearchQuery[] = [];
  const tools = createRaceCalendarSearchTools(fakeStore(calls));
  const tool = tools.find((candidate) => candidate.name === "search_race_calendar");
  assert.ok(tool);

  const result = await tool.invoke(
    { keyword: "杭州", city: "杭州市", dateFrom: "2026-11-01", dateTo: "2026-12-31", itemType: "Marathon", limit: 5 },
    { context: { userId: "athlete-1", asof: "2026-10-27" } },
  );
  assert.deepEqual(calls, [
    {
      asofDate: "2026-10-27",
      keyword: "杭州",
      city: "杭州市",
      dateFrom: "2026-11-01",
      dateTo: "2026-12-31",
      itemType: "Marathon",
      limit: 5,
    },
  ]);
  assert.equal((result as RaceCalendarSummary[])[0]?.race_event_id, 30);
});

test("search_race_calendar needs no filters — the default window belongs to the provider", async () => {
  const calls: RaceCalendarSearchQuery[] = [];
  const tools = createRaceCalendarSearchTools(fakeStore(calls));
  const tool = tools.find((candidate) => candidate.name === "search_race_calendar");
  assert.ok(tool);

  await tool.invoke({}, { context: { userId: "athlete-1", asof: "2026-10-27" } });
  assert.deepEqual(calls, [{ asofDate: "2026-10-27" }]);
});

test("search_race_calendar refuses a turn without asof", async () => {
  const calls: RaceCalendarSearchQuery[] = [];
  const tools = createRaceCalendarSearchTools(fakeStore(calls));
  const tool = tools.find((candidate) => candidate.name === "search_race_calendar");
  assert.ok(tool);
  await assert.rejects(() => tool.invoke({ keyword: "杭州" }, { context: { userId: "athlete-1" } }), /missing asof/);
  assert.equal(calls.length, 0);
});

test("get_race_calendar_detail resolves the id argument, not the turn scope", async () => {
  const tools = createRaceCalendarSearchTools({
    async searchRaceCalendar() {
      return [];
    },
    async getRaceCalendarContext(raceEventId) {
      assert.equal(raceEventId, 30);
      return {
        race_event_id: raceEventId,
        name: "Hangzhou Marathon",
        name_cn: "杭州马拉松",
        race_date: "2026-11-01",
        province: "浙江省",
        city: "杭州市",
        climate: null,
        content_source: "WebSearch",
        items: [],
        city_content: null,
      };
    },
  });
  const tool = tools.find((candidate) => candidate.name === "get_race_calendar_detail");
  assert.ok(tool);
  // 无 race target 的普通 QA 会话（target 缺失）也能按参数查详情。
  const result = await tool.invoke({ race_event_id: 30 }, { context: { userId: "athlete-1", asof: "2026-10-27" } });
  assert.equal((result as { found: boolean }).found, true);
  assert.equal((result as { name: string }).name, "Hangzhou Marathon");
});

test("get_race_calendar_detail reports found=false for an unknown or unpublished race", async () => {
  const tools = createRaceCalendarSearchTools({
    async searchRaceCalendar() {
      return [];
    },
    async getRaceCalendarContext() {
      return null;
    },
  });
  const tool = tools.find((candidate) => candidate.name === "get_race_calendar_detail");
  assert.ok(tool);
  const result = await tool.invoke({ race_event_id: 999 }, { context: { userId: "athlete-1", asof: "2026-10-27" } });
  assert.deepEqual(result, { race_event_id: 999, found: false, reason: "race not found or unpublished" });
});
