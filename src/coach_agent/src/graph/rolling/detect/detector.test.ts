import assert from "node:assert/strict";
import { test } from "node:test";
import { type RunWorkout, type WeeklyPlan, weekFolder } from "@stride/contract";
import { assessWeek, assessWeeks } from "./detector.js";
import type { ActivityRef } from "./matcher.js";

/**
 * 周偏差判定单测（#858 PR-B，纯函数）：完美执行 / 练差 / 缺课 / 跑了别的 /
 * 超量 / 混合周缺课优先 / 日期漂移与距离容差 / 阈值边界（79.9↔80%、124↔125%、4.9↔5%）。
 * 夹具用确定性周文档（周一 2026-11-02：周二 T 节奏、周四 I 间歇、周日 LR 长跑）。
 */

const WEEK_START = "2026-11-02"; // 周一
const MON = "2026-11-02";
const TUE = "2026-11-03";
const THU = "2026-11-05";
const FRI = "2026-11-06";
const SAT = "2026-11-07";
const SUN = "2026-11-08";

/** T 节奏课 spec：热身 2km + work 20min @245-255（带中点 250）+ 放松 2km。 */
function tempoSpec(date: string): RunWorkout {
  return {
    schema: "run-workout/v1",
    name: "节奏跑 20 分钟",
    date,
    note: null,
    type: "T",
    purpose: null,
    blocks: [
      {
        repeat: 1,
        steps: [
          { step_kind: "warmup", duration: { kind: "distance_m", value: 2000 }, target: { kind: "open", low: null, high: null }, note: null, hr_cap_bpm: null },
          { step_kind: "work", duration: { kind: "time_s", value: 1200 }, target: { kind: "pace_s_km", low: 245, high: 255 }, note: null, hr_cap_bpm: null },
          {
            step_kind: "cooldown",
            duration: { kind: "distance_m", value: 2000 },
            target: { kind: "open", low: null, high: null },
            note: null,
            hr_cap_bpm: null,
          },
        ],
      },
    ],
  };
}

/** I 间歇课 spec：热身 2km + 6×[800m @205-215（带中点 210）+ 休息 120s] + 放松 2km（合计 8.8km）。 */
function intervalSpec(date: string): RunWorkout {
  return {
    schema: "run-workout/v1",
    name: "间歇 6×800m",
    date,
    note: null,
    type: "I",
    purpose: null,
    blocks: [
      {
        repeat: 1,
        steps: [
          { step_kind: "warmup", duration: { kind: "distance_m", value: 2000 }, target: { kind: "open", low: null, high: null }, note: null, hr_cap_bpm: null },
        ],
      },
      {
        repeat: 6,
        steps: [
          { step_kind: "work", duration: { kind: "distance_m", value: 800 }, target: { kind: "pace_s_km", low: 205, high: 215 }, note: null, hr_cap_bpm: null },
          { step_kind: "rest", duration: { kind: "time_s", value: 120 }, target: { kind: "open", low: null, high: null }, note: null, hr_cap_bpm: null },
        ],
      },
      {
        repeat: 1,
        steps: [
          {
            step_kind: "cooldown",
            duration: { kind: "distance_m", value: 2000 },
            target: { kind: "open", low: null, high: null },
            note: null,
            hr_cap_bpm: null,
          },
        ],
      },
    ],
  };
}

/** LR 长跑 spec：25km @330-370。 */
function longRunSpec(date: string): RunWorkout {
  return {
    schema: "run-workout/v1",
    name: "长跑 25km",
    date,
    note: null,
    type: "LR",
    purpose: null,
    blocks: [
      {
        repeat: 1,
        steps: [
          {
            step_kind: "work",
            duration: { kind: "distance_m", value: 25000 },
            target: { kind: "pace_s_km", low: 330, high: 370 },
            note: null,
            hr_cap_bpm: null,
          },
        ],
      },
    ],
  };
}

type RunFixture = { date: string; summary: string; km: number; spec: RunWorkout };

/** 标准周夹具：周二 T 10km + 周四 I 8.8km + 周日 LR 25km（计划合计 43.8km）。 */
function standardRuns(): RunFixture[] {
  return [
    { date: TUE, summary: "节奏跑 20 分钟", km: 10, spec: tempoSpec(TUE) },
    { date: THU, summary: "间歇 6×800m", km: 8.8, spec: intervalSpec(THU) },
    { date: SUN, summary: "长跑 25km", km: 25, spec: longRunSpec(SUN) },
  ];
}

