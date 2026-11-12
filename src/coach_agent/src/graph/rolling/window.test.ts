import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoadPlan, LoadRole, LoadWeek } from "@stride/contract";
import { computeRollingWindow, currentWeekOf, evaluateRollingWindow } from "./window.js";

/**
 * 滚动批窗单测（#858）：边界触发 / 掉队追赶 mid-block / final_quality 整段 /
 * 比赛已过 / 全生成完 / 存量未用尽（no_op）/ lastGenerated=当前周（boundary）。
 */

/** 18 周骨架（对照 expand.ts 18 周实测块形 4/1/3/4/6）：foundation W1-8 / early W9-10 / transition W11-12 / final W13-18（taper W16-18）。 */
function skeleton18(): LoadPlan {
  const spec: Array<[number, string, number, LoadRole]> = [
    [1, "foundation", 1, "progress"],
    [2, "foundation", 1, "progress"],
    [3, "foundation", 1, "progress"],
    [4, "foundation", 1, "progress"],
    [5, "foundation", 2, "absorb"],
    [6, "foundation", 3, "progress"],
    [7, "foundation", 3, "progress"],
    [8, "foundation", 3, "progress"],
    [9, "early_quality", 4, "progress"],
    [10, "early_quality", 4, "progress"],
    [11, "transition_quality", 4, "progress"],
    [12, "transition_quality", 4, "progress"],
    [13, "final_quality", 5, "progress"],
    [14, "final_quality", 5, "progress"],
    [15, "final_quality", 5, "progress"],
    [16, "final_quality", 5, "taper"],
    [17, "final_quality", 5, "taper"],
    [18, "final_quality", 5, "race"],
  ];
  const weeks: LoadWeek[] = spec.map(([week, canonical, block, role]) => ({
    week,
    canonical: canonical as LoadWeek["canonical"],
    block,
    role,
    km: 60,
    lr: 20,
    q: 1,
  }));
  return {
    weeks,
    blocks: [
      { block: 1, canonical: "foundation", start_week: 1, end_week: 4, absorb_weeks: [], boundary: "phase_start" },
      { block: 2, canonical: "foundation", start_week: 5, end_week: 5, absorb_weeks: [5], boundary: "absorb_cut" },
      { block: 3, canonical: "foundation", start_week: 6, end_week: 8, absorb_weeks: [], boundary: "absorb_cut" },
      { block: 4, canonical: "early_quality", start_week: 9, end_week: 12, absorb_weeks: [], boundary: "phase_start" },
      { block: 5, canonical: "final_quality", start_week: 13, end_week: 18, absorb_weeks: [], boundary: "phase_start" },
    ],
    recovery_policy: [],
    strength_policy: [],
    checks: [],
    milestones: [],
  };
}

const PLAN_START = "2026-10-05"; // 周一

