import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoadPlan, LoadWeek } from "@stride/contract";
import { evaluateAdjustWindow, weekNumberOf, type ExistingWeekRef } from "./window.js";

/**
 * 调整窗口推导单测（#858 PR-C）：批中→剩余周窗口；事件周=批末（无可见剩余
 * 周）→ no_op；生成段落后当前周 → no_op；空 weekly 行 → no_op；赛季结束 →
 * no_op；周日触发（明日=下周一）→ 窗口自下周起且无追赶冻结。
 */

const PLAN_START = "2026-10-05"; // 周一

/** 10 周骨架：块 [1-4]（foundation）[5-8]（early_quality）[9-10]（final_quality+赛周）。 */
function skeleton(): LoadPlan {
  const week = (no: number, block: number, canonical: LoadWeek["canonical"], role: LoadWeek["role"]): LoadWeek => ({
    week: no,
    canonical,
    block,
    role,
    km: 60 + no,
    lr: 20,
    q: 2,
  });
  return {
    weeks: [
      ...[1, 2, 3, 4].map((no) => week(no, 1, "foundation", no === 4 ? "absorb" : "progress")),
      ...[5, 6, 7, 8].map((no) => week(no, 2, "early_quality", no === 8 ? "absorb" : "progress")),
      week(9, 3, "final_quality", "taper"),
      { ...week(10, 3, "final_quality", "race"), lr: null },
    ],
    blocks: [
      { block: 1, canonical: "foundation", start_week: 1, end_week: 4, absorb_weeks: [4], boundary: "phase_start" },
      { block: 2, canonical: "early_quality", start_week: 5, end_week: 8, absorb_weeks: [8], boundary: "phase_start" },
      { block: 3, canonical: "final_quality", start_week: 9, end_week: 10, absorb_weeks: [], boundary: "phase_start" },
    ],
    recovery_policy: [],
    strength_policy: [],
    checks: [],
    milestones: [],
  };
}

const rows = (weeks: number[]): ExistingWeekRef[] =>
  weeks.map((no) => ({ weekStart: addWeeks(PLAN_START, no - 1), week: no, km: 60 + no }));

function addWeeks(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 7 * 86_400_000).toISOString().slice(0, 10);
}

test("批中：事件周=第 5 周、当前第 6 周（周三）→ 窗口 [6,8] 含当前周（catch_up 冻结语义）", () => {
  const decision = evaluateAdjustWindow({
    skeleton: skeleton(),
    planStartMonday: PLAN_START,
    asOf: "2026-11-11T09:00:00.000+08:00", // 2026-11-11 周三=第 6 周（11-09~11-15）
    lastGeneratedWeek: 8,
    eventWeekStart: addWeeks(PLAN_START, 4), // 第 5 周周一 2026-11-02
    existingWeeks: rows([1, 2, 3, 4, 5, 6, 7, 8]),
  });
  assert.equal(decision.kind, "window");
  if (decision.kind === "window") {
    assert.equal(decision.window.startWeek, 6);
    assert.equal(decision.window.endWeek, 8);
    assert.equal(decision.window.mode, "catch_up", "窗口含当前周 → 追赶冻结生效");
  }
});

test("批中（事件周更早）：起点夹到明日所在周，不回补事件周+1 之前的过去周", () => {
  const decision = evaluateAdjustWindow({
    skeleton: skeleton(),
    planStartMonday: PLAN_START,
    asOf: "2026-11-11T09:00:00.000+08:00", // 第 6 周
    lastGeneratedWeek: 8,
    eventWeekStart: addWeeks(PLAN_START, 2), // 第 3 周（老偏差）
    existingWeeks: rows([1, 2, 3, 4, 5, 6, 7, 8]),
  });
  assert.equal(decision.kind, "window");
  if (decision.kind === "window") assert.equal(decision.window.startWeek, 6);
});

test("事件周=批末且无更多已生成周 → no_op（当前周已是批次末，出新块归滚动生成）", () => {
  const decision = evaluateAdjustWindow({
    skeleton: skeleton(),
    planStartMonday: PLAN_START,
    asOf: "2026-11-04T09:00:00.000+08:00", // 第 5 周
    lastGeneratedWeek: 4,
    eventWeekStart: addWeeks(PLAN_START, 3), // 第 4 周=块 1 末
    existingWeeks: rows([1, 2, 3, 4]),
  });
  assert.equal(decision.kind, "no_op");
  if (decision.kind === "no_op") assert.match(decision.reason, /批次末|剩余周/);
});

