import assert from "node:assert/strict";
import test from "node:test";
import { masterPlanToContent, type AdjustOutcome } from "@stride/coach-agent";
import { createTestCompletedOutcomeV3, createTestWeeklyPlanDoc } from "@stride/coach-agent/test-fixtures";
import { type AdjustJobRequest } from "@stride/contract";
import { asPermanent } from "../../src/job/errors.js";
import { FakePlanJobStore } from "../job/fakes.js";
import { createAdjustJobHandler, type AdjustHandlerDeps } from "../../src/kernel/adjust/handler.js";

/**
 * adjust handler 单测（#858 PR-C）：定位 pending → 事件周检测 → 投影 → payload
 * 回填的搬运逻辑。投影注入 fake（内核在 coach_agent 测），检测用真实 assessWeek
 * 跑最小样本（事件周文档 + 空活动=missed severe——真实分支覆盖）。
 */

const USER_ID = "f10bc353-01ab-4db1-af9f-d9305ea9a532";
const ROW_PLAN_ID = "11111111-2222-3333-4444-555555555555";
const CONTENT_MASTER_ID = "99999999-8888-7777-6666-555555555555";
const EVENT_WEEK = "2026-08-17"; // fixture 计划第 2 周（planStart=2026-08-10）

function storedContent(): Record<string, unknown> {
  const { artifact } = createTestCompletedOutcomeV3({ totalWeeks: 10 });
  const content = masterPlanToContent(artifact.plan, ROW_PLAN_ID, { weekly_run_days_max: 6 });
  content.master_plan_id = CONTENT_MASTER_ID;
  content.policy = artifact.policy;
  content.skeleton = artifact.skeleton;
  content.anchor = artifact.anchor;
  return content;
}

function fakeDeps(overrides: { outcome?: AdjustOutcome; pending?: object | null } = {}): AdjustHandlerDeps {
  const pendingRow = overrides.pending === undefined ? {
    id: "adj-01",
    master_plan_id: CONTENT_MASTER_ID,
    event_week_start: EVENT_WEEK,
    reason: "no_time",
    status: "pending",
    payload: null,
    question: "上周完成得不理想，主要是？",
  } : null;
  const docs = new Map<string, unknown>([
    [EVENT_WEEK, createTestWeeklyPlanDoc(2)],
    ["2026-08-10", createTestWeeklyPlanDoc(1)],
  ]);
  return {
    contextProvider: {
      // 事件周活动：空周（missed severe）——真实 assessWeek 分支
      loadActivities: async () => [],
      loadSnapshot: async () => {
        throw new Error("adjust projection fake must not load snapshot");
      },
    },
    models: {
      phasingModel: {} as never,
      contentModel: {} as never,
    },
    masterPlans: {
      async getMasterPlanMetadataForDate() {
        return { planId: ROW_PLAN_ID, revision: 1, status: "active", content: storedContent() };
      },
    },
    weeklyPlans: {
      async listWeeklyPlanWeeks() {
        return [
          { week_start: "2026-08-10", master_plan_id: CONTENT_MASTER_ID, revision: 1 },
          { week_start: EVENT_WEEK, master_plan_id: CONTENT_MASTER_ID, revision: 1 },
        ];
      },
      async getPendingAdjustment() {
        return pendingRow as never;
      },
      async completeAdjustmentPayload(_userId: string, adjustmentId: string, reason: string, payload: string) {
        handlerCalls.push({ adjustmentId, reason, payload });
        return pendingRow as never;
      },
      async batchApplyWeeklyPlans() {
        throw new Error("adjust job never batch-applies");
      },
    },
    weeklyDocs: {
      async getWeeklyPlan(_userId: string, weekStart: string) {
        return docs.get(weekStart) ?? null;
      },
    },
    projection: async (_deps, input) => {
      projectionInputs.push(input);
      if (overrides.outcome) return overrides.outcome;
      return {
        decision: "completed",
        reason: input.reason,
        window: { startWeek: 3, endWeek: 4, mode: "boundary" as const, reason: "测试窗口" },
        weeklyDocs: [createTestWeeklyPlanDoc(3)],
        diff: [{ week: 3, oldKm: 60, newKm: 42 }],
        audit: { items: [], summary: { pass: 1, warn: 0, fail: 0 } },
        evidence: "周量 12/46km（26%）",
      };
    },
  };
}