/** 两课周夹具：周二 T 10km + 周日 LR 25km（35km，阈值边界用）。 */
function tempoAndLongRuns(): RunFixture[] {
  return [
    { date: TUE, summary: "节奏跑 20 分钟", km: 10, spec: tempoSpec(TUE) },
    { date: SUN, summary: "长跑 25km", km: 25, spec: longRunSpec(SUN) },
  ];
}

function weekDoc(runs: RunFixture[], opts: { weekStart?: string; targetKm?: number } = {}): WeeklyPlan {
  const weekStart = opts.weekStart ?? WEEK_START;
  return {
    schema: "weekly-plan/v1",
    week_name: weekFolder(weekStart),
    sessions: runs.map((run, index) => ({
      schema: "plan-session/v1" as const,
      date: run.date,
      session_index: index,
      kind: "run" as const,
      summary: run.summary,
      notes_md: null,
      total_distance_m: run.km * 1000,
      total_duration_s: null,
      estimated_dose: null,
      spec: run.spec,
    })),
    nutrition: Array.from({ length: 7 }, (_, offset) => ({
      schema: "plan-nutrition/v1",
      date: shiftDay(weekStart, offset),
      kcal_target: null,
      carbs_g: null,
      protein_g: null,
      fat_g: null,
      water_ml: null,
      meals: [],
      notes_md: null,
    })),
    notes_md: null,
    coach_notes: "夹具周",
    ...(opts.targetKm != null ? { target_weekly_km_low: opts.targetKm } : {}),
  };
}

function act(day: string, opts: { km: number; pace?: number; cls?: string | null; name?: string }): ActivityRef {
  return {
    day,
    name: opts.name ?? `活动 ${day}`,
    distanceKm: opts.km,
    durationS: Math.round(opts.km * (opts.pace ?? 300)),
    avgPaceSKm: opts.pace ?? null,
    sessionClass: opts.cls ?? null,
  };
}

/** 与计划一一对应的「完美」活动（配速=带中点）。 */
function perfectActivities(paceOverrides: { tuePace?: number; thuPace?: number } = {}): ActivityRef[] {
  return [
    act(TUE, { km: 10, pace: paceOverrides.tuePace ?? 250, cls: "quality" }),
    act(THU, { km: 8.8, pace: paceOverrides.thuPace ?? 210, cls: "quality" }),
    act(SUN, { km: 25, cls: "long_easy" }),
  ];
}

test("完美执行 → within_tolerance、preselect null、全部 high confidence", () => {
  const deviation = assessWeek({ weekDoc: weekDoc(standardRuns()), activities: perfectActivities() });
  assert.equal(deviation.class, "within_tolerance");
  assert.equal(deviation.preselect, null);
  assert.equal(deviation.severe, false);
  assert.equal(deviation.qualityDone, 2);
  assert.equal(deviation.qualityPlanned, 2);
  assert.equal(deviation.longRunDone, true);
  assert.equal(deviation.plannedKm, 43.8);
  assert.equal(deviation.actualKm, 43.8);
  assert.equal(deviation.deliveryRatio, 1);
  assert.ok(deviation.detail.every((match) => match.confidence === "high"));
  assert.equal(deviation.unmatched.length, 0);
  assert.match(deviation.evidence, /计划 2 节质量课完成 2/);
  assert.match(deviation.evidence, /周量 43.8\/43.8km（100%）/);
});

test("质量课齐但配速慢 8% → poor_pace / pace_unmet", () => {
  const deviation = assessWeek({
    weekDoc: weekDoc(standardRuns()),
    activities: perfectActivities({ tuePace: 270 }), // (270-250)/250 = +8%
  });
  assert.equal(deviation.class, "poor_pace");
  assert.equal(deviation.preselect, "pace_unmet");
  assert.equal(deviation.severe, false);
  assert.match(deviation.evidence, /配速偏慢 8%/);
});

test("质量课缺 1（无其它活动）+ 长跑在 → volume_short / no_time", () => {
  const activities = [act(TUE, { km: 10, pace: 250, cls: "quality" }), act(SUN, { km: 25, cls: "long_easy" })];
  const deviation = assessWeek({ weekDoc: weekDoc(standardRuns()), activities });
  assert.equal(deviation.class, "volume_short");
  assert.equal(deviation.preselect, "no_time");
  assert.equal(deviation.qualityDone, 1);
  assert.equal(deviation.qualityPlanned, 2);
  assert.equal(deviation.longRunDone, true);
  assert.equal(deviation.severe, false);
});

