import assert from "node:assert/strict";
import test from "node:test";
import { FrozenMasterPlanContextProvider, fromStoredContent, masterPlanToContent, runAdjustProjection, runRollingProjection } from "@stride/coach-agent";
import { createAssessmentSnapshot, createTestCompletedOutcomeV3 } from "@stride/coach-agent/test-fixtures";
import { addDays, type WeeklyPlan, WeeklyPlanSchema } from "@stride/contract";
import { createRollingJobHandler } from "../../src/kernel/rolling/handler.js";
import { FakePlanJobStore } from "../job/fakes.js";

/** 模型仅提供课包模板；真实 L1/L3/L4 排位、门禁、审计及 worker 通道均运行。 */
function scenario(totalWeeks: number, startWeek: number) {
  const { artifact } = createTestCompletedOutcomeV3({ totalWeeks });
  const foundation = artifact.policy.phases[0];
  assert.ok(foundation);
  const policy = {
    ...artifact.policy,
    phases: [
      { ...foundation, end_week: startWeek - 1 },
      {
        ...foundation,
        canonical: "final_quality" as const,
        name: "专项期",
        start_week: startWeek,
        end_week: totalWeeks,
        primary_goal: "race_specificity" as const,
        block_mode: "plateau" as const,
      },
    ],
    taper_weeks: 3,
    volume_bands: [
      { phase: foundation.name, weekly_km_min: 60, weekly_km_max: 90 },
      { phase: "专项期", weekly_km_min: 70, weekly_km_max: 100 },
    ],
  };
  const content = masterPlanToContent(
    { ...artifact.plan, goal: { ...artifact.plan.goal, race_date: addDays(artifact.plan.start_date, totalWeeks * 7 - 1) } },
    "goal-test",
    { weekly_run_days_max: 6 },
  );
  Object.assign(content, { policy, skeleton: artifact.skeleton, anchor: artifact.anchor });
  const asOf = addDays(artifact.plan.start_date, (startWeek - 1) * 7 - 1);
  const activities = Array.from({ length: 28 + totalWeeks }, (_, index) =>
    Array.from({ length: 6 }, (_, day) => ({
      shanghaiDay: addDays(artifact.plan.start_date, (index - 28) * 7 + day),
      name: "稳定有氧训练",
      sport: "run",
      distanceM: 80000 / 6,
      strideSessionClass: "easy",
      durationS: 4000,
    })),
  ).flat();
  const contextProvider = new FrozenMasterPlanContextProvider(createAssessmentSnapshot(), activities);
  const models = {
    phasingModel: {
      invoke: async () => {
        throw new Error("滚动/调整不应重跑 L2");
      },
    },
    contentModel: {
      invoke: async () => {
        throw new Error("使用既有确定性模板兜底");
      },
    },
  };
  const master = fromStoredContent({ content, masterPlanId: "plan-test", lastGeneratedWeek: startWeek - 1 });
  return { content, asOf, contextProvider, models, master };
}

