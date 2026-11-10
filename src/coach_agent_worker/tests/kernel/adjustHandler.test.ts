import assert from "node:assert/strict";
import test from "node:test";
import { type AdjustOutcome, masterPlanToContent } from "@stride/coach-agent";
import { createTestCompletedOutcomeV3, createTestWeeklyPlanDoc } from "@stride/coach-agent/test-fixtures";
import type { AdjustJobRequest } from "@stride/contract";
import { AdjustmentEventClosedError } from "../../src/goClient/weeklyPlanClient.js";
import { asPermanent } from "../../src/job/errors.js";
import { type AdjustHandlerDeps, createAdjustJobHandler } from "../../src/kernel/adjust/handler.js";
import { FakePlanJobStore } from "../job/fakes.js";

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

function fakeDeps(overrides: { outcome?: AdjustOutcome; pending?: object | null; upsertError?: Error } = {}): AdjustHandlerDeps {
  const pendingRow =
    overrides.pending === undefined
      ? {
          id: "adj-01",
          master_plan_id: CONTENT_MASTER_ID,
          event_week_start: EVENT_WEEK,
          reason: "no_time",
          status: "pending",
          payload: null,
          question: "上周完成得不理想，主要是？",
        }
      : null;
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
      async upsertAdjustment(userId: string, input: { masterPlanId: string; eventWeekStart: string; reason: string; question: string; payload: string }) {
        if (overrides.upsertError) throw overrides.upsertError;
        upsertCalls.push({ userId, ...input });
        return {
          id: "adj-02",
          master_plan_id: input.masterPlanId,
          event_week_start: input.eventWeekStart,
          reason: input.reason,
          status: "pending",
          payload: input.payload,
          question: input.question,
        };
      },
      async batchApplyWeeklyPlans() {
        throw new Error("adjust job never batch-applies");
      },
      async getInjuryState() {
        return null; // adjust 流不触达伤病通道（#858 PR-D）
      },
      async updateInjuryMaintenance() {
        throw new Error("adjust job never writes injury maintenance");
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
const upsertCalls: Array<{ userId: string; masterPlanId: string; eventWeekStart: string; reason: string; question: string; payload: string }> = [];
const projectionInputs: Array<{ reason: string; deviation: { class: string; severe: boolean } }> = [];

function job(reason: AdjustJobRequest["reason"] = "no_time", eventWeek = EVENT_WEEK, createPending = false) {
  return FakePlanJobStore.fixture({
    userId: USER_ID,
    jobType: "generate_adjustment",
    inputJson: JSON.stringify({
      request_id: "req-1",
      event_week_start: eventWeek,
      reason,
      ...(createPending ? { create_pending: true } : {}),
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
    createAdjustJobHandler(fakeDeps({ outcome: { decision: "infeasible", reason: "L3 门挂", failedChecks: [{ id: "H1", detail: "x" }] } }))(
      job(),
      async () => {},
    ),
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

// ── create_pending 夜检建行分支（#858 PR-C 下半）──────────────────────────────

test("create_pending：无 pending 行 → 检测+投影 → upsert 建行（payload=投影产物）", async () => {
  const before = handlerCalls.length;
  const result = await createAdjustJobHandler(fakeDeps({ pending: null }))(job("no_time", EVENT_WEEK, true), async () => {});
  const parsed = JSON.parse(result.result);
  assert.equal(parsed.decision, "completed");
  assert.equal(parsed.created_pending, true);
  assert.equal(parsed.adjustment_id, "adj-02");
  // 检测真实跑过（空活动周 → missed severe）
  assert.ok(["missed", "volume_short"].includes(projectionInputs.at(-1)!.deviation.class));
  // upsert 建行被调、回填通道未被调
  assert.equal(upsertCalls.length, 1);
  assert.equal(handlerCalls.length, before);
  const upsert = upsertCalls[0]!;
  assert.equal(upsert.userId, USER_ID);
  assert.equal(upsert.masterPlanId, CONTENT_MASTER_ID);
  assert.equal(upsert.eventWeekStart, EVENT_WEEK);
  assert.equal(upsert.reason, "no_time");
  assert.equal(upsert.question, "上周完成得不理想，主要是？");
  const payload = JSON.parse(upsert.payload);
  assert.equal(payload.reason, "no_time");
  assert.equal(payload.weekly_docs.length, 1);
  assert.ok(payload.evidence.length > 0);
});

test("create_pending：Go 409 事件已关闭 → no-op 成功（不报错不重试）", async () => {
  const result = await createAdjustJobHandler(fakeDeps({ pending: null, upsertError: new AdjustmentEventClosedError() }))(
    job("no_time", EVENT_WEEK, true),
    async () => {},
  );
  const parsed = JSON.parse(result.result);
  assert.equal(parsed.decision, "no_op");
  assert.match(parsed.reason, /已关闭/);
});

test("create_pending：已有同事件 pending → 维持回填路径（不 upsert）", async () => {
  const upsertsBefore = upsertCalls.length;
  const result = await createAdjustJobHandler(fakeDeps())(job("no_time", EVENT_WEEK, true), async () => {});
  const parsed = JSON.parse(result.result);
  assert.equal(parsed.decision, "completed");
  assert.equal(parsed.adjustment_id, "adj-01");
  assert.equal(parsed.created_pending, undefined);
  assert.equal(upsertCalls.length, upsertsBefore);
  assert.equal(handlerCalls.at(-1)!.adjustmentId, "adj-01");
});

test("create_pending：他事件 pending → 建行走 upsert（Go 侧先 supersede 旧行）", async () => {
  const deps = fakeDeps({
    pending: {
      id: "adj-old",
      master_plan_id: CONTENT_MASTER_ID,
      event_week_start: "2026-08-10",
      reason: "no_time",
      status: "pending",
      payload: null,
      question: "旧问句",
    },
  });
  const result = await createAdjustJobHandler(deps)(job("no_time", EVENT_WEEK, true), async () => {});
  const parsed = JSON.parse(result.result);
  assert.equal(parsed.decision, "completed");
  assert.equal(upsertCalls.at(-1)!.eventWeekStart, EVENT_WEEK);
});

test("无 pending 且非 create_pending：换因链路维持 no-op（不越权建行）", async () => {
  const upsertsBefore = upsertCalls.length;
  const result = await createAdjustJobHandler(fakeDeps({ pending: null }))(job(), async () => {});
  assert.equal(JSON.parse(result.result).decision, "no_op");
  assert.equal(upsertCalls.length, upsertsBefore);
});
