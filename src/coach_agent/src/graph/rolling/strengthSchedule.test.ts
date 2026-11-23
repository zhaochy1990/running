import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { LoadPlan, PhaseDivisionIntent, RollingStrengthAvailability, RunWorkout, Weekday, WeeklyPlan } from "@stride/contract";
import { WeeklyPlanSchema } from "@stride/contract";
import type { ContentWeekRow } from "../master_plan/phasing/content/doctrine.js";
import type { ScheduledOutcome } from "../master_plan/phasing/content/generate.js";
import { c9QualityWeekdays } from "../master_plan/phasing/content/validators.js";
import { buildStrengthBatchContext, planStrengthWeek, strengthWeeklyTarget, toStrengthSession } from "./strengthSchedule.js";
import { buildWeeklyDocs, mergeAdjustedWeekDocs } from "./weeklyDocs.js";

/**
 * #222 力量排课单测：周频次决策 / 选日与换日（C9 带别）/ 模板与邻界降载 /
 * 幂等 / weeklyDocs 集成（首批形状）/ 调整合并配额。夹具沿用 weeklyDocs.test.ts
 * 的手工 ScheduledOutcome 模式；配速按课型给真实带值——C9 质量课日判定读的是
 * 配速事实而非 type 标签。

 * 周历锚（第 4 周）：2026-10-26 周一 … 2026-11-01 周日；目标比赛 2026-11-28（周六）。
 */

const PLAN_START = "2026-10-05"; // 周一
const ZONES = { easy: [288, 336], m: [249, 288], t: [235, 249], i: [218, 235], r: [null, 218] } as const;
const RACE_DATE = "2026-11-28"; // 周六（非周日比赛用例）
const W4 = "2026-10-26"; // 第 4 周周一
const W5 = "2026-11-02"; // 第 5 周周一

type Canonical = Parameters<typeof planStrengthWeek>[0]["canonical"];

function policy8(): PhaseDivisionIntent {
  return {
    phases: [
      {
        canonical: "foundation",
        name: "第一阶段·基础期",
        start_week: 1,
        end_week: 5,
        primary_goal: "aerobic_base",
        training_goal: "建立有氧基础",
        block_mode: "progressive",
        rationale: "赛季初有氧储备不足",
      },
      {
        canonical: "final_quality",
        name: "第四阶段·最终质量期",
        start_week: 6,
        end_week: 8,
        primary_goal: "race_specificity",
        training_goal: "比赛专项",
        block_mode: "plateau",
        rationale: "专项收窄",
      },
    ],
    taper_weeks: 2,
    milestones: [{ phase: "foundation", signal: "周量", criterion: "连续 3 周 ≥60km" }],
    gates: [{ phase: "foundation", signal: "RHR", criterion: "周均 ≤ 基线+3", action_if_missed: "降周 15%" }],
    volume_bands: [
      { phase: "foundation", weekly_km_min: 40, weekly_km_max: 70 },
      { phase: "final_quality", weekly_km_min: 60, weekly_km_max: 100 },
    ],
  };
}

function skeleton(kms: Record<number, number>, overrides: Record<number, Partial<LoadPlan["weeks"][number]>> = {}): LoadPlan {
  return {
    weeks: Object.entries(kms).map(([week, km]) => ({
      week: Number(week),
      canonical: "foundation" as const,
      block: 1,
      role: "progress" as const,
      km,
      lr: 20,
      q: 1,
      ...(overrides[Number(week)] ?? {}),
    })),
    blocks: [{ block: 1, canonical: "foundation", start_week: 1, end_week: 8, absorb_weeks: [], boundary: "phase_start" }],
    recovery_policy: [],
    strength_policy: [],
    checks: [],
    milestones: [],
  };
}

/** 各课型真实配速带（E/LR 有氧带不进质量谱；M/T/I/R 进）。 */
const PACE: Record<NonNullable<RunWorkout["type"]>, [number, number]> = {
  E: [288, 336],
  LR: [288, 336],
  M: [249, 288],
  T: [235, 249],
  I: [218, 235],
  R: [150, 218],
};

function step(distanceM: number, pace: [number, number]): RunWorkout["blocks"][number]["steps"][number] {
  return {
    step_kind: "work",
    duration: { kind: "distance_m", value: distanceM },
    target: { kind: "pace_s_km", low: pace[0], high: pace[1] },
    note: null,
    hr_cap_bpm: null,
  };
}

function workout(name: string, date: string, type: RunWorkout["type"], distanceM: number): RunWorkout {
  return {
    schema: "run-workout/v1",
    name,
    date,
    note: null,
    type,
    purpose: `${type} 课`,
    blocks: [{ repeat: 1, steps: [step(distanceM, PACE[type ?? "E"])] }],
  };
}