test("生成段落后当前周（lastGeneratedWeek < 起点）→ no_op", () => {
  const decision = evaluateAdjustWindow({
    skeleton: skeleton(),
    planStartMonday: PLAN_START,
    asOf: "2026-11-11T09:00:00.000+08:00", // 第 6 周
    lastGeneratedWeek: 5, // 掉队：第 6 周还没生成（归 rolling 追赶，不归调整）
    eventWeekStart: addWeeks(PLAN_START, 4), // 第 5 周
    existingWeeks: rows([1, 2, 3, 4, 5]),
  });
  assert.equal(decision.kind, "no_op");
});

test("无已落库 weekly 行 → no_op（只改已可见周，无行可改）", () => {
  const decision = evaluateAdjustWindow({
    skeleton: skeleton(),
    planStartMonday: PLAN_START,
    asOf: "2026-11-11T09:00:00.000+08:00",
    lastGeneratedWeek: 8,
    eventWeekStart: addWeeks(PLAN_START, 4),
    existingWeeks: [],
  });
  assert.equal(decision.kind, "no_op");
});

test("赛季结束（当前周越过比赛周）→ no_op", () => {
  const decision = evaluateAdjustWindow({
    skeleton: skeleton(),
    planStartMonday: PLAN_START,
    asOf: "2026-12-23T09:00:00.000+08:00", // 第 12 周（比赛周=第 10 周）
    lastGeneratedWeek: 10,
    eventWeekStart: addWeeks(PLAN_START, 9),
    existingWeeks: rows([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
  });
  assert.equal(decision.kind, "no_op");
  if (decision.kind === "no_op") assert.match(decision.reason, /比赛周/);
});

test("周日触发（明日=下周一）：窗口自下周起，boundary 模式（无需追赶冻结）", () => {
  const decision = evaluateAdjustWindow({
    skeleton: skeleton(),
    planStartMonday: PLAN_START,
    asOf: "2026-11-08T22:00:00.000+08:00", // 第 5 周周日
    lastGeneratedWeek: 8,
    eventWeekStart: addWeeks(PLAN_START, 4), // 第 5 周（刚结束）
    existingWeeks: rows([1, 2, 3, 4, 5, 6, 7, 8]),
  });
  assert.equal(decision.kind, "window");
  if (decision.kind === "window") {
    assert.equal(decision.window.startWeek, 6);
    assert.equal(decision.window.endWeek, 8);
    assert.equal(decision.window.mode, "boundary", "明日=下周一 → 窗口不含当前周");
  }
});

test("事件周+1 已是块末且生成到块末：窗口夹到单周 [8,8]（下一块归下一事件）", () => {
  const decision = evaluateAdjustWindow({
    skeleton: skeleton(),
    planStartMonday: PLAN_START,
    asOf: "2026-11-18T09:00:00.000+08:00", // 第 7 周（11-16~11-22）周三
    lastGeneratedWeek: 8,
    eventWeekStart: addWeeks(PLAN_START, 6), // 第 7 周
    existingWeeks: rows([1, 2, 3, 4, 5, 6, 7, 8]),
  });
  // 事件周=第 7 周 → 起点=第 8 周（>明日所在周 7）；第 8 周=块 2 末=lastGenerated → [8,8]。
  assert.equal(decision.kind, "window");
  if (decision.kind === "window") {
    assert.equal(decision.window.startWeek, 8);
    assert.equal(decision.window.endWeek, 8, "第 8 周=块 2 末，窗口夹到 [8,8]");
    assert.equal(decision.window.mode, "boundary", "窗口不含当前周（第 7 周）");
  }
});

test("weekNumberOf：计划周对齐（周一差 7 的整数倍）；事件周不在计划轴 → 负数触发 no_op", () => {
  assert.equal(weekNumberOf(PLAN_START, PLAN_START), 1);
  assert.equal(weekNumberOf(PLAN_START, addWeeks(PLAN_START, 6)), 7);
  assert.ok(weekNumberOf(PLAN_START, "2026-09-28") < 1, "计划开始前的周不在轴上");
  const decision = evaluateAdjustWindow({
    skeleton: skeleton(),
    planStartMonday: PLAN_START,
    asOf: "2026-11-11T09:00:00.000+08:00",
    lastGeneratedWeek: 8,
    eventWeekStart: "2026-09-28",
    existingWeeks: rows([1, 2, 3, 4, 5, 6, 7, 8]),
  });
  assert.equal(decision.kind, "no_op");
});