test("质量课全缺 + LR 缺（整周没跑）→ missed / no_time / severe", () => {
  const deviation = assessWeek({ weekDoc: weekDoc(standardRuns()), activities: [] });
  assert.equal(deviation.class, "missed");
  assert.equal(deviation.preselect, "no_time"); // 严重也不预判受伤，让用户自己选
  assert.equal(deviation.severe, true);
  assert.equal(deviation.qualityDone, 0);
  assert.equal(deviation.longRunDone, false);
  assert.equal(deviation.actualKm, 0);
  assert.match(deviation.evidence, /计划 2 节质量课完成 0/);
  assert.match(deviation.evidence, /长跑未跑/);
});

test("计划质量课缺 + 周里有一场 class=race 的 unmatched 30km → ran_other / ran_other", () => {
  const activities = [
    act(THU, { km: 8.8, pace: 210, cls: "quality" }),
    act(SUN, { km: 25, cls: "long_easy" }),
    act(SAT, { km: 30, cls: "race", name: "周末越野赛" }), // 与任何计划课不可配：日期/课型都不容
  ];
  const deviation = assessWeek({ weekDoc: weekDoc(standardRuns()), activities });
  assert.equal(deviation.class, "ran_other");
  assert.equal(deviation.preselect, "ran_other");
  assert.equal(deviation.qualityDone, 1); // 周二 T 缺
  assert.equal(deviation.unmatched.length, 1);
  assert.equal(deviation.unmatched[0]?.name, "周末越野赛");
  assert.match(deviation.evidence, /另有 30km 强度活动未对上计划课/);
});

test("周量 135% → over_delivery / over_delivered", () => {
  const activities = [...perfectActivities(), act(MON, { km: 8, cls: "easy" }), act(FRI, { km: 7, cls: "easy" })];
  const deviation = assessWeek({ weekDoc: weekDoc(standardRuns()), activities });
  assert.equal(deviation.actualKm, 58.8);
  assert.ok(deviation.deliveryRatio >= 1.25);
  assert.equal(deviation.class, "over_delivery");
  assert.equal(deviation.preselect, "over_delivered");
  assert.equal(deviation.unmatched.length, 2); // 两条 easy 未对上，但不算「跑了别的」证据
});

test("混合周：质量课慢 8% 且 LR 缺 → 缺课优先 volume_short，evidence 如实提配速偏慢", () => {
  const activities = [act(TUE, { km: 10, pace: 270, cls: "quality" }), act(THU, { km: 8.8, pace: 210, cls: "quality" })];
  const deviation = assessWeek({ weekDoc: weekDoc(standardRuns()), activities });
  assert.equal(deviation.class, "volume_short"); // 缺课 > 练差
  assert.equal(deviation.preselect, "no_time");
  assert.equal(deviation.longRunDone, false);
  assert.match(deviation.evidence, /配速偏慢 8%/); // 如实记录，不吞掉
  assert.equal(deviation.severe, true); // ratio 18.8/43.8 ≈ 43% < 60%
});

test("日期漂移 ±1 天仍可配（medium confidence）；距离差 50% 不配（LR 缺）", () => {
  // 周二 T 挪到周三跑（+1 日，距离同）：medium 配上；周日 LR 只跑了 12.5km（差 50%）：不配。
  const activities = [
    act("2026-11-04", { km: 10, pace: 250, cls: "quality" }),
    act(THU, { km: 8.8, pace: 210, cls: "quality" }),
    act(SUN, { km: 12.5, cls: "long_easy" }),
  ];
  const deviation = assessWeek({ weekDoc: weekDoc(standardRuns()), activities });
  const tempo = deviation.detail.find((match) => match.planned.summary === "节奏跑 20 分钟");
  assert.equal(tempo?.confidence, "medium");
  assert.ok(tempo?.activity);
  const longRun = deviation.detail.find((match) => match.planned.summary === "长跑 25km");
  assert.equal(longRun?.activity, null);
  assert.equal(deviation.longRunDone, false);
  assert.equal(deviation.class, "volume_short"); // LR 部分缺
  assert.equal(deviation.unmatched.length, 1); // 12.5km long_easy 没对上任何计划课
});