/** 带质量尾段的长跑（LR 内嵌 M 配速 work 段——C9 把它计为质量课日）。 */
function longRunWithQualityTail(date: string): RunWorkout {
  return {
    schema: "run-workout/v1",
    name: "周末长跑 20km（M 尾段）",
    date,
    note: null,
    type: "LR",
    purpose: "长跑",
    blocks: [
      { repeat: 1, steps: [step(16000, PACE.LR)] },
      { repeat: 1, steps: [step(4000, PACE.M)] },
    ],
  };
}

function loadPoints(week: number, weekStart: string) {
  return Array.from({ length: 7 }, (_, offset) => ({
    date: new Date(new Date(`${weekStart}T00:00:00Z`).getTime() + offset * 86_400_000).toISOString().slice(0, 10),
    week,
    loadPt: 10,
    atl: 60,
    ctl: 57,
    ratio: 1.0,
    sessions: [],
  }));
}

function scheduledOf(week: number, weekStart: string, sessions: RunWorkout[]): ScheduledOutcome {
  return {
    weeks: [{ week, sessions }],
    calendar: [],
    loadSeries: loadPoints(week, weekStart),
    loadMeta: { model: "exp-pmc-7-42", seed: { acute: 55, chronic: 60, source: "test" }, coefficient_version: "lsq-20261029" },
    checks: [],
    scheduleChecks: [],
    repairs: [],
    source: "llm",
    attempts: 1,
    attemptsDetail: [],
  };
}

const ROW_4: ContentWeekRow = {
  week: 4,
  phase: "foundation",
  role: "progress",
  totalKm: 66,
  longRunKm: 20,
  qualitySessions: 1,
  qualityFamily: "E 为主；速度触感靠 strides",
  zones: ZONES,
};

const PREFS_2: RollingStrengthAvailability = {
  sessionsPerWeek: 2,
  availableDays: ["monday", "thursday"],
  allowsDoubleSessions: false,
  unavailableDays: [],
  maxSessionDurationMin: 90,
};

const OFF_PREFS: RollingStrengthAvailability = {
  sessionsPerWeek: 0,
  availableDays: [],
  allowsDoubleSessions: false,
  unavailableDays: [],
  maxSessionDurationMin: 90,
};

const LR_SUN = () => workout("周末长跑 20km", "2026-11-01", "LR", 20000);
const mon = (day: number) => `2026-10-${String(day).padStart(2, "0")}`;

/** 单周力量决策（批上下文与 C9 质量课日集由周课自动算出；跨周用例另传整批）。 */
function planWeek(
  prefs: RollingStrengthAvailability,
  week: { number: number; start: string; canonical: Canonical; role?: string; workouts: RunWorkout[] },
  scheduled: ScheduledOutcome = scheduledOf(week.number, week.start, week.workouts),
) {
  return planStrengthWeek({
    prefs,
    weekNumber: week.number,
    weekStart: week.start,
    canonical: week.canonical,
    role: week.role ?? "progress",
    workouts: week.workouts,
    batch: buildStrengthBatchContext(scheduled, RACE_DATE),
    qualityWeekdays: c9QualityWeekdays(
      week.workouts.map((workout) => ({ workout })),
      ZONES,
      RACE_DATE,
    ),
  });
}

const WEEK_4 = { number: 4, start: W4, canonical: "foundation" as const };
const WEEK_5 = { number: 5, start: W5, canonical: "foundation" as const };
/** 周号奇偶决定单节模板基数（奇=下肢稳定）；日历仍落在第 4 周。 */
const WEEK_4_ODD = { number: 3, start: W4, canonical: "foundation" as const };

// ── 周频次决策 ────────────────────────────────────────────────────────────────

