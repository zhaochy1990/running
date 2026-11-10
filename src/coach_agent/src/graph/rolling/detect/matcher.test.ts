import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunWorkout } from "@stride/contract";
import { type ActivityRef, matchWeekSessions, type PlannedSessionRef, plannedFamilyOf, qualityBandMidpointSPerKm } from "./matcher.js";

/**
 * 计划课↔活动匹配单测（#858 PR-B，纯函数）：同日/±1 日漂移/距离容差/课型相容表/
 * null class 通配/贪心一对一/paceDeltaPct 符号与边界。
 */

const TUE = "2026-11-03";
const WED = "2026-11-04";
const SUN = "2026-11-08";

/** 严格 run-workout/v1 最小合法块（单 work 步 + 配速带）。 */
function spec(date: string, name: string, type: RunWorkout["type"], work: { distanceM?: number; timeS?: number; pace: [number, number] }): RunWorkout {
  return {
    schema: "run-workout/v1",
    name,
    date,
    note: null,
    type,
    purpose: null,
    blocks: [
      {
        repeat: 1,
        steps: [
          {
            step_kind: "work",
            duration: work.distanceM != null ? { kind: "distance_m", value: work.distanceM } : { kind: "time_s", value: work.timeS as number },
            target: { kind: "pace_s_km", low: work.pace[0], high: work.pace[1] },
            note: null,
            hr_cap_bpm: null,
          },
        ],
      },
    ],
  };
}