/** 第 week 周内的周三（批窗只看周一，取周内任一天都行，用周三钉真实在周中）。 */
const asOfWeek = (week: number) => {
  const d = new Date(`${PLAN_START}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (week - 1) * 7 + 2);
  return d.toISOString();
};

test("currentWeekOf：第 1 周=planStartMonday 当周，周一/周日归属同一周", () => {
  assert.equal(currentWeekOf(PLAN_START, `${PLAN_START}T01:00:00+08:00`), 1);
  assert.equal(currentWeekOf(PLAN_START, "2026-10-11T23:00:00+08:00"), 1);
  assert.equal(currentWeekOf(PLAN_START, "2026-11-16T08:00:00+08:00"), 7);
  // asOf 早于计划起点（当前周一=起点前一周）→ 周号 0（< lastGeneratedWeek → no_op）
  assert.equal(currentWeekOf(PLAN_START, "2026-09-28T12:00:00+08:00"), 0);
});

test("边界触发：练到存量最后生成周（第 6 周）→ boundary，批=下一块 [7,8]", () => {
  const window = computeRollingWindow({ skeleton: skeleton18(), planStartMonday: PLAN_START, asOf: asOfWeek(6), lastGeneratedWeek: 6 });
  assert.ok(window);
  assert.deepEqual([window.startWeek, window.endWeek], [7, 8]);
  assert.equal(window.mode, "boundary");
  assert.match(window.reason, /边界触发/);
});

test("掉队追赶 mid-block：currentWeek=8 落在块 [6,8] 中段 → catch_up，块前段不回补=[8,8]", () => {
  const window = computeRollingWindow({ skeleton: skeleton18(), planStartMonday: PLAN_START, asOf: asOfWeek(8), lastGeneratedWeek: 6 });
  assert.ok(window);
  assert.deepEqual([window.startWeek, window.endWeek], [8, 8]);
  assert.equal(window.mode, "catch_up");
  assert.match(window.reason, /掉队追赶/);
  assert.match(window.reason, /不回补/);
});

test("final_quality 整段：next 落在 final_quality → 批=[next, raceWeek]（含 taper）", () => {
  const boundary = computeRollingWindow({ skeleton: skeleton18(), planStartMonday: PLAN_START, asOf: asOfWeek(12), lastGeneratedWeek: 12 });
  assert.ok(boundary);
  assert.deepEqual([boundary.startWeek, boundary.endWeek], [13, 18]);
  assert.match(boundary.reason, /含 taper/);
  // 掉队进入 final_quality 中段（第 15 周）同样取到比赛周整段收尾
  const catchUp = computeRollingWindow({ skeleton: skeleton18(), planStartMonday: PLAN_START, asOf: asOfWeek(15), lastGeneratedWeek: 12 });
  assert.ok(catchUp);
  assert.deepEqual([catchUp.startWeek, catchUp.endWeek], [15, 18]);
  assert.equal(catchUp.mode, "catch_up");
});

test("比赛已过：currentWeek=19 → null（赛季滚动结束）", () => {
  const decision = evaluateRollingWindow({ skeleton: skeleton18(), planStartMonday: PLAN_START, asOf: asOfWeek(19), lastGeneratedWeek: 12 });
  assert.equal(decision.kind, "no_op");
  assert.match(decision.reason, /已越过比赛周/);
});

test("全生成完：lastGeneratedWeek=18（比赛周）→ null", () => {
  const decision = evaluateRollingWindow({ skeleton: skeleton18(), planStartMonday: PLAN_START, asOf: asOfWeek(10), lastGeneratedWeek: 18 });
  assert.equal(decision.kind, "no_op");
  assert.match(decision.reason, /全量完成/);
});

test("存量未用尽：首批中段（currentWeek=3 < lastGeneratedWeek=6）→ no_op", () => {
  const decision = evaluateRollingWindow({ skeleton: skeleton18(), planStartMonday: PLAN_START, asOf: asOfWeek(3), lastGeneratedWeek: 6 });
  assert.equal(decision.kind, "no_op");
  assert.match(decision.reason, /未到滚动边界/);
  assert.equal(computeRollingWindow({ skeleton: skeleton18(), planStartMonday: PLAN_START, asOf: asOfWeek(3), lastGeneratedWeek: 6 }), null);
});

test("lastGenerated=当前周=比赛周前一周 → boundary 进入最后一周，批=[raceWeek,raceWeek]", () => {
  const window = computeRollingWindow({ skeleton: skeleton18(), planStartMonday: PLAN_START, asOf: asOfWeek(17), lastGeneratedWeek: 17 });
  assert.ok(window);
  assert.deepEqual([window.startWeek, window.endWeek], [18, 18]);
  assert.equal(window.mode, "boundary");
});

test("比赛周角色缺失时 raceWeek 兜底最末周", () => {
  const skeleton = skeleton18();
  skeleton.weeks = skeleton.weeks.map((week) => (week.week === 18 ? { ...week, role: "taper" as LoadRole } : week));
  const decision = evaluateRollingWindow({ skeleton, planStartMonday: PLAN_START, asOf: asOfWeek(6), lastGeneratedWeek: 6 });
  // 第 7 周非 final_quality，按块 [6,8] 夹到 [7,8]；raceWeek 兜底不影响本例
  assert.equal(decision.kind, "window");
});
