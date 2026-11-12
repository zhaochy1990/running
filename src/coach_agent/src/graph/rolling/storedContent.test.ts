import assert from "node:assert/strict";
import { test } from "node:test";
import { masterPlanToContent } from "../../agents/training/content.js";
import { createTestCompletedOutcomeV3, createTestMasterPlan, createTestWeeklyPlanDoc } from "../master_plan/testFixtures.js";
import { fromStoredContent, storedWeeklyDocOf } from "./storedContent.js";

/**
 * fromStoredContent 适配器单测（#858 PR-A Round 2）：用**真实落库形状**往返——
 * content 按 worker master handler 的组装方式构造（masterPlanToContent(plan, goalId,
 * availability) + policy/skeleton/anchor/audit 直接挂），fromStoredContent 解析回
 * RollingMasterInput 后政策包与原始对象逐段相等。
 */

function storedContentFixture(): Record<string, unknown> {
  const { artifact } = createTestCompletedOutcomeV3({ totalWeeks: 10 });
  const content = masterPlanToContent(artifact.plan, "11111111-2222-3333-4444-555555555555", { weekly_run_days_max: 5 });
  // worker master handler（#859/#858）把政策包四段与 availability 一并挂上
  content.policy = artifact.policy;
  content.skeleton = artifact.skeleton;
  content.anchor = artifact.anchor;
  content.audit = artifact.audit;
  return content;
}

test("fromStoredContent：真实 content 形状解析回 RollingMasterInput，政策包逐段相等", () => {
  const content = storedContentFixture();
  const master = fromStoredContent({ content, masterPlanId: "plan-uuid-1", lastGeneratedWeek: 6 });
  assert.equal(master.masterPlanId, "plan-uuid-1");
  assert.equal(master.planStartMonday, content.start_date);
  assert.equal(master.totalWeeks, content.total_weeks);
  assert.deepEqual(master.race, { name: "西安马拉松", date: "2026-10-18", targetTime: "2:50:00", distance: "FM" });
  assert.deepEqual(master.availability, { weeklyRunDaysMax: 5 });
  assert.equal(master.lastGeneratedWeek, 6);
  // 政策包三段经 zod 单源解析后与落库前对象逐段相等（无重排/无丢字段）
  assert.deepEqual(master.policy, content.policy);
  assert.deepEqual(master.skeleton, content.skeleton);
  assert.deepEqual(master.anchor, content.anchor);
});

test("fromStoredContent：JSON 序列化往返（DB longtext 读写路径）后解析结果一致", () => {
  const content = JSON.parse(JSON.stringify(storedContentFixture())) as Record<string, unknown>;
  const master = fromStoredContent({ content, masterPlanId: "p", lastGeneratedWeek: 3 });
  assert.equal(master.planStartMonday, "2026-08-10");
  assert.equal(master.availability.weeklyRunDaysMax, 5);
});

test("fromStoredContent：缺政策包（#859 前的老 content）与缺 availability 都抛错", () => {
  const legacy = masterPlanToContent(createTestMasterPlan(), "11111111-2222-3333-4444-555555555555") as Record<string, unknown>;
  // #859 前的老 content 连 availability 也没有——最先在 availability 段被拦下
  assert.throws(() => fromStoredContent({ content: legacy, masterPlanId: "p", lastGeneratedWeek: 1 }), /availability/);
  // 有 availability 但缺政策包段（#859 政策包未挂上）→ policy 解析错误
  const noPolicy = { ...legacy, availability: { weekly_run_days_max: 5 } };
  assert.throws(() => fromStoredContent({ content: noPolicy, masterPlanId: "p", lastGeneratedWeek: 1 }), /policy/i);
  const noAvailability = storedContentFixture();
  delete noAvailability.availability;
  assert.throws(() => fromStoredContent({ content: noAvailability, masterPlanId: "p", lastGeneratedWeek: 1 }), /availability/);
});

test("fromStoredContent：坏 goal（finish_only 目标）在 goal 段就被拦下", () => {
  const content = storedContentFixture();
  const goal = content.goal as Record<string, unknown>;
  goal.target_time = "finish_only";
  assert.throws(() => fromStoredContent({ content, masterPlanId: "p", lastGeneratedWeek: 1 }), /target_time/);
});

// ── storedWeeklyDocOf（#858 PR-C 下半：Go 落库剥掉 schema/week_name 的读回适配）──

test("storedWeeklyDocOf：按行身份回填 schema/week_name 后严格 parse 通过", () => {
  const doc = createTestWeeklyPlanDoc(2); // 2026-08-17 那周（week 2）
  // Go validateAppliedWeeklyPlan 落库前剥掉两个身份键
  const stored: Record<string, unknown> = { ...doc };
  delete stored.schema;
  delete stored.week_name;
  const parsed = storedWeeklyDocOf(stored, "2026-08-17");
  assert.equal(parsed.schema, "weekly-plan/v1");
  assert.equal(parsed.week_name, "2026-08-17_08-23");
  assert.equal(parsed.week_index, 2);
  // 原样带身份键的文档也照常通过（回填不覆盖已有值）
  assert.equal(storedWeeklyDocOf(doc, "2026-08-17").week_name, doc.week_name);
});

test("storedWeeklyDocOf：坏形状（缺 sessions）照常被严格层拒绝", () => {
  assert.throws(() => storedWeeklyDocOf({ notes_md: null }, "2026-08-17"), /sessions/);
  assert.throws(() => storedWeeklyDocOf("junk", "2026-08-17"));
});