test("周频次：基础期 min(用户,2)；吸收周/减量周/过渡期压 1；比赛周/赛后周/赛前10天为 0", () => {
  const base = { weekStart: W4, canonical: "foundation" as const, role: "progress" };
  assert.deepEqual(strengthWeeklyTarget(PREFS_2, base, RACE_DATE), { target: 2, reason: null });
  assert.deepEqual(strengthWeeklyTarget({ ...PREFS_2, sessionsPerWeek: 3 }, base, RACE_DATE), {
    target: 2,
    reason: "基础期力量减量：每周至多 2 节",
  });
  assert.deepEqual(strengthWeeklyTarget(PREFS_2, { ...base, role: "absorb" }, RACE_DATE), {
    target: 1,
    reason: "吸收周力量减量：每周至多 1 节",
  });
  assert.deepEqual(strengthWeeklyTarget(PREFS_2, { ...base, role: "taper" }, RACE_DATE), {
    target: 1,
    reason: "减量周力量减量：每周至多 1 节",
  });
  assert.deepEqual(strengthWeeklyTarget(PREFS_2, { ...base, canonical: "transition_quality" }, RACE_DATE), {
    target: 1,
    reason: "过渡期力量减量：每周至多 1 节",
  });
  assert.deepEqual(strengthWeeklyTarget(PREFS_2, { ...base, role: "race" }, RACE_DATE), { target: 0, reason: "比赛周不排正式力量" });
  assert.deepEqual(strengthWeeklyTarget(PREFS_2, { ...base, weekStart: "2026-11-30" }, RACE_DATE), { target: 0, reason: "赛后恢复周不排力量" });
  // 非周日比赛（2026-11-28 周六）：赛前 10 天=2026-11-18 起按具体日期停排——
  // 整周落入窗口（11-23 起）才整周归零；跨窗口周（11-16）由选日层逐日拦截。
  assert.deepEqual(strengthWeeklyTarget(PREFS_2, { ...base, weekStart: "2026-11-23" }, RACE_DATE), {
    target: 0,
    reason: "赛前10天起停排正式力量",
  });
  assert.ok(strengthWeeklyTarget(PREFS_2, { ...base, weekStart: "2026-11-16" }, RACE_DATE).target > 0);
  // 显式关闭
  assert.deepEqual(strengthWeeklyTarget(OFF_PREFS, base, RACE_DATE), { target: 0, reason: null });
});

// ── 选日 ──────────────────────────────────────────────────────────────────────

test("票面复现：周一/周四力量日、跑课只放周二 → 2 节力量（含力量独占日），跑课不动", () => {
  const outcome = planWeek(PREFS_2, { ...WEEK_4, workouts: [workout("E 8km", mon(27), "E", 8000), LR_SUN()] });
  assert.deepEqual(
    outcome.placements.map((p) => [p.date, p.stacked, p.templateId]),
    [
      [mon(26), false, "lower_body"],
      [mon(29), false, "core"],
    ],
  );
  assert.deepEqual(outcome.relocations, []);
  assert.equal(outcome.note, null);
});

test("幂等：同一输入重复生成结果逐字段一致", () => {
  // 周一/周六空闲、周四被 T 课占（少排）：独立日/少排/降载三条路径都走一遍。
  const workouts = [workout("E 8km", mon(27), "E", 8000), workout("T 巡航 5km", mon(29), "T", 5000), LR_SUN()];
  const run = (days: Weekday[]) => planWeek({ ...PREFS_2, availableDays: days }, { ...WEEK_4, workouts });
  const first = run(["monday", "thursday", "saturday"]);
  assert.equal(first.placements.length, 2);
  assert.deepEqual(run(["monday", "thursday", "saturday"]), first);
  // 力量日提交顺序不同也归一到周内顺序
  assert.deepEqual(run(["saturday", "thursday", "monday"]), first);
});

test("不可用日：力量候选日落在 unavailable_days → 跳过并少排（给原因）", () => {
  const outcome = planWeek({ ...PREFS_2, sessionsPerWeek: 1, availableDays: ["monday"], unavailableDays: ["monday"] }, { ...WEEK_4, workouts: [LR_SUN()] });
  assert.equal(outcome.placements.length, 0);
  assert.match(outcome.note ?? "", /周一不可训练/);
});

test("允许双练：力量日有跑课 → 同日叠加（跑步在前）", () => {
  const outcome = planWeek(
    { ...PREFS_2, sessionsPerWeek: 1, availableDays: ["monday"], allowsDoubleSessions: true },
    {
      ...WEEK_4,
      workouts: [workout("E 8km", mon(26), "E", 8000), LR_SUN()],
    },
  );
  assert.equal(outcome.placements.length, 1);
  assert.equal(outcome.placements[0]!.stacked, true);
  assert.deepEqual(outcome.relocations, []);
});

test("禁双练少排：力量日被质量课占用 → 质量课绝不挪，少排并给原因", () => {
  const outcome = planWeek(
    { ...PREFS_2, sessionsPerWeek: 1, availableDays: ["monday"] },
    {
      ...WEEK_4,
      workouts: [workout("T 巡航 5km", mon(26), "T", 5000), LR_SUN()],
    },
  );
  assert.equal(outcome.placements.length, 0);
  assert.deepEqual(outcome.relocations, []);
  assert.match(outcome.note ?? "", /周一被跑课占用且无法换日/);
});

// ── E 换日（C9 带别一致才合法）────────────────────────────────────────────────

