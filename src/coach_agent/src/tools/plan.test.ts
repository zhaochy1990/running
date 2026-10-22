import assert from "node:assert/strict";
import test from "node:test";
import { createPlanTools, type PlanStore } from "./plan.js";

const userId = "athlete-1";

class FakePlanStore implements PlanStore {
  calls: Array<{
    method: string;
    userId: string;
    weekName?: string;
    day?: string;
  }> = [];

  async getMasterPlan(requestUserId: string, day: string) {
    this.calls.push({ method: "master", userId: requestUserId, day });
    return requestUserId === userId ? { plan_id: "master-1", status: "active" } : null;
  }

  async getWeeklyPlan(requestUserId: string, weekName: string) {
    this.calls.push({ method: "weekly", userId: requestUserId, weekName });
    return requestUserId === userId && weekName === "2026-07-20_07-26" ? { week_name: weekName, sessions: [] } : null;
  }

  daySessions: Array<{
    workout_id: string;
    date: string;
    source: "weekly" | "custom" | "watch";
    kind: string;
    name: string;
    summary: string | null;
    spec_json: string | null;
    save_token: string | null;
    pushed: boolean;
  }> = [];

  async getPlanSessions(requestUserId: string, dateFrom: string, dateTo: string) {
    this.calls.push({ method: "sessions", userId: requestUserId, day: dateFrom });
    if (requestUserId !== userId) return [];
    return this.daySessions.filter((r) => r.date >= dateFrom && r.date <= dateTo);
  }
}

// 2026-07-20 is a Monday; 2026-07-23 falls in the same week.
const currentMonday = "2026-07-20";
const midWeekDay = "2026-07-23";

test("plan tools query the data provider with the runtime user identity", async () => {
  const store = new FakePlanStore();
  const [masterTool, weeklyTool] = createPlanTools(store as never);
  const config = { context: { userId, asof: "2026-07-20" } };

  assert.equal(masterTool!.name, "get_master_plan");
  assert.equal(weeklyTool!.name, "get_weekly_plan");
  assert.deepEqual(await masterTool!.invoke({}, config), {
    plan_id: "master-1",
    status: "active",
  });
  assert.deepEqual(await weeklyTool!.invoke({ weekStart: currentMonday }, config), { week_name: "2026-07-20_07-26", sessions: [] });
  assert.deepEqual(store.calls, [
    { method: "master", userId, day: "2026-07-20" },
    { method: "weekly", userId, weekName: "2026-07-20_07-26" },
  ]);
});

test("get_weekly_plan normalizes any day in the week to its Monday folder", async () => {
  const store = new FakePlanStore();
  const [, weeklyTool] = createPlanTools(store as never);
  const config = { context: { userId, asof: currentMonday } };

  // Same plan as querying the Monday directly — the folder identity is what MySQL keys on.
  assert.deepEqual(await weeklyTool!.invoke({ weekStart: midWeekDay }, config), { week_name: "2026-07-20_07-26", sessions: [] });
  assert.deepEqual(store.calls, [{ method: "weekly", userId, weekName: "2026-07-20_07-26" }]);

  // A week with no plan is null, not an error.
  assert.equal(await weeklyTool!.invoke({ weekStart: "2026-07-13" }, config), null);
});

test("get_weekly_plan rejects a non-ISO week start", async () => {
  const [, weeklyTool] = createPlanTools(new FakePlanStore() as never);
  const config = { context: { userId, asof: currentMonday } };
  await assert.rejects(() => weeklyTool!.invoke({ weekStart: "20260720" }, config));
});

test("plan tools reject calls without a runtime user identity", async () => {
  const [masterTool] = createPlanTools(new FakePlanStore() as never);
  await assert.rejects(() => masterTool!.invoke({}, {}), /missing userId/);
  await assert.rejects(() => masterTool!.invoke({}, { context: { userId } }), /missing asof/);
});

test("get_day_plan_sessions defaults to today and summarizes saved sessions", async () => {
  const store = new FakePlanStore();
  const tools = createPlanTools(store as never);
  const sessionTool = tools.find((t) => t.name === "get_day_plan_sessions");
  assert.ok(sessionTool, "get_day_plan_sessions must be registered");
  const config = { context: { userId, asof: "2026-10-20" } };

  store.daySessions = [
    {
      workout_id: "w1",
      date: "2026-10-20",
      source: "custom",
      kind: "run",
      name: "5k+4k+3k+1k 递减",
      summary: "递减配速长课",
      spec_json: JSON.stringify({
        schema: "run-workout/v1",
        name: "5k+4k+3k+1k 递减",
        date: "2026-10-20",
        note: null,
        blocks: [
          {
            repeat: 1,
            steps: [
              {
                step_kind: "work",
                duration: { kind: "distance_m", value: 5000 },
                target: { kind: "pace_s_km", low: 245, high: 240 },
                note: null,
                hr_cap_bpm: null,
                rest: { kind: "time_s", value: 240 },
              },
            ],
          },
        ],
      }),
      save_token: "token-1",
      pushed: true,
    },
  ];

  const out = (await sessionTool.invoke({}, config)) as {
    count: number;
    sessions: Array<Record<string, unknown>>;
  };
  assert.equal(out.count, 1);
  const session = out.sessions[0]!;
  assert.ok(session);
  assert.equal(session.source, "custom（用户自建课）");
  assert.equal(session.pushed, "已推送到手表");
  // run spec deterministically rendered into the one-line summary.
  assert.match(String(session.workout_line), /5km @ 4:00.4:05\/km（休4′）/);
  assert.deepEqual(store.calls.at(-1), { method: "sessions", userId, day: "2026-10-20" });
});

test("get_day_plan_sessions empty window tells the model to trust the result", async () => {
  const store = new FakePlanStore();
  const tools = createPlanTools(store as never);
  const sessionTool = tools.find((t) => t.name === "get_day_plan_sessions");
  const config = { context: { userId, asof: "2026-10-20" } };

  const out = (await sessionTool!.invoke({ date: "2026-10-20", end_date: "2026-10-21" }, config)) as {
    count: number;
    hint?: string;
  };
  assert.equal(out.count, 0);
  assert.match(out.hint ?? "", /以本结果为准/);
});