for (const [totalWeeks, startWeek] of [
  [18, 13],
  [24, 16],
] as const) {
  test(`W${startWeek}–${totalWeeks} 滚动真实内核 → 多 taper 审计 → worker completed（非永久失败）、全量周文档交给隔离通道`, async () => {
    const data = scenario(totalWeeks, startWeek);
    let applied: WeeklyPlan[] = [];
    const handler = createRollingJobHandler({
      contextProvider: data.contextProvider,
      models: data.models,
      masterPlans: { getMasterPlanMetadataForDate: async () => ({ planId: "plan-test", revision: 1, status: "active", content: data.content }) },
      weeklyPlans: {
        listWeeklyPlanWeeks: async () => [{ week_start: addDays(data.master.planStartMonday, (startWeek - 2) * 7), master_plan_id: "plan-test", revision: 1 }],
        batchApplyWeeklyPlans: async (_user, _plan, docs) => {
          applied = docs.map((doc) => WeeklyPlanSchema.parse(doc));
          return [];
        },
        getPendingAdjustment: async () => null,
        getInjuryState: async () => null,
        completeAdjustmentPayload: async () => {
          throw new Error("滚动不应写调整方案");
        },
        upsertAdjustment: async () => {
          throw new Error("滚动不应写调整方案");
        },
        updateInjuryMaintenance: async () => {
          throw new Error("滚动不应写伤病状态");
        },
      },
      projection: async (deps, input) => {
        const outcome = await runRollingProjection(deps, input);
        assert.equal(outcome.decision, "completed", JSON.stringify(outcome));
        if (outcome.decision !== "completed") throw new Error("未返回 completed");
        assert.deepEqual(
          outcome.skeletonNew.weeks.filter((w) => w.role === "taper").map((w) => w.week),
          [totalWeeks - 2, totalWeeks - 1],
        );
        const arcs = outcome.audit.items.filter((item) => item.item.includes("周量弧"));
        assert.equal(arcs.length, 1);
        assert.equal(arcs[0]?.verdict, "pass");
        assert.match(arcs[0]?.actual ?? "", new RegExp(`W${totalWeeks - 2} .* → W${totalWeeks - 1} `));
        assert.equal(outcome.audit.summary.fail, 0);
        assert.ok(outcome.scheduled.checks.flat().every((c) => c.pass));
        assert.ok(outcome.scheduled.scheduleChecks.flat().every((c) => c.pass));
        return outcome;
      },
    });
    const result = await handler(
      FakePlanJobStore.fixture({
        userId: "athlete-test",
        jobType: "generate_rolling_block",
        inputJson: JSON.stringify({ request_id: "956-test", as_of: `${data.asOf}T10:00:00+08:00` }),
      }),
      async () => {},
    );
    const receipt = JSON.parse(result.result);
    assert.equal(receipt.decision, "completed");
    assert.deepEqual(receipt.window, { start_week: startWeek, end_week: totalWeeks, mode: "boundary" });
    assert.deepEqual(
      applied.map((doc) => doc.week_index),
      Array.from({ length: totalWeeks - startWeek + 1 }, (_, i) => startWeek + i),
    );
  });

  test(`W${totalWeeks - 2}–${totalWeeks} 调整共享内核：完成多 taper 审计并返回剩余周方案，不提前应用`, async () => {
    const data = scenario(totalWeeks, startWeek);
    const master = { ...data.master, lastGeneratedWeek: totalWeeks };
    const adjustStart = totalWeeks - 2;
    const adjustDay = addDays(master.planStartMonday, (adjustStart - 1) * 7);
    const outcome = await runAdjustProjection(
      { contextProvider: data.contextProvider, models: data.models },
      {
        userId: "athlete-test",
        master,
        asOf: adjustDay,
        reason: "volume_unmet",
        deviation: {
          weekStart: addDays(adjustDay, -7),
          plannedKm: 90,
          actualKm: 80,
          deliveryRatio: 80 / 90,
          qualityDone: 0,
          qualityPlanned: 2,
          longRunDone: true,
          class: "missed",
          preselect: "volume_unmet",
          severe: false,
          evidence: "测试偏差",
          detail: [],
          unmatched: [],
        },
        existingWeeks: Array.from({ length: totalWeeks - startWeek + 1 }, (_, i) => ({
          week: startWeek + i,
          weekStart: addDays(master.planStartMonday, (startWeek + i - 1) * 7),
          km: 80,
        })),
        existingDocs: [],
      },
    );
    assert.equal(outcome.decision, "completed", JSON.stringify(outcome));
    if (outcome.decision !== "completed") throw new Error("未返回 completed");
    assert.deepEqual(outcome.window, { startWeek: adjustStart, endWeek: totalWeeks });
    assert.equal(outcome.audit.items.find((item) => item.item === `W${totalWeeks - 1} 周量弧`)?.verdict, "pass");
    assert.equal(outcome.audit.summary.fail, 0);
    assert.equal(outcome.weeklyDocs.length, totalWeeks - adjustStart + 1);
    assert.equal(outcome.diff.length, outcome.weeklyDocs.length);
    for (const doc of outcome.weeklyDocs) WeeklyPlanSchema.parse(doc);
  });
}
