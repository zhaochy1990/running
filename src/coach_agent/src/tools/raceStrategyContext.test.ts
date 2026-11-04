import assert from "node:assert/strict";
import test from "node:test";
import type { RaceCalendarContext } from "../data/dataProvider.js";
import { createRaceStrategyContextTools, type RaceTargetBindingGateway } from "./raceStrategyContext.js";

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
    async searchRaceCalendar() {
      return [];
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
    async searchRaceCalendar() {
      return [];
    },
  });
  const tool = tools.find((candidate) => candidate.name === "get_race_calendar_context");
  assert.ok(tool);
  const result = await tool.invoke({}, { context: { userId: "athlete-1", asof: "2026-10-01", target: { kind: "race", race_event_id: 999 } } });
  assert.deepEqual(result, { race_event_id: 999, found: false, reason: "race not found or unpublished" });
});

test("get_race_calendar_context reports bound=false on the chat entry (no race target, #891)", async () => {
  const tools = createRaceStrategyContextTools({
    async getRaceCalendarContext() {
      throw new Error("provider must not be called");
    },
    async searchRaceCalendar() {
      throw new Error("search must not be called");
    },
  });
  const tool = tools.find((candidate) => candidate.name === "get_race_calendar_context");
  assert.ok(tool);
  assert.deepEqual(await tool.invoke({}, { context: { userId: "athlete-1", asof: "2026-10-01" } }), { bound: false });
  assert.deepEqual(
    await tool.invoke({}, { context: { userId: "athlete-1", asof: "2026-10-01", target: { kind: "session", date: "2026-10-01", session_index: 0 } } }),
    { bound: false },
  );
});

test("search_race_targets flattens calendar rows into candidates and remembers them (#891)", async () => {
  const remembered: string[] = [];
  const searched: unknown[] = [];
  const gateway: RaceTargetBindingGateway = {
    async get() {
      return null;
    },
    async bind() {
      throw new Error("bind must not be called");
    },
    async rememberCandidates(threadId, candidates) {
      remembered.push(threadId, String(candidates.length));
    },
    async candidates() {
      return null;
    },
  };
  const tools = createRaceStrategyContextTools(
    {
      async getRaceCalendarContext() {
        throw new Error("context must not be called");
      },
      async searchRaceCalendar(options) {
        searched.push(options);
        return [
          {
            race_event_id: 61,
            name: "Nantong Marathon",
            name_cn: "南通马拉松",
            race_date: "2026-11-08",
            province: "江苏省",
            city: "南通市",
            items: [
              { item_type: "HalfMarathon", distance_km: 21.0975 },
              { item_type: "Marathon", distance_km: 42.195 },
            ],
          },
        ];
      },
    },
    gateway,
  );
  const tool = tools.find((candidate) => candidate.name === "search_race_targets");
  assert.ok(tool);
  const result = (await tool.invoke(
    { keyword: "南通", date: "2026-11-08" },
    { context: { userId: "athlete-1", asof: "2026-11-03", threadId: "u:coach:s1" } },
  )) as { candidates: Array<{ race_event_id: number; item_type: string; name: string }> };
  assert.deepEqual(searched, [{ asofDate: "2026-11-03", keyword: "南通", dateFrom: "2026-11-08", dateTo: "2026-12-08", limit: 8 }]);
  assert.deepEqual(
    result.candidates.map((candidate) => [candidate.race_event_id, candidate.item_type]),
    [
      [61, "HalfMarathon"],
      [61, "Marathon"],
    ],
  );
  assert.deepEqual(remembered, ["u:coach:s1", "2"]);
});

test("bind_race_target binds an in-candidate pair and persists it (#891)", async () => {
  const bound: Array<{ threadId: string; ref: { race_event_id: number; item_type: string } }> = [];
  const candidatesFixture = [{ race_event_id: 61, item_type: "HalfMarathon", name: "南通马拉松", race_date: "2026-11-08", city: "南通市" }];
  const gateway: RaceTargetBindingGateway = {
    async get() {
      return null;
    },
    async bind(threadId, ref) {
      bound.push({ threadId, ref });
    },
    async rememberCandidates() {},
    async candidates() {
      return candidatesFixture;
    },
  };
  const tools = createRaceStrategyContextTools(
    {
      async getRaceCalendarContext() {
        return null;
      },
      async searchRaceCalendar() {
        return [];
      },
    },
    gateway,
  );
  const tool = tools.find((candidate) => candidate.name === "bind_race_target");
  assert.ok(tool);
  const result = await tool.invoke(
    { race_event_id: 61, item_type: "HalfMarathon" },
    { context: { userId: "athlete-1", asof: "2026-11-03", threadId: "u:coach:s1" } },
  );
  assert.deepEqual(result, { bound: true, race_event_id: 61, item_type: "HalfMarathon" });
  assert.deepEqual(bound, [{ threadId: "u:coach:s1", ref: { kind: "race", race_event_id: 61, item_type: "HalfMarathon" } }]);
});

