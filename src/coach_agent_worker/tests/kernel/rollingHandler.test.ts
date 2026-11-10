import assert from "node:assert/strict";
import test from "node:test";
import { masterPlanToContent, type RollingOutcome } from "@stride/coach-agent";
import { createTestCompletedOutcomeV3, createTestWeeklyPlanDoc } from "@stride/coach-agent/test-fixtures";
import type { WeeklyPlanAppliedWeek } from "../../src/goClient/weeklyPlanClient.js";
import { asPermanent } from "../../src/job/errors.js";
import { createRollingJobHandler, type RollingHandlerDeps, type RollingProjection } from "../../src/kernel/rolling/handler.js";
import { FakePlanJobStore } from "../job/fakes.js";

/**
 * rolling handler 单测（#858 PR-A）：读档/校验/组装 → 投影 → 落库/result 的搬运
 * 逻辑。滚动内核本身有 coach_agent 测试与真实数据脚本验收，这里注入 fake
 * projection 观测入参（lastGeneratedWeek 汇聚）与出参分支（completed/no_op/
 * infeasible）。
 */

const USER_ID = "f10bc353-01ab-4db1-af9f-d9305ea9a532";
const ROW_PLAN_ID = "11111111-2222-3333-4444-555555555555";
const CONTENT_MASTER_ID = "99999999-8888-7777-6666-555555555555";

/** 与 worker master handler 同构的落库 content（含 #859 政策包 + #858 availability/前瞻 id）。 */
function storedContent(overrides: { totalWeeks?: number; withContentMasterId?: boolean } = {}): Record<string, unknown> {
  const { artifact } = createTestCompletedOutcomeV3({ totalWeeks: overrides.totalWeeks ?? 10 });
  const content = masterPlanToContent(artifact.plan, "11111111-2222-3333-4444-555555555555", { weekly_run_days_max: 6 });
  if (overrides.withContentMasterId !== false) content.master_plan_id = CONTENT_MASTER_ID;
  content.policy = artifact.policy;
  content.skeleton = artifact.skeleton;
  content.anchor = artifact.anchor;
  content.audit = artifact.audit;
  return content;
}

function fakeMasterSource(content: Record<string, unknown>, status = "active") {
  return {
    async getMasterPlanMetadataForDate() {
      return { planId: ROW_PLAN_ID, revision: 1, status, content };
    },
  };
}

class FakeWeeklyChannel {
  listedFor: string[] = [];
  batches: Array<{ userId: string; masterPlanId: string; weeks: unknown[] }> = [];
  rows: Array<{ week_start: string; master_plan_id: string | null; revision: number }> = [];
  results: WeeklyPlanAppliedWeek[] = [];
  /** 调整通道占位（rolling 流不触达；接口扩展自 AdjustmentChannel）。 */
  pendingAdjustment: import("../../src/goClient/weeklyPlanClient.js").PendingAdjustmentRow | null = null;
  refilled: Array<{ adjustmentId: string; reason: string; payload: string }> = [];
  async listWeeklyPlanWeeks(_userId: string, masterPlanId: string) {
    this.listedFor.push(masterPlanId);
    return this.rows;
  }
  async batchApplyWeeklyPlans(userId: string, masterPlanId: string, weeks: unknown[]) {
    this.batches.push({ userId, masterPlanId, weeks });
    return this.results;
  }
  async getPendingAdjustment(): Promise<import("../../src/goClient/weeklyPlanClient.js").PendingAdjustmentRow | null> {
    return this.pendingAdjustment;
  }
  async completeAdjustmentPayload(_userId: string, adjustmentId: string, reason: string, payload: string) {
    this.refilled.push({ adjustmentId, reason, payload });
    return this.pendingAdjustment!;
  }
  async upsertAdjustment(): Promise<import("../../src/goClient/weeklyPlanClient.js").PendingAdjustmentRow> {
    throw new Error("rolling job never upserts adjustments");
  }
}

function deps(overrides: Partial<RollingHandlerDeps> & { content?: Record<string, unknown>; projectionOutcome?: RollingOutcome } = {}): RollingHandlerDeps {
  const { content = storedContent(), projectionOutcome, ...rest } = overrides;
  const projection: RollingProjection = async () => {
    if (projectionOutcome === undefined) throw new Error("fake projection requires an outcome");
    return projectionOutcome;
  };
  return {
    contextProvider: {
      loadSnapshot: async () => {
        throw new Error("fake projection must not touch the provider");
      },
      loadActivities: async () => {
        throw new Error("fake projection must not touch the provider");
      },
    },
    models: {
      phasingModel: { invoke: async () => ({}) },
      contentModel: { invoke: async () => ({}) },
    } as unknown as RollingHandlerDeps["models"],
    masterPlans: fakeMasterSource(content),
    weeklyPlans: new FakeWeeklyChannel(),
    projection,
    ...rest,
  };
}