test("换日：普通日纯 E 挪到同周普通日空位 → 力量独立成节", () => {
  // 周四 M 课（质量课日=周四）；周一/周二都是普通日。
  const outcome = planWeek(
    { ...PREFS_2, sessionsPerWeek: 1, availableDays: ["monday"] },
    {
      ...WEEK_4,
      workouts: [workout("E 8km", mon(26), "E", 8000), workout("M 配速 8km", mon(29), "M", 8000), LR_SUN()],
    },
  );
  assert.deepEqual(outcome.relocations, [{ from: mon(26), to: mon(27) }]);
  assert.deepEqual(
    outcome.placements.map((p) => [p.date, p.stacked]),
    [[mon(26), false]],
  );
});

test("换日：间隔日纯 E 挪到同周另一间隔日 → 合法", () => {
  // 周一 T + 周四 M：周二/周三都是间隔日；周二 E 挪到周三。
  const outcome = planWeek(
    { ...PREFS_2, sessionsPerWeek: 1, availableDays: ["tuesday"] },
    {
      ...WEEK_4,
      workouts: [workout("T 巡航 5km", mon(26), "T", 5000), workout("E 45min", mon(27), "E", 7000), workout("M 配速 8km", mon(29), "M", 8000), LR_SUN()],
    },
  );
  assert.deepEqual(outcome.relocations, [{ from: mon(27), to: mon(28) }]);
  assert.equal(outcome.placements[0]!.date, mon(27));
});

test("C9 带守护：间隔日 E 不能挪到普通日 → 少排并给原因", () => {
  // 周二 T + 周四 M：周三是间隔日（短带 30-60min）；周一/周五是普通日（60-90min）。
  const outcome = planWeek(
    { ...PREFS_2, sessionsPerWeek: 1, availableDays: ["wednesday"] },
    {
      ...WEEK_4,
      workouts: [workout("T 巡航 5km", mon(27), "T", 5000), workout("E 45min", mon(28), "E", 7000), workout("M 配速 8km", mon(29), "M", 8000), LR_SUN()],
    },
  );
  assert.equal(outcome.placements.length, 0);
  assert.deepEqual(outcome.relocations, []);
  assert.match(outcome.note ?? "", /周三被跑课占用且无法换日/);
});

test("C9 带守护：普通日 E 不能挪到间隔日 → 少排", () => {
  // 周一 T + 周四 M：周二/周三都是间隔日；周五普通日的 E 无处可挪。
  const outcome = planWeek(
    { ...PREFS_2, sessionsPerWeek: 1, availableDays: ["friday"] },
    {
      ...WEEK_4,
      workouts: [workout("T 巡航 5km", mon(26), "T", 5000), workout("M 配速 8km", mon(29), "M", 8000), workout("E 75min", mon(30), "E", 12000), LR_SUN()],
    },
  );
  assert.equal(outcome.placements.length, 0);
  assert.deepEqual(outcome.relocations, []);
});

test("C9 同口径：带质量尾段的长跑也计为质量课日（间隔日判定读配速事实）", () => {
  // 周四 M + 周日 LR(M 尾段)：C9 质量课日={周四,周日} → 周五（两质量课之间）
  // 是间隔日；按 type 近似会漏算长跑、把周五当普通日挪出去造成 C9 违规。
  const workouts = [workout("M 配速 8km", mon(29), "M", 8000), workout("E 45min", mon(30), "E", 7000), longRunWithQualityTail("2026-11-01")];
  const qualityWeekdays = c9QualityWeekdays(
    workouts.map((workout) => ({ workout })),
    ZONES,
    RACE_DATE,
  );
  assert.deepEqual([...qualityWeekdays].sort(), [3, 6]); // 周四=3、周日=6（校验器周内位）
  const outcome = planWeek({ ...PREFS_2, sessionsPerWeek: 1, availableDays: ["friday"] }, { ...WEEK_4, workouts });
  assert.equal(outcome.placements.length, 0);
  assert.deepEqual(outcome.relocations, []);
});

test("换日避让：目标日不落不可用日、不落周六（长跑前日轻量位）", () => {
  const workouts = [workout("E 8km", mon(26), "E", 8000), workout("M 配速 8km", mon(29), "M", 8000), LR_SUN()];
  // 周二不可训练 → E 挪到周三而非周二
  const avoidUnavailable = planWeek({ ...PREFS_2, sessionsPerWeek: 1, availableDays: ["monday"], unavailableDays: ["tuesday"] }, { ...WEEK_4, workouts });
  assert.deepEqual(avoidUnavailable.relocations, [{ from: mon(26), to: mon(28) }]);
  // 周二..周五全不可训练 → 只剩周六可去，但周六是长跑前日，不换日
  const onlySaturdayLeft = planWeek(
    { ...PREFS_2, sessionsPerWeek: 1, availableDays: ["monday"], unavailableDays: ["tuesday", "wednesday", "thursday", "friday"] },
    { ...WEEK_4, workouts },
  );
  assert.deepEqual(onlySaturdayLeft.relocations, []);
  assert.equal(onlySaturdayLeft.placements.length, 0);
});