const handlerCalls: Array<{ adjustmentId: string; reason: string; payload: string }> = [];
const projectionInputs: Array<{ reason: string; deviation: { class: string; severe: boolean } }> = [];

function job(reason: AdjustJobRequest["reason"] = "no_time", eventWeek = EVENT_WEEK) {
  return FakePlanJobStore.fixture({
    userId: USER_ID,
    jobType: "generate_adjustment",
    inputJson: JSON.stringify({
      request_id: "req-1",
      event_week_start: eventWeek,
      reason,
      as_of: "2026-08-24T12:00:00.000+08:00",
    } satisfies AdjustJobRequest),
  });
}

test("injured 原因直接 permanent（伤病模式另行接管）", async () => {
  await assert.rejects(
    createAdjustJobHandler(fakeDeps())(job("injured"), async () => {}),
    (error: unknown) => asPermanent(error)?.code === "kernel_adjust_injured_unsupported",
  );
});

test("无 pending 行（竞态拒绝）= no-op 成功", async () => {
  const result = await createAdjustJobHandler(fakeDeps({ pending: null }))(job(), async () => {});
  assert.equal(JSON.parse(result.result).decision, "no_op");
});

test("happy path：检测偏差 → 投影 → 回填 payload", async () => {
  const result = await createAdjustJobHandler(fakeDeps())(job(), async () => {});
  const parsed = JSON.parse(result.result);
  assert.equal(parsed.decision, "completed");
  assert.equal(parsed.adjustment_id, "adj-01");
  // 检测真实跑过：空活动周 → missed severe，进投影的 deviation
  assert.ok(["missed", "volume_short"].includes(projectionInputs.at(-1)!.deviation.class));
  assert.equal(projectionInputs.at(-1)!.deviation.severe, true);
  // payload 回填进 Go 内部通道
  assert.equal(handlerCalls.at(-1)!.adjustmentId, "adj-01");
  const payload = JSON.parse(handlerCalls.at(-1)!.payload);
  assert.equal(payload.reason, "no_time");
  assert.equal(payload.weekly_docs.length, 1);
});

test("事件周已恢复正常 = permanent（最新数据为准）", async () => {
  const deps = fakeDeps();
  // 活动喂足：与计划周文档一一对应的完美执行 → within_tolerance
  const doc = createTestWeeklyPlanDoc(2);
  const run = doc.sessions.find((session) => session.kind === "run")!;
  deps.contextProvider = {
    loadActivities: async () => [
      {
        shanghaiDay: run.date,
        name: run.summary,
        sport: "run",
        sportName: "run",
        distanceM: run.total_distance_m,
        strideSessionClass: "easy",
        durationS: run.total_duration_s,
      },
    ],
    loadSnapshot: async () => {
      throw new Error("unused");
    },
  };
  await assert.rejects(
    createAdjustJobHandler(deps)(job(), async () => {}),
    (error: unknown) => asPermanent(error)?.code === "kernel_adjust_no_deviation",
  );
});

test("pending 行 reason 与请求不一致 = permanent", async () => {
  await assert.rejects(
    createAdjustJobHandler(fakeDeps())(job("over_delivered"), async () => {}),
    (error: unknown) => asPermanent(error)?.code === "kernel_adjust_reason_mismatch",
  );
});

test("infeasible（L3 门挂）= permanent 带 failedChecks", async () => {
  await assert.rejects(
    createAdjustJobHandler(fakeDeps({ outcome: { decision: "infeasible", reason: "L3 门挂", failedChecks: [{ id: "H1", detail: "x" }] } }))(job(), async () => {}),
    (error: unknown) => {
      const permanent = asPermanent(error);
      return permanent?.code === "kernel_adjust_infeasible" && (permanent.message.includes("H1") ?? false);
    },
  );
});

test("no_op 窗口（当前周已是批次末）= 成功 no_op，不回填", async () => {
  const before = handlerCalls.length;
  const result = await createAdjustJobHandler(fakeDeps({ outcome: { decision: "no_op", reason: "窗口空" } }))(job(), async () => {});
  assert.equal(JSON.parse(result.result).decision, "no_op");
  assert.equal(handlerCalls.length, before);
});