test("边界：周完成率 79.9% → volume_short（课齐量差，volume_unmet）；80% → within_tolerance", () => {
  const runs = tempoAndLongRuns(); // T 10km + LR 25km = 35km
  const doc = weekDoc(runs);
  // T 精确完成；LR 跑 17.965km（距离容差内仍可配）→ 27.965/35 = 79.9%。
  const shortfall = assessWeek({
    weekDoc: doc,
    activities: [act(TUE, { km: 10, pace: 250, cls: "quality" }), act(SUN, { km: 17.965, cls: "long_easy" })],
  });
  assert.equal(shortfall.class, "volume_short");
  assert.equal(shortfall.preselect, "volume_unmet"); // 无缺课 → 量没练完
  assert.equal(shortfall.longRunDone, true);
  // LR 跑 18km → 28/35 = 80.0%，不小于 80% 不算没完成。
  const atThreshold = assessWeek({
    weekDoc: doc,
    activities: [act(TUE, { km: 10, pace: 250, cls: "quality" }), act(SUN, { km: 18, cls: "long_easy" })],
  });
  assert.equal(atThreshold.class, "within_tolerance");
  assert.equal(atThreshold.preselect, null);
});

test("边界：周量 124% → within_tolerance；125% → over_delivery", () => {
  const runs = tempoAndLongRuns(); // 35km
  const doc = weekDoc(runs);
  const base = [act(TUE, { km: 10, pace: 250, cls: "quality" }), act(SUN, { km: 25, cls: "long_easy" })];
  const under = assessWeek({ weekDoc: doc, activities: [...base, act(MON, { km: 8.4, cls: "easy" })] }); // 43.4/35=124%
  assert.equal(under.class, "within_tolerance");
  const atThreshold = assessWeek({ weekDoc: doc, activities: [...base, act(MON, { km: 8.75, cls: "easy" })] }); // 43.75/35=125%
  assert.equal(atThreshold.class, "over_delivery");
  assert.equal(atThreshold.preselect, "over_delivered");
});

test("边界：质量课配速慢 4.9% → within_tolerance；5.0% → poor_pace", () => {
  const runs = tempoAndLongRuns();
  const doc = weekDoc(runs);
  const longRun = act(SUN, { km: 25, cls: "long_easy" });
  const under = assessWeek({ weekDoc: doc, activities: [act(TUE, { km: 10, pace: 262.25, cls: "quality" }), longRun] }); // +4.9%
  assert.equal(under.class, "within_tolerance");
  const atThreshold = assessWeek({ weekDoc: doc, activities: [act(TUE, { km: 10, pace: 262.5, cls: "quality" }), longRun] }); // +5.0%
  assert.equal(atThreshold.class, "poor_pace");
  assert.equal(atThreshold.preselect, "pace_unmet");
});

test("计划距离缺失时 plannedKm 退回 target_weekly_km_low（口径兜底）", () => {
  const runs = standardRuns().map((run) => ({ ...run, km: 0 })); // total_distance_m=0
  const doc = weekDoc(runs, { targetKm: 43.8 });
  const deviation = assessWeek({ weekDoc: doc, activities: perfectActivities() });
  assert.equal(deviation.plannedKm, 43.8);
  assert.equal(deviation.class, "within_tolerance");
});

test("周外活动不计入本周（day 对齐 week_name）", () => {
  const activities = [...perfectActivities(), act("2026-11-09", { km: 20, cls: "long_easy" })]; // 下周一
  const deviation = assessWeek({ weekDoc: weekDoc(standardRuns()), activities });
  assert.equal(deviation.actualKm, 43.8);
  assert.equal(deviation.unmatched.length, 0);
});

test("assessWeeks：多周批处理，各周只取当周活动", () => {
  const thisWeek = weekDoc(standardRuns());
  const nextWeek = weekDoc(
    standardRuns().map((run) => ({ ...run, date: shiftDay(run.date, 7) })),
    { weekStart: shiftDay(WEEK_START, 7) },
  );
  const deviations = assessWeeks({ weekDocs: [thisWeek, nextWeek], activities: perfectActivities() });
  assert.equal(deviations.length, 2);
  assert.equal(deviations[0]?.class, "within_tolerance");
  assert.equal(deviations[1]?.class, "missed"); // 下周没活动
  assert.equal(deviations[1]?.severe, true);
});

/** YYYY-MM-DD 平移 days 天（夹具用，UTC 无时区歧义）。 */
function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
