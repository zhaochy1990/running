import assert from "node:assert/strict";
import test from "node:test";
import { MasterPlanGraphRequest } from "@stride/coach-agent";
import { createTestCompletedOutcomeV3, createTestRequest } from "@stride/coach-agent/test-fixtures";
import type { RollingWeeklyChannel, WeeklyPlanAppliedWeek } from "../../src/goClient/weeklyPlanClient.js";
import { asPermanent, ERROR_CODES } from "../../src/job/errors.js";
import { createMasterPlanJobHandler, type MasterPlanHandlerDeps } from "../../src/kernel/master/handler.js";
import { FakePlanJobStore } from "../job/fakes.js";

const GOAL_ID = "11111111-2222-3333-4444-555555555555";

/** 记录调用的假周课通道（#858 首批物化断言用）。 */
class FakeWeeklyChannel {
  batches: Array<{ userId: string; masterPlanId: string; weeks: unknown[] }> = [];
  results: WeeklyPlanAppliedWeek[] = [];
  async batchApplyWeeklyPlans(userId: string, masterPlanId: string, weeks: unknown[]): Promise<WeeklyPlanAppliedWeek[]> {
    this.batches.push({ userId, masterPlanId, weeks });
    return this.results;
  }
  async listWeeklyPlanWeeks() {
    return [];
  }
}

/** handler 的测试对象是「kernel 产物 → job result_json」，用假 stream 图喂合法 v3 产物。 */
function buildGraph(weeklyDocs = 0) {
  const outcome = createTestCompletedOutcomeV3({ totalWeeks: 2, weeklyDocs });
  return {
    async stream() {
      return (async function* () {
        yield { initialize: {} };
        yield { finalize: { outcome } };
      })();
    },
  } as never;
}

function deps(overrides: Partial<MasterPlanHandlerDeps> = {}): MasterPlanHandlerDeps {
  return {
    graph: buildGraph(),
    resolveGoalId: async () => GOAL_ID,
    weeklyPlans: new FakeWeeklyChannel() as unknown as RollingWeeklyChannel,
    ...overrides,
  };
}

test("completed master run reports the full v2 content in result_json (#585, no draft insert)", async () => {
  const handler = createMasterPlanJobHandler(deps());
  const job = FakePlanJobStore.fixture({ inputJson: JSON.stringify(MasterPlanGraphRequest.parse(createTestRequest())) });
  const result = await handler(job, async () => {});

  const parsed = JSON.parse(result.result) as { content: Record<string, unknown>; revision: number; generated_by: string };
  assert.equal(parsed.revision, 1);
  assert.equal(parsed.generated_by, "plan-job");

  const content = parsed.content as {
    goal: { goal_id: string };
    availability: { weekly_run_days_max: number };
    phases: Array<{ id: string; milestone_ids: string[] }>;
    milestones: Array<{ id: string; phase_id: string; type: string; target: string }>;
    weeks: Array<{ phase_id: string; week_index: number }>;
    start_date: string;
    total_weeks: number;
  };
  assert.equal(content.goal.goal_id, GOAL_ID);
  // #858：availability 随 content 落库（滚动 job 读档需要），读路径 Go 透传。
  assert.equal(content.availability.weekly_run_days_max, 6);
  assert.ok(content.phases[0]?.id);
  assert.ok(Array.isArray(content.phases[0]?.milestone_ids));
  assert.ok(Array.isArray(content.milestones));
  assert.ok(content.weeks[0]?.phase_id);
  assert.ok(content.start_date.length > 0 && content.total_weeks >= 1);
});

test("master run materializes the first-batch weekly docs through the rolling channel (#858)", async () => {
  const channel = new FakeWeeklyChannel();
  channel.results = [
    { week_start: "2026-08-10", plan_id: "w1", revision: 1, replaced: false },
    { week_start: "2026-08-17", plan_id: "w2", revision: 1, replaced: false },
  ];
  const handler = createMasterPlanJobHandler(deps({ graph: buildGraph(2), weeklyPlans: channel as unknown as RollingWeeklyChannel }));
  const job = FakePlanJobStore.fixture({ inputJson: JSON.stringify(MasterPlanGraphRequest.parse(createTestRequest())) });
  const result = await handler(job, async () => {});

  // batch-apply 被调用：weekly_docs 全量经通道落库，归链 result 里的前瞻计划 id。
  assert.equal(channel.batches.length, 1);
  assert.equal(channel.batches[0]?.weeks.length, 2);
  const parsed = JSON.parse(result.result) as {
    master_plan_id: string;
    weekly_weeks: Array<{ week_start: string; revision: number }>;
    content: { master_plan_id: string };
  };
  assert.ok(/^[0-9a-f-]{36}$/.test(parsed.master_plan_id));
  assert.equal(channel.batches[0]?.masterPlanId, parsed.master_plan_id);
  assert.equal(parsed.content.master_plan_id, parsed.master_plan_id);
  assert.deepEqual(
    parsed.weekly_weeks.map((row) => row.week_start),
    ["2026-08-10", "2026-08-17"],
  );
  assert.equal(parsed.weekly_weeks[0]?.revision, 1);
});

test("master run without weekly docs skips the channel", async () => {
  const channel = new FakeWeeklyChannel();
  const handler = createMasterPlanJobHandler(deps({ weeklyPlans: channel as unknown as RollingWeeklyChannel }));
  const job = FakePlanJobStore.fixture({ inputJson: JSON.stringify(MasterPlanGraphRequest.parse(createTestRequest())) });
  const result = await handler(job, async () => {});
  assert.equal(channel.batches.length, 0);
  const parsed = JSON.parse(result.result) as { weekly_weeks: unknown[] };
  assert.deepEqual(parsed.weekly_weeks, []);
});

test("invalid enqueued request is a terminal contract violation", async () => {
  const handler = createMasterPlanJobHandler(deps());
  const job = FakePlanJobStore.fixture({ inputJson: JSON.stringify({ request_id: "broken" }) });
  await assert.rejects(
    handler(job, async () => {}),
    (error: unknown) => {
      const permanent = asPermanent(error);
      assert.ok(permanent);
      assert.equal(permanent.code, ERROR_CODES.CONTRACT_VIOLATION);
      return true;
    },
  );
});

test("missing active race goal fails terminally", async () => {
  const handler = createMasterPlanJobHandler(deps({ resolveGoalId: async () => null }));
  const job = FakePlanJobStore.fixture({ inputJson: JSON.stringify(MasterPlanGraphRequest.parse(createTestRequest())) });
  await assert.rejects(
    handler(job, async () => {}),
    (error: unknown) => {
      const permanent = asPermanent(error);
      assert.ok(permanent);
      assert.equal(permanent.code, ERROR_CODES.NO_ACTIVE_RACE_GOAL);
      return true;
    },
  );
});