function rollingJob(input: Record<string, unknown> = {}) {
  return FakePlanJobStore.fixture({
    userId: USER_ID,
    jobType: "generate_rolling_block",
    inputJson: JSON.stringify({ request_id: "roll-1", ...input }),
  });
}

function completedOutcome(): RollingOutcome {
  return {
    decision: "completed",
    window: { startWeek: 7, endWeek: 10, mode: "boundary", reason: "边界触发" },
    skeletonNew: { weeks: [], blocks: [], recovery_policy: [], strength_policy: [], checks: [], milestones: [] },
    deviation: [],
    scheduled: {
      weeks: [],
      calendar: [],
      loadSeries: [],
      checks: [],
      scheduleChecks: [],
      repairs: [],
      source: "llm",
      attempts: 1,
      attemptsDetail: [],
      loadMeta: { model: "exp-pmc-7-42", seed: { acute: 0, chronic: 0, source: "" }, coefficient_version: "" },
    },
    weeklyDocs: [createTestWeeklyPlanDoc(7) as never, createTestWeeklyPlanDoc(8) as never],
    audit: { items: [], summary: { pass: 0, warn: 0, fail: 0 } },
    evidence: {} as never,
  };
}

test("completed：weeklyDocs 落库调用 + result 带 weekly_weeks；心跳单调走到 outputting", async () => {
  const handler = createRollingJobHandler(deps({ projectionOutcome: completedOutcome() }));
  const heartbeats: Array<[string, number]> = [];
  const result = await handler(rollingJob(), async (stage, pct) => {
    heartbeats.push([stage, pct]);
  });

  const parsed = JSON.parse(result.result) as {
    decision: string;
    master_plan_id: string;
    weekly_weeks: Array<{ week_start: string; revision: number }>;
    window: { start_week: number; end_week: number };
  };
  assert.equal(parsed.decision, "completed");
  assert.equal(parsed.master_plan_id, CONTENT_MASTER_ID);
  assert.equal(parsed.window.start_week, 7);
  assert.deepEqual(parsed.weekly_weeks, []);

  const pcts = heartbeats.map(([, pct]) => pct);
  assert.deepEqual(
    pcts,
    [...pcts].sort((a, b) => a - b),
    "progress must be monotonic",
  );
  assert.ok(heartbeats.some(([stage, pct]) => stage === "reading_history" && pct === 10));
  assert.ok(heartbeats.some(([stage, pct]) => stage === "outputting" && pct === 95));
});

test("completed：batch-apply 收到全量 weeklyDocs（经通道 fake 校验）", async () => {
  const fake = new FakeWeeklyChannel();
  fake.results = [
    { week_start: "2026-09-21", plan_id: "w7", revision: 1, replaced: false },
    { week_start: "2026-09-28", plan_id: "w8", revision: 1, replaced: false },
  ];
  const handler = createRollingJobHandler(deps({ projectionOutcome: completedOutcome(), weeklyPlans: fake }));
  const result = await handler(rollingJob(), async () => {});
  assert.equal(fake.batches.length, 1);
  assert.equal(fake.batches[0]?.userId, USER_ID);
  assert.equal(fake.batches[0]?.masterPlanId, CONTENT_MASTER_ID);
  assert.equal(fake.batches[0]?.weeks.length, 2);
  const parsed = JSON.parse(result.result) as { weekly_weeks: Array<{ week_start: string; revision: number }> };
  assert.deepEqual(
    parsed.weekly_weeks.map((row) => row.week_start),
    ["2026-09-21", "2026-09-28"],
  );
});

test("no_op：成功返回 decision=no_op + reason，不落库", async () => {
  const fake = new FakeWeeklyChannel();
  const handler = createRollingJobHandler(deps({ projectionOutcome: { decision: "no_op", reason: "存量课表未用尽" }, weeklyPlans: fake }));
  const result = await handler(rollingJob(), async () => {});
  const parsed = JSON.parse(result.result) as { decision: string; reason: string };
  assert.equal(parsed.decision, "no_op");
  assert.equal(parsed.reason, "存量课表未用尽");
  assert.equal(fake.batches.length, 0);
});