function plannedRun(date: string, summary: string, opts: { km?: number; spec?: RunWorkout | null } = {}): PlannedSessionRef {
  return { date, kind: "run", summary, totalDistanceM: opts.km != null ? opts.km * 1000 : null, spec: opts.spec ?? null };
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

test("完美同日同类：一对一全配，置信度 high", () => {
  const quality = plannedRun(TUE, "节奏跑 20 分钟", { km: 10, spec: spec(TUE, "节奏跑 20 分钟", "T", { timeS: 1200, pace: [245, 255] }) });
  const long = plannedRun(SUN, "长跑 25km", { km: 25, spec: spec(SUN, "长跑 25km", "LR", { distanceM: 25000, pace: [330, 370] }) });
  const result = matchWeekSessions([quality, long], [act(TUE, { km: 10, pace: 250, cls: "quality" }), act(SUN, { km: 25, cls: "long_easy" })]);
  assert.equal(result.matches.length, 2);
  assert.ok(result.matches.every((match) => match.activity !== null && match.confidence === "high"));
  assert.equal(result.unmatchedActivities.length, 0);
  assert.equal(plannedFamilyOf(quality), "quality");
  assert.equal(plannedFamilyOf(long), "long");
});

test("日期漂移 ±1 天仍可配（medium confidence）", () => {
  const quality = plannedRun(TUE, "间歇 6×800m", { km: 8, spec: spec(TUE, "间歇 6×800m", "I", { distanceM: 4800, pace: [205, 215] }) });
  const result = matchWeekSessions([quality], [act(WED, { km: 8, cls: "quality" })]);
  assert.equal(result.matches[0]?.confidence, "medium");
  assert.ok(result.matches[0]?.activity);
  assert.equal(result.matches[0]?.activity.day, WED);
});

test("距离差 50% 不配：计划课与活动双双落空", () => {
  const long = plannedRun(SUN, "长跑 25km", { km: 25, spec: spec(SUN, "长跑 25km", "LR", { distanceM: 25000, pace: [330, 370] }) });
  const result = matchWeekSessions([long], [act(SUN, { km: 12.5, cls: "long_easy" })]);
  assert.equal(result.matches[0]?.activity, null);
  assert.equal(result.matches[0]?.confidence, "none");
  assert.equal(result.unmatchedActivities.length, 1);
});

test("课型不相容不配：计划质量课 vs 活动轻松跑（同日同距）", () => {
  const quality = plannedRun(TUE, "节奏跑 20 分钟", { km: 10, spec: spec(TUE, "节奏跑 20 分钟", "T", { timeS: 1200, pace: [245, 255] }) });
  const result = matchWeekSessions([quality], [act(TUE, { km: 10, cls: "easy" })]);
  assert.equal(result.matches[0]?.activity, null);
  assert.equal(result.unmatchedActivities.length, 1);
});

test("legacy session_class 折叠后相容：tempo/interval 活动 → quality 计划可配", () => {
  const quality = plannedRun(TUE, "节奏跑 20 分钟", { km: 10, spec: spec(TUE, "节奏跑 20 分钟", "T", { timeS: 1200, pace: [245, 255] }) });
  const result = matchWeekSessions([quality], [act(TUE, { km: 10, cls: "tempo" })]);
  assert.equal(result.matches[0]?.confidence, "high");
});

test("活动无 session_class：通配弱分可配，置信度 medium", () => {
  const quality = plannedRun(TUE, "节奏跑 20 分钟", { km: 10, spec: spec(TUE, "节奏跑 20 分钟", "T", { timeS: 1200, pace: [245, 255] }) });
  const result = matchWeekSessions([quality], [act(TUE, { km: 10, cls: null })]);
  assert.equal(result.matches[0]?.confidence, "medium");
  assert.ok(result.matches[0]?.activity);
});

test("贪心一对一：交叉候选按综合分降序各配各的，不重复占用", () => {
  // 两节质量课（周二/周三各 10km）+ 两条 quality 活动（周二 9km / 周三 10.5km），
  // 四个候选对交叉可配——综合分排序后各自吃到同侧活动，一节计划课一条活动。
  const tueQuality = plannedRun(TUE, "周二节奏课", { km: 10, spec: spec(TUE, "周二节奏课", "T", { timeS: 1200, pace: [245, 255] }) });
  const wedQuality = plannedRun(WED, "周三节奏课", { km: 10, spec: spec(WED, "周三节奏课", "T", { timeS: 1200, pace: [245, 255] }) });
  const result = matchWeekSessions([tueQuality, wedQuality], [act(TUE, { km: 9, cls: "quality" }), act(WED, { km: 10.5, cls: "quality" })]);
  assert.equal(result.matches[0]?.activity?.day, TUE);
  assert.equal(result.matches[1]?.activity?.day, WED);
  assert.equal(result.unmatchedActivities.length, 0);
});

test("贪心一对一：一条活动对两节计划课只吃分高的一节", () => {
  // 周三 10.5km quality 活动对周二课（±1 日）与周三课（同日）都可配——同日综合分更高。
  const tueQuality = plannedRun(TUE, "周二节奏课", { km: 10, spec: spec(TUE, "周二节奏课", "T", { timeS: 1200, pace: [245, 255] }) });
  const wedQuality = plannedRun(WED, "周三节奏课", { km: 10, spec: spec(WED, "周三节奏课", "T", { timeS: 1200, pace: [245, 255] }) });
  const result = matchWeekSessions([tueQuality, wedQuality], [act(WED, { km: 10.5, cls: "quality" })]);
  const matched = result.matches.filter((match) => match.activity !== null);
  assert.equal(matched.length, 1);
  assert.equal(matched[0]?.planned.summary, "周三节奏课");
  assert.equal(result.unmatchedActivities.length, 0);
});

test("race 计划只配 race 活动；race 活动不配 quality 计划", () => {
  const raceName = "上海马拉松";
  const race = plannedRun(SUN, raceName, { km: 42, spec: null }); // spec null → 名称判 race
  assert.equal(plannedFamilyOf(race), "race");
  const quality = plannedRun(TUE, "节奏跑 20 分钟", { km: 10, spec: spec(TUE, "节奏跑 20 分钟", "T", { timeS: 1200, pace: [245, 255] }) });
  const result = matchWeekSessions([quality, race], [act(TUE, { km: 10, cls: "race" }), act(SUN, { km: 42, cls: "race" })]);
  // 周二的 race 活动不配 quality 计划（race 只相容 race 计划）→ 双双 unmatched。
  assert.equal(result.matches[0]?.activity, null);
  assert.equal(result.matches[1]?.confidence, "high");
  assert.equal(result.unmatchedActivities.length, 1);
  assert.equal(result.unmatchedActivities[0]?.day, TUE);
});

test("paceDeltaPct：质量课慢为正、快为负；E 课/LR 恒 null", () => {
  const quality = plannedRun(TUE, "节奏跑 20 分钟", { km: 10, spec: spec(TUE, "节奏跑 20 分钟", "T", { timeS: 1200, pace: [245, 255] }) });
  const easy = plannedRun(WED, "轻松跑 8km", { km: 8, spec: spec(WED, "轻松跑 8km", "E", { distanceM: 8000, pace: [330, 390] }) });
  const slow = matchWeekSessions([quality, easy], [act(TUE, { km: 10, pace: 270, cls: "quality" }), act(WED, { km: 8, pace: 360, cls: "easy" })]);
  assert.equal(slow.matches[0]?.paceDeltaPct, 8); // (270-250)/250
  assert.equal(slow.matches[1]?.paceDeltaPct, null); // E 课不算练差依据
  const fast = matchWeekSessions([quality], [act(TUE, { km: 10, pace: 240, cls: "quality" })]);
  assert.equal(fast.matches[0]?.paceDeltaPct, -4);
});

test("qualityBandMidpointSPerKm：多段质量刺激按时长加权；无 pace 处方 → null", () => {
  const multi: RunWorkout = {
    schema: "run-workout/v1",
    name: "混合课",
    date: TUE,
    note: null,
    type: "I",
    purpose: null,
    blocks: [
      {
        repeat: 6, // 6×800m I 带（中点 210）
        steps: [
          { step_kind: "work", duration: { kind: "distance_m", value: 800 }, target: { kind: "pace_s_km", low: 205, high: 215 }, note: null, hr_cap_bpm: null },
          { step_kind: "rest", duration: { kind: "time_s", value: 120 }, target: { kind: "open", low: null, high: null }, note: null, hr_cap_bpm: null },
        ],
      },
      {
        repeat: 1, // 尾段 1km R 带（中点 190，时长权重 1000）
        steps: [
          {
            step_kind: "work",
            duration: { kind: "distance_m", value: 1000 },
            target: { kind: "pace_s_km", low: 185, high: 195 },
            note: null,
            hr_cap_bpm: null,
          },
        ],
      },
    ],
  };
  // 权重：I 段 6×800=4800 @210、R 段 1000 @190 → (4800×210+1000×190)/5800
  assert.equal(qualityBandMidpointSPerKm(multi), (4800 * 210 + 1000 * 190) / 5800);
  const openSpec: RunWorkout = {
    schema: "run-workout/v1",
    name: "心率课",
    date: TUE,
    note: null,
    type: "T",
    purpose: null,
    blocks: [
      {
        repeat: 1,
        steps: [
          { step_kind: "work", duration: { kind: "time_s", value: 1200 }, target: { kind: "hr_bpm", low: 155, high: 165 }, note: null, hr_cap_bpm: null },
        ],
      },
    ],
  };
  assert.equal(qualityBandMidpointSPerKm(openSpec), null);
  assert.equal(qualityBandMidpointSPerKm(null), null);
});
