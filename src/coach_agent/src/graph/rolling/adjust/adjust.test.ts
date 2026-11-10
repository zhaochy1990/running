import assert from "node:assert/strict";
import { test } from "node:test";
import type { WeeklyPlan } from "@stride/contract";
import type { WeekDeviation } from "../detect/detector.js";
import { diffOfWeeks } from "../projection.js";
import { runAdjustProjection } from "./adjust.js";

/**
 * 调整投影单测（#858 PR-C）：diffOfWeeks（新周文档 vs 现 weekly 行对照）+
 * injured 拦截（recipeFor 抛错在 L1/L3 之前——确定性失败不触 provider/LLM）。
 * completed 全链（L1→L3→调整批窗→配方覆写 L4）需要 provider+LLM，归真实数据
 * 脚本 coach_agent_api/scripts/test_adjust_e2e.ts 验收；no_op/infeasible 的窗口
 * 语义归 window.test.ts（内核同一判定）。
 */

const deviation = (weekStart: string): WeekDeviation => ({
  weekStart,
  plannedKm: 60,
  actualKm: 35,
  deliveryRatio: 0.583,
  qualityDone: 0,
  qualityPlanned: 2,
  longRunDone: false,
  class: "missed",
  preselect: "no_time",
  severe: true,
  evidence: "计划 2 节质量课完成 0；长跑未跑；周量 35/60km（58%）",
  detail: [],
  unmatched: [],
});

test("diffOfWeeks：新周文档 target km vs 现 weekly 行对照（缺行=0、r1 舍入）", () => {
  const doc = (week: number, km: number | null) => ({ week_index: week, target_weekly_km_low: km }) as unknown as WeeklyPlan;
  const docs = [doc(6, 66.6), doc(7, 72.25), doc(8, 0)];
  const existing = [
    { weekStart: "2026-11-09", week: 6, km: 66 },
    { weekStart: "2026-11-16", week: 7, km: 80.1 },
  ];
  assert.deepEqual(diffOfWeeks(docs, existing), [
    { week: 6, oldKm: 66, newKm: 66.6 },
    { week: 7, oldKm: 80.1, newKm: 72.3 },
    { week: 8, oldKm: 0, newKm: 0 }, // 无现周行（快照周缺行）→ oldKm=0
  ]);
});

test("runAdjustProjection：injured 拦截——recipeFor 先行抛错（确定性失败，不触 provider/LLM）", async () => {
  const provider = {
    loadSnapshot: async () => {
      throw new Error("injured 拦截必须发生在 L1 取数之前");
    },
    loadActivities: async () => {
      throw new Error("injured 拦截必须发生在 L1 取数之前");
    },
  };
  await assert.rejects(
    runAdjustProjection(
      { contextProvider: provider, models: { phasingModel: {} as never, contentModel: {} as never } },
      {
        userId: "u1",
        master: { planStartMonday: "2026-10-05" } as never,
        asOf: "2026-11-11T09:00:00.000+08:00",
        deviation: deviation("2026-11-02"),
        reason: "injured",
        existingWeeks: [{ weekStart: "2026-11-09", week: 6, km: 66 }],
      },
    ),
    /injured/,
  );
});