test("infeasible：permanent error kernel_rolling_infeasible 且 message 带 failedChecks JSON", async () => {
  const handler = createRollingJobHandler(
    deps({
      projectionOutcome: { decision: "infeasible", reason: "L3 六门 1 项未过", failedChecks: [{ id: "acwr", detail: "1.6 > 1.3" }] },
    }),
  );
  await assert.rejects(
    handler(rollingJob(), async () => {}),
    (error: unknown) => {
      const permanent = asPermanent(error);
      assert.ok(permanent);
      assert.equal(permanent.code, "kernel_rolling_infeasible");
      assert.match(permanent.message, /acwr/);
      assert.match(permanent.message, /failedChecks=/);
      return true;
    },
  );
});

test("master_plan_id 与 active 行不一致 = permanent error；一致时放行", async () => {
  const mismatchHandler = createRollingJobHandler(deps({ projectionOutcome: completedOutcome() }));
  await assert.rejects(
    mismatchHandler(rollingJob({ master_plan_id: "00000000-0000-0000-0000-000000000001" }), async () => {}),
    (error: unknown) => {
      const permanent = asPermanent(error);
      assert.ok(permanent);
      assert.equal(permanent.code, "kernel_rolling_master_plan_mismatch");
      return true;
    },
  );
  // 行 id 或 content 前瞻 id 任一匹配即放行
  const byRowId = createRollingJobHandler(deps({ projectionOutcome: completedOutcome() }));
  await byRowId(rollingJob({ master_plan_id: ROW_PLAN_ID }), async () => {});
  const byContentId = createRollingJobHandler(deps({ projectionOutcome: completedOutcome() }));
  await byContentId(rollingJob({ master_plan_id: CONTENT_MASTER_ID }), async () => {});
});

test("无 master plan / archived 行 / content 缺段分别给稳定 permanent code", async () => {
  const noPlan = createRollingJobHandler(
    deps({
      masterPlans: {
        async getMasterPlanMetadataForDate() {
          return null;
        },
      },
    }),
  );
  await assert.rejects(rollingRun(noPlan), rejectsWith("kernel_rolling_no_master_plan"));

  const archived = createRollingJobHandler(deps({ projectionOutcome: completedOutcome(), masterPlans: fakeMasterSource(storedContent(), "archived") }));
  await assert.rejects(rollingRun(archived), rejectsWith("kernel_rolling_master_plan_not_active"));

  const broken = JSON.parse(JSON.stringify(storedContent({ withContentMasterId: false }))) as Record<string, unknown>;
  delete broken.availability;
  await assert.rejects(
    rollingRun(createRollingJobHandler(deps({ content: broken, projectionOutcome: completedOutcome() }))),
    rejectsWith("kernel_rolling_content_invalid"),
  );
});

test("lastGeneratedWeek=快照有课周 ∪ 已落库 weekly 行的最大值；list 按 content 前瞻 id 查询", async () => {
  const content = storedContent({ totalWeeks: 12 });
  // 快照前 5 周有重点课；weekly 行已落库到第 7 周 → lastGeneratedWeek=7
  const weeks = content.weeks as Array<{ week_index: number; key_sessions?: unknown[] }>;
  for (const week of weeks.slice(0, 5)) week.key_sessions = [{ type: "long_run" }];
  const fake = new FakeWeeklyChannel();
  fake.rows = [
    { week_start: "2026-08-10", master_plan_id: CONTENT_MASTER_ID, revision: 1 },
    { week_start: "2026-09-21", master_plan_id: CONTENT_MASTER_ID, revision: 2 },
  ];
  const observed: { master?: { lastGeneratedWeek: number; masterPlanId: string } } = {};
  const projection: RollingProjection = async (_deps, input) => {
    observed.master = { lastGeneratedWeek: input.master.lastGeneratedWeek, masterPlanId: input.master.masterPlanId };
    return { decision: "no_op", reason: "probe" };
  };
  const handler = createRollingJobHandler(deps({ content, weeklyPlans: fake, projection }));
  await handler(rollingJob(), async () => {});
  assert.ok(observed.master);
  assert.equal(observed.master.lastGeneratedWeek, 7, "max(快照 5, weekly 行第 7 周)");
  assert.equal(observed.master.masterPlanId, CONTENT_MASTER_ID);
  assert.deepEqual(fake.listedFor, [CONTENT_MASTER_ID]);
});

function rollingRun(handler: ReturnType<typeof createRollingJobHandler>) {
  return handler(rollingJob(), async () => {});
}

function rejectsWith(code: string) {
  return (error: unknown) => {
    const permanent = asPermanent(error);
    assert.ok(permanent, `expected permanent error for ${code}`);
    assert.equal(permanent.code, code);
    return true;
  };
}
