import assert from "node:assert/strict";
import test from "node:test";
import type { RaceCalendarContext, RaceTarget } from "../data/dataProvider.js";
import { ASK_USER_FOR_GOAL_TOOL, createAskUserForGoalTool, createRaceStrategyContextTools } from "./raceStrategyContext.js";

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

const goalRaceContext = raceContextFixture();

function raceGoalFixture(): RaceTarget {
  return {
    goal_id: "g1",
    user_id: "athlete-1",
    status: "active",
    race_date: "2026-11-01",
    race_distance: "FM",
    race_name: "杭州马拉松",
    target_finish_time: "2:50:00",
    weekly_training_days: 5,
  };
}

const goalToolRuntime = { context: { userId: "athlete-1", asof: "2026-10-01", target: { kind: "race", race_event_id: 30, item_type: "Marathon" } } };

test("ask_user_for_goal returns the confirm question when the stored goal matches this race", async () => {
  const calls: { users: string[]; races: number[]; plans: Array<[string, string]> } = { users: [], races: [], plans: [] };
  const tool = createAskUserForGoalTool({
    async getRaceTarget(userId) {
      calls.users.push(userId);
      return raceGoalFixture();
    },
    async getRaceCalendarContext(raceEventId) {
      calls.races.push(raceEventId);
      return goalRaceContext;
    },
    async getMasterPlan(userId, day) {
      calls.plans.push([userId, day]);
      return null;
    },
  });
  assert.equal(tool.name, ASK_USER_FOR_GOAL_TOOL);
  const result = await tool.invoke({}, goalToolRuntime);
  assert.deepEqual(calls, { users: ["athlete-1"], races: [30], plans: [["athlete-1", "2026-10-01"]] });
  assert.equal((result as { question: string }).question, "我查到你之前的比赛目标是 2:50:00，需要我按照这个目标帮你制定比赛策略吗？");
});

test("ask_user_for_goal returns the direct question when no stored goal matches", async () => {
  const tool = createAskUserForGoalTool({
    async getRaceTarget() {
      return null;
    },
    async getRaceCalendarContext() {
      return goalRaceContext;
    },
    async getMasterPlan() {
      return null;
    },
  });
  const result = await tool.invoke({}, goalToolRuntime);
  assert.equal((result as { question: string }).question, "你这场比赛的目标成绩是多少？");
});

test("ask_user_for_goal asks which goal to use when the master-plan goal also matches and differs", async () => {
  const tool = createAskUserForGoalTool({
    async getRaceTarget() {
      return raceGoalFixture();
    },
    async getRaceCalendarContext() {
      return goalRaceContext;
    },
    async getMasterPlan() {
      // 计划围绕同一场（2026-11-01 FM）但目标不同：改过 race_goal 未重生成计划的常见漂移。
      return { goal: { race_name: "杭州马拉松", distance: "FM", race_date: "2026-11-01", target_time: "2:55:00" } };
    },
  });
  const result = await tool.invoke({}, goalToolRuntime);
  assert.equal((result as { question: string }).question, "我查到你的比赛目标是 2:50:00，赛季训练计划的目标是 2:55:00，要按哪个目标帮你制定这场比赛的策略？");
});

test("a master-plan lookup failure never downgrades the race-goal candidate", async () => {
  const tool = createAskUserForGoalTool({
    async getRaceTarget() {
      return raceGoalFixture();
    },
    async getRaceCalendarContext() {
      return goalRaceContext;
    },
    async getMasterPlan() {
      throw new Error("db down");
    },
  });
  const result = await tool.invoke({}, goalToolRuntime);
  assert.equal((result as { question: string }).question, "我查到你之前的比赛目标是 2:50:00，需要我按照这个目标帮你制定比赛策略吗？");
});

test("ask_user_for_goal never throws — lookup failure or missing race target both fall back to the direct question", async () => {
  const failing = createAskUserForGoalTool({
    async getRaceTarget() {
      throw new Error("db down");
    },
    async getRaceCalendarContext() {
      return goalRaceContext;
    },
    async getMasterPlan() {
      return null;
    },
  });
  const failingResult = await failing.invoke({}, goalToolRuntime);
  assert.equal((failingResult as { question: string }).question, "你这场比赛的目标成绩是多少？");

  const untouched = createAskUserForGoalTool({
    async getRaceTarget() {
      throw new Error("provider must not be called");
    },
    async getRaceCalendarContext() {
      throw new Error("provider must not be called");
    },
    async getMasterPlan() {
      throw new Error("provider must not be called");
    },
  });
  const noTarget = await untouched.invoke({}, { context: { userId: "athlete-1", asof: "2026-10-01" } });
  assert.equal((noTarget as { question: string }).question, "你这场比赛的目标成绩是多少？");
});