// ── 模板与邻界降载 ────────────────────────────────────────────────────────────

test("下肢降载：力量日次日是质量课/长跑 → 下肢模板降为核心（保节数+记原因）", () => {
  // 奇数周单节基数=下肢稳定；周一次日有周二 T 课。
  const eveOfQuality = planWeek(
    { ...PREFS_2, sessionsPerWeek: 1, availableDays: ["monday"] },
    {
      ...WEEK_4_ODD,
      workouts: [workout("T 巡航 5km", mon(27), "T", 5000), LR_SUN()],
    },
  );
  assert.equal(eveOfQuality.placements.length, 1);
  assert.equal(eveOfQuality.placements[0]!.templateId, "core");
  assert.match(eveOfQuality.note ?? "", /周一次日是质量课\/长跑，下肢课降为核心/);

  // 周六力量日次日是周日长跑。
  const eveOfLongRun = planWeek({ ...PREFS_2, sessionsPerWeek: 1, availableDays: ["saturday"] }, { ...WEEK_4_ODD, workouts: [LR_SUN()] });
  assert.equal(eveOfLongRun.placements[0]!.templateId, "core");
  assert.match(eveOfLongRun.note ?? "", /周六次日是质量课\/长跑，下肢课降为核心/);

  // 周三力量日次日无质量课/长跑 → 保住下肢稳定（对照：降载只在命中邻界时发生）。
  const clear = planWeek({ ...PREFS_2, sessionsPerWeek: 1, availableDays: ["wednesday"] }, { ...WEEK_4_ODD, workouts: [LR_SUN()] });
  assert.equal(clear.placements[0]!.templateId, "lower_body");
  assert.equal(clear.note, null);
});

test("两节时下肢课落到能排的那天：周一（次日质量课）排不了、周四可排 → 周四=下肢稳定", () => {
  // 周二 T 课 + 周日长跑；力量日周一/周四。按顺序硬塞会让下肢课每周都被降载。
  const outcome = planWeek(PREFS_2, { ...WEEK_4, workouts: [workout("T 巡航 5km", mon(27), "T", 5000), LR_SUN()] });
  assert.deepEqual(
    outcome.placements.map((p) => [p.date, p.templateId]),
    [
      [mon(26), "core"],
      [mon(29), "lower_body"],
    ],
  );
  assert.equal(outcome.note, null);
});

test("两节都排不了下肢 → 都是核心模板，两天的降载原因都记", () => {
  // 周二 T + 周五 M + 周日长跑；周一（次日 T）、周四（次日 M）都命中前一日规则。
  const outcome = planWeek(PREFS_2, {
    ...WEEK_4,
    workouts: [workout("T 巡航 5km", mon(27), "T", 5000), workout("M 配速 8km", mon(30), "M", 8000), LR_SUN()],
  });
  assert.deepEqual(
    outcome.placements.map((p) => [p.date, p.templateId]),
    [
      [mon(26), "core"],
      [mon(29), "core"],
    ],
  );
  assert.match(outcome.note ?? "", /周一次日是质量课\/长跑，下肢课降为核心/);
  assert.match(outcome.note ?? "", /周四次日是质量课\/长跑，下肢课降为核心/);
});

test("双练叠加：叠在长跑日不排下肢；叠在轻松跑后可排下肢", () => {
  const lr = workout("周末长跑 20km", "2026-11-08", "LR", 20000);
  // 第 5 周（奇数，单节基数=下肢）：周日与长跑同日双练 → 降为核心并记原因
  const onLongRunDay = planWeek({ ...PREFS_2, sessionsPerWeek: 1, availableDays: ["sunday"], allowsDoubleSessions: true }, { ...WEEK_5, workouts: [lr] });
  assert.deepEqual(
    onLongRunDay.placements.map((p) => [p.stacked, p.templateId]),
    [[true, "core"]],
  );
  assert.match(onLongRunDay.note ?? "", /周日与长跑\/质量课同日双练，下肢课降为核心/);
  // 对照：叠在轻松跑之后（次日无质量课/长跑）保住下肢
  const afterEasyRun = planWeek(
    { ...PREFS_2, sessionsPerWeek: 1, availableDays: ["wednesday"], allowsDoubleSessions: true },
    {
      ...WEEK_5,
      workouts: [workout("E 8km", "2026-11-04", "E", 8000), lr],
    },
  );
  assert.deepEqual(
    afterEasyRun.placements.map((p) => [p.stacked, p.templateId]),
    [[true, "lower_body"]],
  );
  assert.equal(afterEasyRun.note, null);
});