test("bind_race_target rejects pairs outside the remembered candidate set (#891 anti-injection)", async () => {
  const gateway: RaceTargetBindingGateway = {
    async get() {
      return null;
    },
    async bind() {
      throw new Error("bind must not be called");
    },
    async rememberCandidates() {},
    async candidates() {
      return [{ race_event_id: 61, item_type: "HalfMarathon", name: "南通马拉松", race_date: "2026-11-08", city: null }];
    },
  };
  const tools = createRaceStrategyContextTools(
    {
      async getRaceCalendarContext() {
        return null;
      },
      async searchRaceCalendar() {
        return [];
      },
    },
    gateway,
  );
  const tool = tools.find((candidate) => candidate.name === "bind_race_target");
  assert.ok(tool);
  await assert.rejects(
    () => tool.invoke({ race_event_id: 62, item_type: "HalfMarathon" }, { context: { userId: "athlete-1", asof: "2026-11-03", threadId: "u:coach:s1" } }),
    /候选集/,
  );
  await assert.rejects(
    () => tool.invoke({ race_event_id: 61, item_type: "Marathon" }, { context: { userId: "athlete-1", asof: "2026-11-03", threadId: "u:coach:s1" } }),
    /候选集/,
  );
});

test("bind_race_target is not offered without a gateway; missing thread context refuses (#891)", async () => {
  const withoutGateway = createRaceStrategyContextTools({
    async getRaceCalendarContext() {
      return null;
    },
    async searchRaceCalendar() {
      return [];
    },
  });
  assert.equal(
    withoutGateway.some((candidate) => candidate.name === "bind_race_target"),
    false,
  );

  const withGateway = createRaceStrategyContextTools(
    {
      async getRaceCalendarContext() {
        return null;
      },
      async searchRaceCalendar() {
        return [];
      },
    },
    {
      async get() {
        return null;
      },
      async bind() {},
      async rememberCandidates() {},
      async candidates() {
        return null;
      },
    },
  );
  const tool = withGateway.find((candidate) => candidate.name === "bind_race_target");
  assert.ok(tool);
  await assert.rejects(
    () => tool.invoke({ race_event_id: 61, item_type: "HalfMarathon" }, { context: { userId: "athlete-1", asof: "2026-11-03" } }),
    /missing thread context/,
  );
});

test("get_race_calendar_context falls back to the thread binding after in-turn bind (#891)", async () => {
  const fixture = raceContextFixture();
  const boundRef = { kind: "race" as const, race_event_id: 61, item_type: "HalfMarathon" };
  const calls: number[] = [];
  const tools = createRaceStrategyContextTools(
    {
      async getRaceCalendarContext(raceEventId) {
        calls.push(raceEventId);
        return { ...fixture, race_event_id: raceEventId };
      },
      async searchRaceCalendar() {
        return [];
      },
    },
    {
      async get(threadId) {
        // bind 已写库（bind 是 await 后才返回），同一轮内 get 立即可见。
        return threadId === "u:coach:s1" ? boundRef : null;
      },
      async bind() {},
      async rememberCandidates() {},
      async candidates() {
        return null;
      },
    },
  );
  const tool = tools.find((candidate) => candidate.name === "get_race_calendar_context");
  assert.ok(tool);
  const result = (await tool.invoke({}, { context: { userId: "athlete-1", asof: "2026-11-03", threadId: "u:coach:s1" } })) as {
    found: boolean;
    race_event_id: number;
  };
  assert.deepEqual(calls, [61]);
  assert.equal(result.found, true);
  assert.equal(result.race_event_id, 61);
});

test("the strategy toolset no longer exposes performance data (target is the athlete's own decision)", () => {
  const tools = createRaceStrategyContextTools({
    async getRaceCalendarContext() {
      return null;
    },
    async searchRaceCalendar() {
      return [];
    },
  });
  assert.equal(
    tools.some((candidate) => candidate.name === "get_performance_baseline"),
    false,
  );
});
