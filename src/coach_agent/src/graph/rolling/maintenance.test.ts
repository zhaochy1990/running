import assert from "node:assert/strict";
import test from "node:test";
import { addDays } from "@stride/contract";
import { buildMaintenanceWeek, isMaintenanceWeeklyDoc, MAINTENANCE_COACH_NOTE_PREFIX, type MaintenanceInput } from "./maintenance.js";

/**
 * 维持课构造单测（#858 PR-D）：确定性零 LLM——分布/上限/字段/schema 硬校验。
 * fixture 口径：planStart=2026-08-10（周一，与 rolling 测试族一致）。
 */

const PLAN_START = "2026-08-10";

function input(overrides: Partial<MaintenanceInput> = {}): MaintenanceInput {
  return {
    planStartMonday: PLAN_START,
    weekStart: "2026-09-14", // 第 6 周周一
    weeklyRunDaysMax: 5,
    maintenanceKm: 30,
    strengthPerWeek: 2,
    ...overrides,
  };
}

const r1 = (x: number) => Math.round(x * 10) / 10;

test("分布：runDays 天跑步 + 长跑上限 + E 均分 + rest 补齐 + 总量精确", () => {
  const doc = buildMaintenanceWeek(input());
  const runs = doc.sessions.filter((session) => session.kind === "run");
  assert.equal(runs.length, 5, "跑步天数=weeklyRunDaysMax");
  // 长跑在周日（offsets 最后一位=6）：≤min(14, 30×25%)=7.5
  const longRun = runs.at(-1)!;
  assert.equal(longRun.date, "2026-09-20");
  const longKm = (longRun.total_distance_m ?? 0) / 1000;
  assert.ok(longKm <= 7.5 + 1e-9, `长跑 ${longKm}km 超上限 7.5`);
  // E 均分：其余 4 天分 22.5 → 每节 5.6/5.6/5.6/5.7（尾差收口最后一节）
  const easyKms = runs.slice(0, -1).map((session) => (session.total_distance_m ?? 0) / 1000);
  for (const km of easyKms) assert.ok(Math.abs(km - 5.625) <= 0.15, `E 节 ${km}km 偏离均分值`);
  // 总量精确=maintenanceKm（0.1 精度内）
  const totalKm = r1(runs.reduce((total, session) => total + (session.total_distance_m ?? 0) / 1000, 0));
  assert.equal(totalKm, 30);
  // rest 补齐：5 跑日 + 2 力量（落在 2 个无跑日）→ 全周 7 天无空闲，rest=0
  const rest = doc.sessions.filter((session) => session.kind === "rest");
  assert.equal(rest.length, 0, "7 天 − 5 跑日 − 2 力量（自由日）= 0 休息日");
  assert.equal(doc.sessions.length, 7);
  // 每天至少一个会话
  const days = new Set(doc.sessions.map((session) => session.date));
  for (let offset = 0; offset < 7; offset += 1) assert.ok(days.has(addDays("2026-09-14", offset)));
});

test("去质量课：全部 run=E（summary 前缀+配速口径），spec=null，不给配速带", () => {
  const doc = buildMaintenanceWeek(input());
  for (const session of doc.sessions) {
    if (session.kind !== "run") continue;
    assert.match(session.summary, /^E 有氧/);
    assert.match(session.summary, /轻松体感\/E 心率区/);
    assert.equal(session.spec, null, "维持课 spec=null（确定性，无 workout 结构）");
  }
});

test("力量保留：strengthPerWeek 节力量，优先落在无跑日", () => {
  const doc = buildMaintenanceWeek(input({ weeklyRunDaysMax: 4, strengthPerWeek: 2 }));
  const strength = doc.sessions.filter((session) => session.kind === "strength");
  assert.equal(strength.length, 2);
  const runDays = new Set(doc.sessions.filter((session) => session.kind === "run").map((session) => session.date));
  for (const session of strength) assert.ok(!runDays.has(session.date), "力量落在无跑日");
  assert.equal(strength[0]!.total_duration_s, 40 * 60);
  // strides 备注 1 次（首节 E）
  const strides = doc.sessions.filter((session) => session.notes_md?.includes("strides"));
  assert.equal(strides.length, 1);
});