test("跨周边界：本周日力量、下周一（同批）有质量课 → 次日规则命中降载", () => {
  // 第 5 周（奇数，单节基数=下肢）周日 11-08 空闲；第 6 周周一 11-09 有 T 课——
  // 邻界检查用批级日期集，跨周的前一日规则同样生效。
  const mondayEasy = workout("E 8km", "2026-11-02", "E", 8000);
  const scheduled: ScheduledOutcome = {
    ...scheduledOf(5, W5, [mondayEasy]),
    weeks: [
      { week: 5, sessions: [mondayEasy] },
      { week: 6, sessions: [workout("T 巡航 5km", "2026-11-09", "T", 5000)] },
    ],
  };
  const outcome = planWeek({ ...PREFS_2, sessionsPerWeek: 1, availableDays: ["sunday"] }, { ...WEEK_5, workouts: [mondayEasy] }, scheduled);
  assert.equal(outcome.placements[0]!.templateId, "core");
  assert.match(outcome.note ?? "", /周日次日是质量课\/长跑，下肢课降为核心/);
});

test("批末周日：批内末周的周日力量 → 下肢降载（次日质量课跨批不可判）", () => {
  // 第 5 周（奇数，单节基数=下肢）周日 11-08 空闲，且是批内最后一周——看不到下一批
  // 周一是否排质量课，保守降载。同一天若不在批末（上一条用例）走的是可见的次日规则。
  const outcome = planWeek(
    { ...PREFS_2, sessionsPerWeek: 1, availableDays: ["sunday"] },
    {
      ...WEEK_5,
      workouts: [workout("E 8km", "2026-11-02", "E", 8000)],
    },
  );
  assert.deepEqual(
    outcome.placements.map((p) => [p.stacked, p.templateId]),
    [[false, "core"]],
  );
  assert.match(outcome.note ?? "", /周日为批末周日/);
});

test("过渡期：阈值课后两个日历日内不练腿（阶段策略原文），其余日保住下肢课", () => {
  // 第 5 周（奇数，单节基数=下肢）；周三 11-04 阈值课。
  const t = workout("T 巡航 6km", "2026-11-04", "T", 6000);
  const lr = workout("周末长跑 20km", "2026-11-08", "LR", 20000);
  const plan = (day: Weekday) =>
    planWeek({ ...PREFS_2, sessionsPerWeek: 1, availableDays: [day] }, { ...WEEK_5, canonical: "transition_quality", workouts: [t, lr] });
  // 周一（T−2）：不在阈值课后窗口 → 保住下肢稳定
  assert.deepEqual(
    plan("monday").placements.map((p) => p.templateId),
    ["lower_body"],
  );
  assert.equal(plan("monday").note, null);
  // 周四（T+1）/周五（T+2）：阈值课后两个日历日内 → 降为核心
  assert.deepEqual(
    plan("thursday").placements.map((p) => p.templateId),
    ["core"],
  );
  assert.match(plan("thursday").note ?? "", /周四在阈值课后两个日历日内，下肢课降为核心/);
  assert.deepEqual(
    plan("friday").placements.map((p) => p.templateId),
    ["core"],
  );
  assert.match(plan("friday").note ?? "", /周五在阈值课后两个日历日内/);
  // 周二（T−1）：次日是质量课 → 降载（长跑/质量课前一日规则）
  assert.deepEqual(
    plan("tuesday").placements.map((p) => p.templateId),
    ["core"],
  );
  assert.match(plan("tuesday").note ?? "", /周二次日是质量课\/长跑/);
  // 过渡期上限 1 节：用户选 2 次时说明阶段减量
  assert.match(planWeek(PREFS_2, { ...WEEK_5, canonical: "transition_quality", workouts: [t, lr] }).note ?? "", /力量 1\/2 节（过渡期力量减量：每周至多 1 节/);
});

test("专项/恢复期只排维持激活（阶段策略：力量减量维持神经激活 / 维持性核心）", () => {
  const t = workout("T 巡航 6km", "2026-11-10", "T", 6000);
  const lr = workout("周末长跑 20km", "2026-11-15", "LR", 20000);
  // 第 6 周（奇数，基数本应是下肢）：final_quality 周只给维持激活，阈值邻界规则不触发
  const outcome = planWeek(
    { ...PREFS_2, sessionsPerWeek: 1, availableDays: ["monday"] },
    { number: 6, start: "2026-11-09", canonical: "final_quality", workouts: [t, lr] },
  );
  assert.deepEqual(
    outcome.placements.map((p) => p.templateId),
    ["light"],
  );
  assert.equal(outcome.note, null);
});

