import assert from "node:assert/strict";
import test from "node:test";
import type { MasterPlan } from "@stride/contract";
import type { DataProvider } from "@stride/coach-agent";
import { createMasterPlanDraftSink } from "../src/coach/masterPlanDraftSink.js";

const USER_ID = "11111111-2222-3333-4444-555555555555";
const GOAL_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** 最小可用 plan：落库变换只读 phases/weeks/goal 的既有字段。 */
function minimalPlan(): MasterPlan {
  return {
    goal: { race_name: "无锡马拉松", distance: "FM", race_date: "2027-03-21", target_time: "3:30:00", goal_type: "A", priority: "A" },
    start_date: "2026-10-05",
    end_date: "2027-03-21",
    total_weeks: 1,
    training_principles: ["一致性优先"],
    generated_by: "coach_agent",
    phases: [
      {
        name: "base",
        focus: "有氧基础",
        start_date: "2026-10-05",
        end_date: "2026-10-11",
        weekly_distance_km_low: 30,
        weekly_distance_km_high: 40,
        key_session_types: ["long_run"],
        milestones: [{ type: "tune_up_race", date: "2026-10-11", target: "半马 1:45", completed_actual: null }],
        is_completed: false,
      },
    ],
    weeks: [
      {
        week_index: 1,
        week_start: "2026-10-05",
        phase_name: "base",
        target_weekly_km_low: 30,
        target_weekly_km_high: 40,
        key_sessions: [{ type: "long_run", distance_km: 25, duration_min: 150 }],
        is_recovery_week: false,
      },
    ],
  } as unknown as MasterPlan;
}

function dataProviderWith(goalId: string | null): Pick<DataProvider, "getRaceTarget"> {
  return {
    async getRaceTarget() {
      return goalId === null
        ? null
        : {
            goal_id: goalId,
            user_id: USER_ID,
            status: "active",
            race_date: "2027-03-21",
            race_distance: "FM",
            race_name: "无锡马拉松",
            target_finish_time: "3:30:00",
            weekly_training_days: 6,
          };
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeSink(goalId: string | null, fetchImpl: typeof fetch) {
  return createMasterPlanDraftSink(dataProviderWith(goalId) as DataProvider, { baseUrl: "http://go:8080", internalToken: "tok" }, fetchImpl);
}

test("draft sink resolves the race goal and inserts through the Go internal endpoint", async () => {
  const requests: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  const sink = makeSink(
    GOAL_ID,
    async (input, init) => {
      requests.push({
        url: String(input),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: JSON.parse(String(init?.body)),
      });
      return jsonResponse(201, { success: true, plan_id: "plan-1", status: "draft" });
    },
  );
  const planId = await sink(minimalPlan(), USER_ID);
  assert.equal(planId, "plan-1");
  const request = requests[0];
  assert.ok(request, "insert must be called exactly once");
  assert.equal(request.url, `http://go:8080/api/users/${USER_ID}/master-plan/drafts`);
  assert.equal(request.headers["x-internal-token"], "tok");
  const body = request.body as { draft_id?: string; content?: { goal?: { goal_id?: string }; phases?: Array<{ id?: string }> } };
  assert.match(body.draft_id ?? "", /.+/, "幂等 draft_id 必须携带");
  assert.equal(body.content?.goal?.goal_id, GOAL_ID, "goal 绑定当前激活 race goal");
  assert.equal(body.content?.phases?.[0]?.id, "phase-1", "Go 存储契约的确定性 id");
});

test("draft sink returns null when the user has no active race goal", async () => {
  let calls = 0;
  const sink = makeSink(
    null,
    async () => {
      calls += 1;
      return jsonResponse(201, {});
    },
  );
  assert.equal(await sink(minimalPlan(), USER_ID), null);
  assert.equal(calls, 0, "无 goal 时不得打 Go 端点");
});

test("draft sink is fail-soft on rejection, transport error and malformed success", async () => {
  for (const respond of [
    () => jsonResponse(422, { error: "invalid_content" }),
    () => {
      throw new Error("connect timeout");
    },
    () => jsonResponse(201, { success: true }),
  ]) {
    const sink = makeSink(GOAL_ID, async () => respond());
    assert.equal(await sink(minimalPlan(), USER_ID), null);
  }
});

test("draft sink rejects a lenient plan whose week phase_name matches no phase", async () => {
  let calls = 0;
  const sink = makeSink(
    GOAL_ID,
    async () => {
      calls += 1;
      return jsonResponse(201, { plan_id: "plan-1" });
    },
  );
  const plan = minimalPlan() as { weeks: Array<{ phase_name: string }> };
  const week = plan.weeks[0];
  assert.ok(week);
  week.phase_name = "sharpen";
  assert.equal(await sink(plan as MasterPlan, USER_ID), null);
  assert.equal(calls, 0, "后验失败不得打 Go 端点（Go 必拒，别浪费一次 422）");
});

test("draft sink rejects a lenient plan with duplicate phase names", async () => {
  let calls = 0;
  const sink = makeSink(
    GOAL_ID,
    async () => {
      calls += 1;
      return jsonResponse(201, { plan_id: "plan-1" });
    },
  );
  const plan = minimalPlan() as { phases: unknown[]; weeks: unknown[] };
  const phase = plan.phases[0];
  const week = plan.weeks[0];
  assert.ok(phase && week);
  plan.phases.push(phase);
  plan.weeks.push(week);
  assert.equal(await sink(plan as unknown as MasterPlan, USER_ID), null);
  assert.equal(calls, 0, "重复 phase 名会让周错绑，落库前拒绝");
});