test("周文档字段：week_index 推算 / phase_name=maintenance / 目标 km / coach_notes 标记", () => {
  const doc = buildMaintenanceWeek(input());
  assert.equal(doc.week_index, 6, "2026-09-14 是 2026-08-10 起第 6 周");
  assert.equal(doc.phase_name, "maintenance");
  assert.equal(doc.target_weekly_km_low, 30);
  assert.equal(doc.target_weekly_km_high, 30);
  assert.match(doc.coach_notes ?? "", new RegExp(`^${MAINTENANCE_COACH_NOTE_PREFIX}（E 有氧为主`));
  assert.equal(isMaintenanceWeeklyDoc(doc), true);
  assert.equal(isMaintenanceWeeklyDoc({ coach_notes: "基础期有氧发展" }), false);
  assert.equal(isMaintenanceWeeklyDoc({ coach_notes: null }), false);
  // phaseGoalNote 拼接
  const noted = buildMaintenanceWeek(input({ phaseGoalNote: "原第 6 周为专项强度周" }));
  assert.match(noted.coach_notes ?? "", /原第 6 周为专项强度周$/);
});

test("营养骨架：7 天全 null 空行（契约 length=7 必填）", () => {
  const doc = buildMaintenanceWeek(input());
  assert.equal(doc.nutrition.length, 7);
  for (let offset = 0; offset < 7; offset += 1) assert.equal(doc.nutrition[offset]!.date, addDays("2026-09-14", offset));
});

test("schema 硬校验 + 估距/时长口径（E 330s/km 兜底）", () => {
  const doc = buildMaintenanceWeek(input());
  // buildMaintenanceWeek 出口即 WeeklyPlanSchema.parse（硬校验），能返回即已过。
  const run = doc.sessions.find((session) => session.kind === "run")!;
  const km = (run.total_distance_m ?? 0) / 1000;
  assert.equal(run.total_duration_s, Math.round(km * 330), "估时=km×330s/km 兜底");
});

test("边界：runDays=1 唯一跑日承载全量；runDays=7 全周有跑", () => {
  const single = buildMaintenanceWeek(input({ weeklyRunDaysMax: 1, maintenanceKm: 8, strengthPerWeek: 0 }));
  const runs = single.sessions.filter((session) => session.kind === "run");
  assert.equal(runs.length, 1);
  assert.equal(r1((runs[0]!.total_distance_m ?? 0) / 1000), 8);
  assert.equal(runs[0]!.date, "2026-09-20", "唯一跑日在周日");
  assert.equal(single.sessions.filter((session) => session.kind === "rest").length, 6);

  const full = buildMaintenanceWeek(input({ weeklyRunDaysMax: 7, maintenanceKm: 50, strengthPerWeek: 2 }));
  assert.equal(full.sessions.filter((session) => session.kind === "run").length, 7);
  // 力量无处可叠（无自由日）→ 叠跑日 session_index=1（schema 去重规则过）
  const strength = full.sessions.filter((session) => session.kind === "strength");
  assert.equal(strength.length, 2);
  assert.equal(
    strength.every((session) => session.session_index === 1),
    true,
  );
  // 长跑上限 min(14, 12.5)=12.5
  const longKm = (full.sessions.filter((session) => session.kind === "run").at(-1)!.total_distance_m ?? 0) / 1000;
  assert.ok(longKm <= 12.5 + 1e-9);
});

test("长跑 14km 硬上限：高量周（25% 周量>14）取 14", () => {
  const doc = buildMaintenanceWeek(input({ maintenanceKm: 70, weeklyRunDaysMax: 6 }));
  const longRun = doc.sessions.filter((session) => session.kind === "run").at(-1)!;
  assert.equal(r1((longRun.total_distance_m ?? 0) / 1000), 14);
});

test("非法输入：非正量 / 非周一 / 早于计划起点", () => {
  assert.throws(() => buildMaintenanceWeek(input({ maintenanceKm: 0 })), /maintenanceKm/);
  assert.throws(() => buildMaintenanceWeek(input({ weekStart: "2026-09-15" })), /周一/);
  assert.throws(() => buildMaintenanceWeek(input({ weekStart: "2026-08-03" })), /planStartMonday/);
});