test("时长上限：maxSessionDurationMin 极小 → 模板从尾部裁剪动作至放得下", () => {
  const session = toStrengthSession({ date: mon(26), templateId: "lower_body", stacked: false }, { ...PREFS_2, maxSessionDurationMin: 5 });
  const spec = session.spec as { exercises: unknown[] };
  assert.ok(spec.exercises.length < 6 && spec.exercises.length >= 1);
  assert.ok((session.total_duration_s ?? 0) <= 5 * 60);
});

test("力量会话契约：spec 非空、date 对齐、T-code 合法、距离与剂量为空", () => {
  const session = toStrengthSession({ date: mon(26), templateId: "lower_body", stacked: false }, PREFS_2);
  const spec = session.spec as { schema: string; date: string; exercises: Array<{ provider_id: string | null }> };
  assert.equal(spec.schema, "strength-workout/v1");
  assert.equal(spec.date, session.date);
  assert.ok(spec.exercises.length > 0);
  assert.ok(spec.exercises.every((exercise) => exercise.provider_id !== null && /^T\d+$/.test(exercise.provider_id!)));
  assert.equal(session.total_distance_m, null);
  assert.equal(session.estimated_dose, null);
});

test("模板动作经 COROS 目录核对：T-code 存在且目标类型（次数/计时）与目录一致", () => {
  // 推送手表按 provider_id 查 COROS 内置动作目录（src/coros_sync/coros_exercises.json，
  // targetType 2=计时 3=次数）；目录改版或模板换动作时这里先红。
  const catalog = JSON.parse(readFileSync(new URL("../../../../coros_sync/coros_exercises.json", import.meta.url), "utf8")) as Array<{
    name: string;
    targetType: number;
  }>;
  const targetTypeByCode = new Map(catalog.map((entry) => [entry.name, entry.targetType]));
  for (const templateId of ["lower_body", "core", "light"] as const) {
    const { spec } = toStrengthSession({ date: mon(26), templateId, stacked: false }, PREFS_2);
    for (const ex of (spec as { exercises: Array<{ provider_id: string | null; target_kind: string }> }).exercises) {
      assert.ok(ex.provider_id !== null, `${templateId}: 动作缺 T-code`);
      const targetType = targetTypeByCode.get(ex.provider_id);
      assert.ok(targetType !== undefined, `${templateId}: ${ex.provider_id} 不在 COROS 目录`);
      assert.equal(targetType, ex.target_kind === "reps" ? 3 : 2, `${templateId}: ${ex.provider_id} 目标类型与目录不符`);
    }
  }
});

// ── weeklyDocs 集成（首批形状）────────────────────────────────────────────────

function buildStrengthDocs(
  strength: RollingStrengthAvailability | null,
  scheduled: ScheduledOutcome = scheduledOf(4, W4, [workout("E 8km", mon(27), "E", 8000), LR_SUN()]),
  skeletonOverride?: LoadPlan,
): WeeklyPlan[] {
  return buildWeeklyDocs({
    scheduled,
    batchRows: [ROW_4],
    policy: policy8(),
    skeletonNew: skeletonOverride ?? skeleton({ 1: 50, 2: 55, 3: 60, 4: 66, 5: 70, 6: 72, 7: 68, 8: 64 }),
    skeletonStored: skeleton({ 1: 50, 2: 55, 3: 60, 4: 60, 5: 65, 6: 72, 7: 68, 8: 64 }),
    planStartMonday: PLAN_START,
    raceDate: RACE_DATE,
    athlete: { weeklyRunDaysMax: 6 },
    strength,
  });
}

test("集成：2 节力量进周文档，力量独占日无休息占位，跑课会话零变化", () => {
  const without = buildStrengthDocs(OFF_PREFS);
  const withStrength = buildStrengthDocs(PREFS_2);
  assert.deepEqual(
    withStrength[0]!.sessions.filter((session) => session.kind === "run"),
    without[0]!.sessions.filter((session) => session.kind === "run"),
  );
  const strengthSessions = withStrength[0]!.sessions.filter((session) => session.kind === "strength");
  assert.deepEqual(
    strengthSessions.map((session) => session.date),
    [mon(26), mon(29)],
  );
  assert.ok(!withStrength[0]!.sessions.some((session) => session.date === mon(26) && session.kind === "rest"));
  // 跑量/跑步剂量/重点课不因加入力量而变
  assert.equal(withStrength[0]!.planned_dose, without[0]!.planned_dose);
  assert.deepEqual(withStrength[0]!.key_sessions, without[0]!.key_sessions);
  // (date, session_index) 唯一 + 硬校验通过
  const pairs = withStrength[0]!.sessions.map((session) => `${session.date}#${session.session_index}`);
  assert.equal(new Set(pairs).size, pairs.length);
  assert.doesNotThrow(() => WeeklyPlanSchema.parse(withStrength[0]));
});

test("集成：禁双练换日 → E 跑挪到空日（周总量不变），力量独立成节", () => {
  const scheduled = scheduledOf(4, W4, [workout("E 8km", mon(26), "E", 8000), workout("M 配速 8km", mon(29), "M", 8000), LR_SUN()]);
  const off = buildStrengthDocs(OFF_PREFS, scheduled);
  const docs = buildStrengthDocs({ ...PREFS_2, sessionsPerWeek: 1, availableDays: ["monday"] }, scheduled);
  assert.deepEqual(
    docs[0]!.sessions.filter((session) => session.kind === "run").map((session) => session.date),
    [mon(27), mon(29), "2026-11-01"],
  );
  const strength = docs[0]!.sessions.find((session) => session.kind === "strength");
  assert.equal(strength?.date, mon(26));
  assert.equal(strength?.session_index, 0);
  assert.equal(docs[0]!.planned_dose, off[0]!.planned_dose);
  assert.doesNotThrow(() => WeeklyPlanSchema.parse(docs[0]));
});

test("集成：允许双练 → 同日跑前力量后，两节可按 (date, session_index) 单独读取", () => {
  const scheduled = scheduledOf(4, W4, [workout("E 8km", mon(26), "E", 8000), LR_SUN()]);
  const docs = buildStrengthDocs({ ...PREFS_2, sessionsPerWeek: 1, availableDays: ["monday"], allowsDoubleSessions: true }, scheduled);
  const onMonday = docs[0]!.sessions.filter((session) => session.date === mon(26)).sort((a, b) => a.session_index - b.session_index);
  assert.deepEqual(
    onMonday.map((session) => [session.kind, session.session_index]),
    [
      ["run", 0],
      ["strength", 1],
    ],
  );
  assert.match(onMonday[1]!.notes_md ?? "", /跑步在前/);
});

test("集成：显式关闭（0 次）→ 0 节力量且无提示；未设置（null）→ 0 节 + 批内首周提示补选", () => {
  const off = buildStrengthDocs(OFF_PREFS);
  assert.equal(off[0]!.sessions.filter((session) => session.kind === "strength").length, 0);
  assert.ok(!(off[0]!.coach_notes ?? "").includes("力量偏好未设置"));
  const legacy = buildStrengthDocs(null);
  assert.equal(legacy[0]!.sessions.filter((session) => session.kind === "strength").length, 0);
  assert.match(legacy[0]!.coach_notes ?? "", /力量偏好未设置/);
});

test("集成：比赛周 → 0 节 + coach_notes 阶段减量说明", () => {
  const raceSkeleton = skeleton({ 1: 50, 2: 55, 3: 60, 4: 66, 5: 70, 6: 72, 7: 68, 8: 64 }, { 4: { role: "race" } });
  const docs = buildStrengthDocs(PREFS_2, undefined, raceSkeleton);
  assert.equal(docs[0]!.sessions.filter((session) => session.kind === "strength").length, 0);
  assert.match(docs[0]!.coach_notes ?? "", /力量 0\/2 节（比赛周不排正式力量）/);
});

// ── 调整合并配额 ──────────────────────────────────────────────────────────────

test("调整合并：保留的已过力量课计入本周配额，未来力量课按剩余配额截留", () => {
  // 旧文档周一/周二已有力量（均 ≤ cutoff 周三；周二那节叠在 E 跑后，序号 1）；
  // 新文档整周力量 2 节（周一/周四）→ 已过 2 节计入配额，允许未来 2-2=0 节，
  // 新周四力量被截掉；跑课照常替换。
  const oldDoc = buildStrengthDocs(PREFS_2)[0]!;
  const newDoc = buildStrengthDocs(PREFS_2)[0]!;
  const crafted: WeeklyPlan = {
    ...oldDoc,
    sessions: oldDoc.sessions.map((session) =>
      session.kind === "strength" && session.date === mon(29)
        ? { ...session, date: mon(27), session_index: 1, spec: session.spec ? { ...session.spec, date: mon(27) } : null }
        : session,
    ),
  };
  const merged = mergeAdjustedWeekDocs([newDoc], [crafted], mon(28)); // 周三
  assert.deepEqual(
    merged[0]!.sessions.filter((session) => session.kind === "strength").map((session) => session.date),
    [mon(26), mon(27)],
  );
  assert.match(merged[0]!.notes_md ?? "", /力量课按本周剩余配额排入（截至 2026-10-28 已练 2 节，截留 1 节）/);
  assert.doesNotThrow(() => WeeklyPlanSchema.parse(merged[0]));
});
