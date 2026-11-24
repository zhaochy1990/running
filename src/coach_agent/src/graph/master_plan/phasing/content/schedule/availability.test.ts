import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, normalizeRunWorkout, type RunWorkout, shanghaiDay, type WeeklyPlan } from "@stride/contract";
import { danielsAudit } from "../danielsAudit.js";
import type { PaceZones } from "../derive.js";
import { buildContentPayload } from "../doctrine.js";
import { templateFallback } from "../fallback.js";
import { generateWeekContent, type ScheduledOutcome } from "../generate.js";
import { schedulingAvailabilityOf } from "./availability.js";
import { boundaryBefore, publishedWeekFacts } from "./boundary.js";
import { type DayFact, factsOfDays } from "./distribution.js";
import { DEFAULT_DOSE_COEFFICIENTS } from "./dose.js";
import { scheduleGates } from "./gates.js";
import { type CalendarDay, DAY_LABELS, type LoadSeriesPoint, type PlannedCourse, type StructuredCourse, scheduleWeeks, type WeekBag } from "./scheduler.js";
import {
  availabilityOf,
  draftOf,
  eSlot,
  failuresOfPlacement,
  fourRunBag,
  generatorInput,
  instantiatePlacement,
  lrCourse,
  modelOf,
  normalRow,
  PLAN_START_MONDAY,
  PMC_SEED,
  RACE,
  raceBag,
  raceRow,
  scheduleCtxOf,
  tCourse,
  ZONES,
} from "./testSupport.js";

/**
 * 排课可用度与跨周边界验收（devops#1043）：禁跑日/日内窗口/双练
 * 许可进入排位；首次生成、滚动续排、模板兜底带同一份已知相邻日历与负荷种子；
 * 跨周/跨批次/未知边界/已锁定日期/赛周；硬约束无解返回具体冲突。
 */

const weekdayOf = (date: string): number => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
const weekdaysOf = (sessions: Array<{ date: string }>): number[] => [...new Set(sessions.map((session) => weekdayOf(session.date)))].sort((a, b) => a - b);

test("禁跑日：候选日排除禁跑日（P8 门），课型位置只在可跑日之间重排", () => {
  const availability = availabilityOf([1, 3, 5, 6]); // 周二/周四/周六/周日
  const result = scheduleWeeks([fourRunBag(1)], scheduleCtxOf([normalRow(1)], { availability }));
  assert.ok(result.ok, result.failures.join(";"));
  const week = result.weeks[0]!;
  assert.equal(week.sessions.length, 4, "课数不变");
  assert.deepEqual(weekdaysOf(week.sessions), [1, 3, 5, 6]);
  assert.ok(week.checks.find((check) => check.id === "P8 可跑日")?.pass);
  for (const candidate of result.distribution[0]!.candidates)
    assert.ok(
      candidate.runDays.every((weekday) => availability.availableWeekdays!.includes(weekday)),
      `${candidate.label} 落在禁跑日`,
    );
});

test("长跑周日与不可跑日冲突：按硬约束无解处理，返回具体冲突日", () => {
  const result = scheduleWeeks([fourRunBag(1)], scheduleCtxOf([normalRow(1)], { availability: availabilityOf([0, 1, 2, 3, 4, 5]) }));
  assert.equal(result.ok, false);
  assert.match(result.failures[0]!, /周日为不可跑日——长跑须排周日（P3 位型），与可跑日（一\/二\/三\/四\/五\/六）冲突/);
  assert.deepEqual(result.conflicts, [result.failures[0]!], "编排层据 conflicts 归类结构性无解");
});

test("可跑日装不下课包：无解原因落在「可跑日不足」上，而不是被它连带出来的周量", () => {
  const result = scheduleWeeks([fourRunBag(1)], scheduleCtxOf([normalRow(1)], { availability: availabilityOf([1, 5, 6]) }));
  assert.equal(result.ok, false);
  assert.match(result.failures[0]!, /^W1 可跑日不足：可跑日 3 天（二\/六\/日）装不下课包 4 节/);
  assert.deepEqual(result.conflicts, [result.failures[0]]);
  assert.ok(result.failures.length <= 2, "同一道门不在候选间重复上浮");
});

test("固定四课、只能三天、禁止双练（devops#1054）：明确的结构性无解——不靠静默剪课换过门", async () => {
  const availability = availabilityOf([0, 1, 2, 3, 4, 5, 6], { allowsDoubleSessions: false });
  for (const totalKm of [40, 55]) {
    // 低量周（40km）剪掉一节 E 后周量仍收敛——此前就这样少交一节课；常规量此前只报周量不收敛、说不出原因
    const result = scheduleWeeks([fourRunBag(1)], scheduleCtxOf([normalRow(1, { totalKm })], { athlete: { weeklyRunDaysMax: 3 }, availability }));
    assert.equal(result.ok, false, `${totalKm}km：课包 4 节装不进 3 天`);
    assert.match(result.failures[0]!, /^W1 双练未获许可：课包 4 节超过每周跑步日上限 3——周量 \d+km 的课包需一天两练才装得下（allows_double_sessions=false）/);
    assert.deepEqual(result.conflicts, [result.failures[0]], "归为用户可用度与课包冲突");
  }
  // 真实入口：固定课包在 3 天里排不出——重试清单带上这条冲突；模型坚持不改课包时由按天数上限构造
  // 的模板接住（3 节课），而不是把固定课包悄悄剪成 3 节交付
  const base = generatorInput([normalRow(1)]);
  const input = generatorInput([normalRow(1)], { athlete: { ...base.athlete, weeklyRunDaysMax: 3 }, availability });
  const retries: string[][] = [];
  const model = {
    invoke: async (_input: unknown, retry?: { violations: string[] }) => {
      if (retry) retries.push(retry.violations);
      return draftOf([fourRunBag(1)]);
    },
  };
  const outcome = await generateWeekContent(input, model, { pmcSeed: PMC_SEED });
  assert.equal(outcome.source, "fallback");
  assert.equal(outcome.weeks[0]!.sessions.length, 3);
  assert.ok(
    retries.length > 0 && retries.every((violations) => violations.some((violation) => violation.includes("课包 4 节超过每周跑步日上限 3"))),
    "每一轮重试都把这条冲突告诉模型",
  );
});

test("课包守恒终检（devops#1054）：贪心落位、分布候选、仲裁修复、模板路径产出的课表都对固定课包逐项对账", async () => {
  const structureOf = (items: Array<{ type?: string | null | undefined; name: string }>): string[] => items.map((item) => `${item.type}:${item.name}`).sort();
  const rows = [normalRow(1), normalRow(2), normalRow(3)];
  // 贪心落位与分布候选：四跑样例四节课逐节在案（长跑 1、质量课 1、E 2）
  const scheduled = scheduleWeeks(
    rows.map((row) => fourRunBag(row.week)),
    scheduleCtxOf(rows),
  );
  assert.ok(scheduled.ok, scheduled.failures.join(";"));
  for (const [index, week] of scheduled.weeks.entries()) {
    assert.deepEqual(
      structureOf(week.sessions.filter((workout) => workout.type !== "E")),
      structureOf(fourRunBag(index + 1).courses.filter((course) => course.kind === "course")),
    );
    assert.equal(week.sessions.filter((workout) => workout.type === "E").length, 2);
  }
  // 模板路径：模板多给的 E 槽位只经仲裁置休/剪除减少，少掉的每一节都有留痕；结构课一节不少
  const input = generatorInput(rows);
  const template = templateFallback(input);
  const outcome = await generateWeekContent(
    input,
    {
      invoke: async () => {
        throw new Error("boom");
      },
    },
    { pmcSeed: PMC_SEED },
  );
  assert.equal(outcome.source, "fallback");
  for (const bag of template) {
    const week = outcome.weeks.find((candidate) => candidate.week === bag.week)!;
    assert.deepEqual(
      structureOf(week.sessions.filter((workout) => workout.type !== "E")),
      structureOf(bag.courses.filter((course) => course.kind === "course")),
    );
    const rested = outcome.repairs.filter((repair) => repair.startsWith(`W${bag.week} `) && /置休|剪除/.test(repair)).length;
    assert.equal(bag.courses.length - week.sessions.length, rested, `W${bag.week} 课表比课包少的课必须都是仲裁置休/剪除`);
  }
});

test("课包守恒终检拦下丢课：落位少了课包里的课 → 对账不符、不出课表", () => {
  const row = normalRow(1, { totalKm: 46 });
  const bag = fourRunBag(1);
  const failuresOf = (byWeekday: Record<number, PlannedCourse[]>): string[] =>
    failuresOfPlacement(instantiatePlacement({ byWeekday, row, bagCourses: bag.courses }));
  // 两种落位单看都合法（周量、P 门全过）——只是没带上课包里的某一节
  assert.deepEqual(failuresOf({ 0: [eSlot("normal")], 1: [tCourse(6)], 6: [lrCourse(20)] }), ["W1 E 槽位与课包不符：课包 2 个、落位 1 个——最终课表与课包不符"]);
  assert.deepEqual(failuresOf({ 0: [eSlot("normal")], 1: [eSlot("interval")], 6: [lrCourse(20)] }), [
    "W1 结构课 T 6km 课包 1 节、物化课表 0 节——最终课表与课包不符",
  ]);
});

test("可跑日少于声明上限：模板课包与量纲提示都按有效训练日构造——不多给排不进可跑日的课", () => {
  // 95km 双质量课周：上限 6 天时分配器给 3 个 E 槽位，只有 5 天可跑时只给 2 个
  const rows = [normalRow(1, { totalKm: 95, longRunKm: 26, qualitySessions: 2 })];
  const athlete = { weeklyRunDaysMax: 6, weekKm: 95, fitness: { ctl: 38, atl: 33, form: 5 } };
  const availability = availabilityOf([0, 1, 2, 3, 6], { allowsDoubleSessions: false }); // 周一至周四、周日
  const shrunk = generatorInput(rows, { athlete, availability });
  const declared = generatorInput(rows, { athlete: { ...athlete, weeklyRunDaysMax: 5 } });
  const hintOf = (input: ReturnType<typeof generatorInput>) => (buildContentPayload(input).week_rows as Array<{ budget_hint: string }>)[0]!.budget_hint;
  // 「上限 6 天、可跑 5 天」与「上限就是 5 天」拿到同一份量纲：模板槽数与提示一致
  const template = templateFallback(shrunk);
  assert.deepEqual(
    template.map((bag) => bag.courses.length),
    templateFallback(declared).map((bag) => bag.courses.length),
  );
  assert.ok(template[0]!.courses.length <= 5);
  assert.equal(hintOf(shrunk), hintOf(declared));
  assert.notEqual(hintOf(shrunk), hintOf(generatorInput(rows)));
  // 模板照常出课（此前靠排位阶段悄悄剪掉多给的 E 槽位）
  const scheduled = scheduleWeeks(template, scheduleCtxOf(rows, { athlete, availability }));
  assert.ok(scheduled.ok, scheduled.failures.join(";"));
  assert.ok(scheduled.weeks[0]!.calendar.every((day) => day.sessions.length <= 1));
});

test("可跑日装不下周量：模板按有效训练日也排不出 → 按「用户可用度与课包冲突」上浮（带声明天数排得下的对照），不归成实现缺陷", async () => {
  // 95km 双质量课周：声明 6 天时模板排得下；周一至周三、周日 4 天可跑时装不下
  const rows = [normalRow(1, { totalKm: 95, longRunKm: 26, qualitySessions: 2 })];
  const athlete = { weeklyRunDaysMax: 6, weekKm: 95, fitness: { ctl: 38, atl: 33, form: 5 } };
  const boom = {
    invoke: async () => {
      throw new Error("boom");
    },
  };
  await assert.rejects(
    () =>
      generateWeekContent(generatorInput(rows, { athlete, availability: availabilityOf([0, 1, 2, 6], { allowsDoubleSessions: false }) }), boom, {
        pmcSeed: PMC_SEED,
      }),
    /^Error: L4 结构性无解（用户可用度与课包冲突）：W1 每周可跑 4 天装不下周量 95km——按声明的每周跑步日上限 6 天排得下，可跑日不够$/,
  );
  // 对照：可跑日够 6 天时同一周的模板合法
  const full = await generateWeekContent(generatorInput(rows, { athlete }), boom, { pmcSeed: PMC_SEED });
  assert.equal(full.source, "fallback");
  assert.equal(full.weeks[0]!.sessions.length, 5, "6 天可跑时模板给长跑 + 2 节质量课 + 2 个 E 槽位");
});

test("周课包先校验集合、再按周序推进负荷（devops#1054）：倒序传入仍拦截「上周日质量尾段长跑接周一阈值课」", () => {
  const rows = [normalRow(1), normalRow(2, { qualitySessions: 2, totalKm: 48 })];
  const firstWeek: WeekBag = { week: 1, courses: [lrCourse(20, 4), tCourse(6), eSlot("normal"), eSlot("interval")] };
  const secondWeek: WeekBag = { week: 2, courses: [lrCourse(20), tCourse(6), tCourse(5), eSlot("interval")] };
  const availability = availabilityOf([0, 2, 5, 6]);
  const blocked = scheduleWeeks([secondWeek, firstWeek], scheduleCtxOf(rows, { availability }));
  assert.equal(blocked.ok, false);
  assert.match(blocked.failures.join(";"), /周一质量课与上周日质量课\/比赛背靠背/);
  // 可行的那组：两种顺序排出的日历、负荷序列与留痕逐项相同——周序决定排位，不是传入顺序
  const aerobic: WeekBag = { ...firstWeek, courses: [lrCourse(20), ...firstWeek.courses.slice(1)] };
  const forward = scheduleWeeks([aerobic, secondWeek], scheduleCtxOf(rows, { availability }));
  const reversed = scheduleWeeks([secondWeek, aerobic], scheduleCtxOf(rows, { availability }));
  assert.ok(forward.ok && reversed.ok, [...forward.failures, ...reversed.failures].join(";"));
  assert.deepEqual(reversed.weeks, forward.weeks);
  assert.deepEqual(reversed.distribution, forward.distribution);
});

test("课包集合校验：缺周、重周、骨架外的周先报，不带着残缺集合排位", () => {
  const ctx = scheduleCtxOf([normalRow(1), normalRow(2)]);
  const missing = scheduleWeeks([fourRunBag(2)], ctx);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.failures, ["W1 缺课包"]);
  assert.deepEqual(missing.weeks, []);
  assert.deepEqual(scheduleWeeks([fourRunBag(1), fourRunBag(1), fourRunBag(2)], ctx).failures, ["W1 课包重复"]);
  assert.deepEqual(scheduleWeeks([fourRunBag(1), { ...fourRunBag(2), week: 7 }], ctx).failures, ["W7 不在骨架行内", "W2 缺课包"]);
  assert.equal(scheduleWeeks([], scheduleCtxOf([])).ok, true, "空批照旧返回成功（生产入口另有 rows 非空断言）");
});

test("日内窗口：空数组=未指定日内时段（候选日=七天扣禁跑日）；有窗口时同时满足窗口与禁跑日", () => {
  assert.deepEqual(schedulingAvailabilityOf({ available_training_windows: [], unavailable_days: ["monday"] }).availableWeekdays, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(
    schedulingAvailabilityOf({
      available_training_windows: [
        { day: "tuesday", start_time: "06:00", end_time: "08:00" },
        { day: "thursday", start_time: "18:00", end_time: "20:00" },
      ],
      unavailable_days: ["thursday"],
    }).availableWeekdays,
    [1],
  );
  // 明细整体缺失=具体日期未知，七天皆可
  assert.equal(schedulingAvailabilityOf().availableWeekdays, null);
  assert.deepEqual(schedulingAvailabilityOf({ available_training_windows: [], unavailable_days: [] }).availableWeekdays, [0, 1, 2, 3, 4, 5, 6]);
});

test("日内时窗长度随可跑日一起归一：同日多段取最长的一段连续时间、相交的取并集不重复计时；空数组=未指定（不限）", () => {
  const { windowMinutes, availableWeekdays } = schedulingAvailabilityOf({
    available_training_windows: [
      { day: "sunday", start_time: "06:00", end_time: "08:00" },
      { day: "sunday", start_time: "07:00", end_time: "09:30" }, // 相交：并集 06:00–09:30 = 210min（相加会误成 270）
      { day: "tuesday", start_time: "06:00", end_time: "07:00" },
      { day: "tuesday", start_time: "18:00", end_time: "19:00" }, // 两个独立的 60min：单课装得下的最长一段仍是 60
      { day: "friday", start_time: "23:30", end_time: "00:30" }, // 跨午夜
      { day: "wednesday", start_time: "07:00", end_time: "07:00" }, // 起止相同=零长度，不是一整天
    ],
  });
  assert.equal(windowMinutes?.[6], 210);
  assert.equal(windowMinutes?.[1], 60);
  assert.equal(windowMinutes?.[4], 60);
  assert.equal(windowMinutes?.[0], 0, "没有时窗的日子为 0");
  assert.equal(windowMinutes?.[2], 0);
  assert.ok(!availableWeekdays?.includes(2), "零长度时窗的日子不可跑");
  assert.equal(schedulingAvailabilityOf({ available_training_windows: [] }).windowMinutes, null);
  assert.equal(schedulingAvailabilityOf().windowMinutes, null);
});

/** 时窗明细：周一至周六 06:00–10:00；周日按参数给（可多段，缺省同长）。 */
const windowsWith = (sunday: Array<[string, string]> = [["06:00", "10:00"]], weekdayEnd = "10:00") => [
  ...(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const).map((day) => ({ day, start_time: "06:00", end_time: weekdayEnd })),
  ...sunday.map(([start_time, end_time]) => ({ day: "sunday" as const, start_time, end_time })),
];

test("日内时窗进最终硬校验：周日 30min 时窗拒绝 104min 长跑，带日期与冲突上浮", () => {
  const availability = schedulingAvailabilityOf({ available_training_windows: windowsWith([["06:00", "06:30"]]) });
  const result = scheduleWeeks([fourRunBag(1)], scheduleCtxOf([normalRow(1)], { availability }));
  assert.equal(result.ok, false);
  assert.match(result.failures[0]!, /^W1 长跑 20km≈104min 超出周日（2026-12-06）的可训练时段（时窗 30min）/);
  assert.deepEqual(result.conflicts, [result.failures[0]], "编排层据 conflicts 归类结构性无解");
});

test("时窗装不下模板的长跑：重试清单与最终上浮都指向这条冲突，不归成实现缺陷", async () => {
  const input = generatorInput([normalRow(1)], { availability: schedulingAvailabilityOf({ available_training_windows: windowsWith([["06:00", "06:30"]]) }) });
  const retries: string[][] = [];
  const model = {
    invoke: async (_input: unknown, retry?: { violations: string[] }) => {
      if (retry) retries.push(retry.violations);
      return draftOf([fourRunBag(1)]);
    },
  };
  await assert.rejects(
    () => generateWeekContent(input, model, { pmcSeed: PMC_SEED }),
    /L4 结构性无解（用户可用度与课包冲突）：W1 长跑 20km≈104min 超出周日（2026-12-06）的可训练时段（时窗 30min）/,
    "模板的长跑同样装不下——按用户可用度冲突上浮",
  );
  assert.ok(
    retries.some((violations) => violations.some((violation) => violation.includes("超出周日"))),
    "重试清单带上冲突",
  );
});

test("用户选的单课上限不再进排课（devops#1054）：明细里带着 max_session_duration_min=70，104 分钟的长跑照常排出", () => {
  const availability = schedulingAvailabilityOf({
    available_training_windows: [],
    unavailable_days: [],
    max_session_duration_min: 70,
    allows_double_sessions: false,
  });
  assert.deepEqual(availability, { availableWeekdays: [0, 1, 2, 3, 4, 5, 6], windowMinutes: null, allowsDoubleSessions: false });
  const result = scheduleWeeks([fourRunBag(1)], scheduleCtxOf([normalRow(1)], { availability }));
  assert.ok(result.ok, result.failures.join(";"));
});

/** 一周七天日历：只在周二放指定的那节课，其余日休息（配一条负荷序列，供直接过门）。 */
function weekCalendarWith(workout: RunWorkout): { calendar: CalendarDay[]; loadSeries: LoadSeriesPoint[] } {
  return {
    calendar: Array.from({ length: 7 }, (_, di) => ({
      week: 1,
      date: addDays(PLAN_START_MONDAY, di),
      day: DAY_LABELS[di as 0 | 1 | 2 | 3 | 4 | 5 | 6],
      sessions: di === 1 ? [workout] : [],
    })),
    loadSeries: Array.from({ length: 7 }, (_, di) => {
      const acute = 38 + di * 0.5;
      return {
        date: addDays(PLAN_START_MONDAY, di),
        week: 1,
        loadPt: di === 1 ? 56 : 0,
        atl: acute,
        ctl: 38,
        ratio: Math.round((acute / 38) * 100) / 100,
        sessions: di === 1 ? [workout.name] : [],
      };
    }),
  };
}

test("长跑上限按能力派生并进最终硬校验（devops#1054）：180 分钟 @ 当周 E 配速中点、至多 40km", () => {
  // E 带中点 312s/km：180×60÷312 = 34.615 → 向下取整到 0.1 = 34.6
  // 跑进 4'10"/km 的 E 带中点 250s/km：180 分钟 = 43.2km → 封在 40km（六带整体上移，E 配速才不会落进 M/T 带）
  const FAST = { easy: [240, 260], m: [215, 240], t: [205, 215], i: [195, 205], r: [null, 195] } as const;
  // totalKm 跟着长跑走：有氧份额门（P7）要求轻松课占够比例，周量定死会让它先挂
  const overCapFailures = (zones: PaceZones, longRunKm: number, totalKm: number) =>
    failuresOfPlacement(
      instantiatePlacement({
        byWeekday: { 0: [eSlot("normal")], 3: [eSlot("normal")], 6: [lrCourse(longRunKm)] },
        row: normalRow(1, { totalKm, longRunKm, zones }),
        bagCourses: [lrCourse(longRunKm), eSlot("normal"), eSlot("normal")],
      }),
    );
  assert.deepEqual(overCapFailures(ZONES, 34.6, 60), []);
  assert.match(overCapFailures(ZONES, 34.7, 60)[0]!, /长跑 34\.7km 超出长跑上限 34\.6km（180 分钟 @ E 配速，至多 40km）$/);
  assert.deepEqual(overCapFailures(FAST, 40, 70), []);
  assert.match(overCapFailures(FAST, 40.1, 70)[0]!, /长跑 40\.1km 超出长跑上限 40km（180 分钟 @ E 配速，至多 40km）$/);
});

test("日常有氧上限 = 普通日时长带上限 90 分钟（devops#1054）：终检拦下超过 90 分钟的轻松课", () => {
  const easyOf = (minutes: number): RunWorkout =>
    normalizeRunWorkout({
      name: `E ${minutes}min`,
      date: addDays(PLAN_START_MONDAY, 1),
      type: "E",
      purpose: "有氧轻松课。",
      blocks: [
        {
          repeat: 1,
          steps: [
            {
              step_kind: "work",
              duration: { kind: "time_s", value: minutes * 60 },
              target: { kind: "pace_s_km", low: 288, high: 336 },
              note: null,
              hr_cap_bpm: null,
            },
          ],
        },
      ],
    });
  const p9Of = (minutes: number) => {
    const { calendar, loadSeries } = weekCalendarWith(easyOf(minutes));
    return scheduleGates({ calendar, loadSeries, row: normalRow(1), daysMax: 4, raceDate: null, coefficients: DEFAULT_DOSE_COEFFICIENTS }).find(
      (check) => check.id === "P9 单课时长",
    )!;
  };
  assert.deepEqual(p9Of(90), { id: "P9 单课时长", pass: true, detail: "全过" });
  assert.deepEqual(p9Of(95), { id: "P9 单课时长", pass: false, detail: "2026-12-01 有氧课 95min 超出日常有氧上限 90min" });
});

test("同日多个时窗：单课须装进连续的一段——两段各 60min 装不下 104min 长跑，相交并成一段 210min 就装得下；空时窗=不限", () => {
  const ctxOf = (sunday: Array<[string, string]>) =>
    scheduleCtxOf([normalRow(1)], { availability: schedulingAvailabilityOf({ available_training_windows: windowsWith(sunday) }) });
  const disjoint = scheduleWeeks(
    [fourRunBag(1)],
    ctxOf([
      ["06:00", "07:00"],
      ["18:00", "19:00"],
    ]),
  );
  assert.equal(disjoint.ok, false);
  assert.match(disjoint.failures[0]!, /^W1 长跑 20km≈104min 超出周日（2026-12-06）的可训练时段（时窗 60min）/);
  assert.ok(
    scheduleWeeks(
      [fourRunBag(1)],
      ctxOf([
        ["06:00", "08:00"],
        ["07:00", "09:30"],
      ]),
    ).ok,
  );
  assert.ok(scheduleWeeks([fourRunBag(1)], scheduleCtxOf([normalRow(1)], { availability: schedulingAvailabilityOf({ available_training_windows: [] }) })).ok);
});

test("赛日本身豁免：比赛课不受日内时窗约束，赛周其余课照常受限", () => {
  const race = { ...RACE, date: addDays(PLAN_START_MONDAY, 6) }; // 第 1 周周日
  const ctxOf = (weekdayEnd: string) =>
    scheduleCtxOf([raceRow(1)], {
      race,
      availability: schedulingAvailabilityOf({ available_training_windows: windowsWith([["06:00", "06:30"]], weekdayEnd) }),
    });
  // 42.2km 比赛课（≈3 小时）落在 30min 时窗之下照常通过——比赛日是目标事件不是训练课
  const raceWeek = scheduleWeeks([raceBag(1)], ctxOf("10:00"));
  assert.ok(raceWeek.ok, raceWeek.failures.join(";"));
  assert.ok(raceWeek.weeks[0]!.checks.every((check) => check.pass));
  // 赛前激活课（热身 15min + 4km ≈31min）不是目标事件：周一至周六只剩 30min 时窗时被拦下并点名
  const blocked = scheduleWeeks([raceBag(1)], ctxOf("06:30"));
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.conflicts, ["W1 赛前激活 M 4km+strides≈31min 超出可跑日（一/二/三/四/五）的可训练时段（最长 30min）"]);
  assert.match(blocked.failures.join(";"), /P9 单课时长：.*赛前激活 M 4km\+strides≈\d+min 超出/);
});

/** 手工搭结构课的步。 */
type Step = StructuredCourse["blocks"][number]["steps"][number];
const OPEN = { kind: "open", low: null, high: null } as const;
const EASY = { kind: "pace_s_km", low: 288, high: 336 } as const;
const stepOf = (step_kind: Step["step_kind"], duration: Step["duration"], target: Step["target"], rest?: Step["rest"]): Step => ({
  step_kind,
  duration,
  target,
  note: null,
  hr_cap_bpm: null,
  ...(rest != null ? { rest } : {}),
});

test("禁止双练时 P6 换日不落到已有轻松跑的一天（devops#1054）：112km 周 >110km，旧判据只查「不是质量课日」会放行这样造出的双练日", () => {
  const row = normalRow(1, { totalKm: 112, longRunKm: 32, qualitySessions: 1 });
  const allWeek = [0, 1, 2, 3, 4, 5, 6];
  // 种子 56/44：周一阈值课当日比值越 cap，得往后挪；可周二至周五都排着轻松课——没有合法的空平日
  // 就不换日，如实报 P6 无解，而不是把阈值课叠到周二的轻松课上（112km >110km，P5 的周量判据拦不住）
  const crowded = { 0: [tCourse(12)], 1: [eSlot("normal")], 2: [eSlot("normal")], 3: [eSlot("normal")], 4: [eSlot("interval")], 6: [lrCourse(32)] };
  const heavy = { acute: 56, chronic: 44 };
  const blocked = instantiatePlacement({
    byWeekday: crowded,
    row,
    daysMax: 6,
    pmc: heavy,
    availability: availabilityOf(allWeek, { allowsDoubleSessions: false }),
  });
  assert.equal("schedule" in blocked, false);
  assert.match(failuresOfPlacement(blocked).join(";"), /P6 日负荷比 1\.32 超 cap 1\.3（2026-11-30）/);
  // 双练获准时（未声明=沿用周量准入）：叠到轻松课日照旧可行，由 P5 把关
  const stacked = instantiatePlacement({ byWeekday: crowded, row, daysMax: 6, pmc: heavy });
  assert.ok("schedule" in stacked, failuresOfPlacement(stacked).join(";"));
  assert.equal(stacked.schedule.calendar[1]!.sessions.length, 2, "阈值课挪到周二，与轻松课同日");
  assert.ok(stacked.schedule.checks.every((check) => check.pass));
  // 周五真的空着：换日照常把周四的阈值课挪到空平日，课表全门通过
  const moved = instantiatePlacement({
    byWeekday: { 0: [eSlot("normal")], 1: [eSlot("normal")], 2: [eSlot("normal")], 3: [tCourse(12)], 5: [eSlot("interval")], 6: [lrCourse(32)] },
    row,
    daysMax: 6,
    pmc: { acute: 38, chronic: 34 },
    availability: availabilityOf(allWeek, { allowsDoubleSessions: false }),
  });
  assert.ok("schedule" in moved, failuresOfPlacement(moved).join(";"));
  assert.deepEqual(
    moved.schedule.calendar.map((day) => day.sessions.map((workout) => workout.name).join("+") || "休"),
    ["E 90min", "E 90min", "E 90min", "休", "T 12km", "E 42min", "长跑 32km"],
  );
  assert.ok(moved.schedule.checks.every((check) => check.pass));
});

test("P9 按含休息的墙钟时长判：间歇课的组间休息同样占用时窗（只算跑步时长会放行）", () => {
  const row = normalRow(1);
  const work = stepOf("work", { kind: "distance_m", value: 1000 }, { kind: "pace_s_km", low: 220, high: 230 });
  // I 课：热身 15min + 5×(1000m + 组间休息 2min) + 放松 10min——跑步 43.75min，含休息 53.75min
  const intervalCourse = (steps: Step[]): StructuredCourse => ({
    kind: "course",
    name: "I 5×1km",
    type: "I",
    purpose: "间歇课：提升最大摄氧量。",
    note: null,
    blocks: [
      { repeat: 1, steps: [stepOf("warmup", { kind: "time_s", value: 900 }, EASY)] },
      { repeat: 5, steps },
      { repeat: 1, steps: [stepOf("cooldown", { kind: "time_s", value: 600 }, EASY)] },
    ],
  });
  // 周一 E、周二 I 课、周三 E、周日长跑（周三没有质量课夹在中间 → 普通日带）
  const byWeekday = (course: StructuredCourse): Record<number, PlannedCourse[]> => ({
    0: [eSlot("normal")],
    1: [course],
    2: [eSlot("normal")],
    6: [lrCourse(20)],
  });
  const windowsOf = (tuesdayEnd: string) =>
    schedulingAvailabilityOf({
      available_training_windows: [
        { day: "monday", start_time: "06:00", end_time: "10:00" },
        { day: "wednesday", start_time: "06:00", end_time: "10:00" },
        { day: "tuesday", start_time: "06:00", end_time: tuesdayEnd },
        { day: "sunday", start_time: "06:00", end_time: "10:00" },
      ],
    });
  const restStep = [work, stepOf("rest", { kind: "time_s", value: 120 }, OPEN)];
  const inlineRest = [{ ...work, rest: { kind: "time_s" as const, value: 120 } }];
  for (const [label, steps] of [
    ["独立 rest 步", restStep],
    ["步后 rest 字段", inlineRest],
  ] as const) {
    const tight = instantiatePlacement({ byWeekday: byWeekday(intervalCourse([...steps])), row, availability: windowsOf("06:50") });
    assert.deepEqual(failuresOfPlacement(tight), [`W1 P9 单课时长：2026-12-01 I 5×1km≈54min 超出可训练时段（时窗 50min）`], label);
    assert.deepEqual(
      failuresOfPlacement(instantiatePlacement({ byWeekday: byWeekday(intervalCourse([...steps])), row, availability: windowsOf("07:00") })),
      [],
      label,
    );
  }
  // 时长不可知的休息（心率型）无法保证装得下
  const unknown = instantiatePlacement({
    byWeekday: byWeekday(intervalCourse([{ ...work, rest: { kind: "hr_bpm" as const, value: 120 } }])),
    row,
    availability: windowsOf("07:00"),
  });
  assert.deepEqual(failuresOfPlacement(unknown), ["W1 P9 单课时长：2026-12-01 I 5×1km 休息时长不可知——须写成 time_s 的 rest 步"]);
  // 没声明时窗=时长不受限，不必知道休息多久：同一条心率型休息的课照常通过
  //（小程序总会声明禁跑日/双练许可，但多数人不填日内时段——不能因此拒掉心率型间歇课）
  const hrRest = byWeekday(intervalCourse([{ ...work, rest: { kind: "hr_bpm" as const, value: 120 } }]));
  assert.deepEqual(
    failuresOfPlacement(
      instantiatePlacement({ byWeekday: hrRest, row, availability: schedulingAvailabilityOf({ unavailable_days: ["friday"], allows_double_sessions: false }) }),
    ),
    [],
    "声明了可用度但没声明时窗",
  );
  assert.deepEqual(failuresOfPlacement(instantiatePlacement({ byWeekday: hrRest, row })), [], "完全没声明可用度");
});

test("双练日：声明了时窗时，轻松课只占用结构课剩下的时段", () => {
  const row = normalRow(1, { totalKm: 112, longRunKm: 32, qualitySessions: 2 });
  const [longRun, firstQuality, secondQuality, mondayEasy, fridayEasy, tuesdayEasy, saturdayEasy] = [
    lrCourse(32),
    tCourse(14),
    tCourse(14),
    eSlot("normal"),
    eSlot("normal"),
    eSlot("interval"),
    eSlot("interval"),
  ];
  const long = { start_time: "06:00", end_time: "10:00" };
  const availability = schedulingAvailabilityOf({
    available_training_windows: [
      { day: "monday", ...long },
      { day: "tuesday", start_time: "06:00", end_time: "08:00" }, // 阈值课（≈81min）之外只剩 39min
      { day: "wednesday", ...long },
      { day: "thursday", ...long },
      { day: "friday", ...long },
      { day: "sunday", ...long },
    ],
  });
  const result = instantiatePlacement({
    byWeekday: { 0: [mondayEasy], 1: [firstQuality, tuesdayEasy], 3: [secondQuality], 4: [fridayEasy], 5: [saturdayEasy], 6: [longRun] },
    row,
    availability,
    daysMax: 6,
  });
  assert.ok("schedule" in result, failuresOfPlacement(result).join(";"));
  const [quality, easy] = result.schedule.calendar[1]!.sessions;
  assert.ok(quality && easy, "周二双练（112km >110km，用户未禁止）");
  assert.equal(quality.name, "T 14km");
  assert.equal(easy.name, "E 39min", "轻松课让出阈值课占掉的 81min：120 − 81 = 39");
  // 对照：没有时窗时同一落位的轻松课是 74min
  const unbounded = instantiatePlacement({
    byWeekday: { 0: [mondayEasy], 1: [firstQuality, tuesdayEasy], 3: [secondQuality], 4: [fridayEasy], 5: [saturdayEasy], 6: [longRun] },
    row,
    daysMax: 6,
  });
  assert.ok("schedule" in unbounded, failuresOfPlacement(unbounded).join(";"));
  assert.equal(unbounded.schedule.calendar[1]!.sessions[1]!.name, "E 74min");
  assert.ok(result.schedule.checks.every((check) => check.pass));
});

test("结构课装不进可训练时段：阈值课在可跑平日里找不到一天容得下 → 带具体时段的冲突；禁跑日上的时窗不算数", () => {
  const bigQuality: WeekBag = { week: 1, courses: [lrCourse(20), tCourse(20), eSlot("normal"), eSlot("interval")] };
  // 周一至周五各 90min、周日 240min：长跑（104min）放得下，阈值课（≈106min）放不下
  const tight = scheduleWeeks(
    [bigQuality],
    scheduleCtxOf([normalRow(1, { totalKm: 60 })], { availability: schedulingAvailabilityOf({ available_training_windows: windowsWith(undefined, "07:30") }) }),
  );
  assert.equal(tight.ok, false);
  assert.deepEqual(tight.conflicts, ["W1 T 20km≈106min 超出可跑日（一/二/三/四/五）的可训练时段（最长 90min）"]);
  // 可跑平日最长的一段时窗容不下普通轻松课下限（60min）
  const shortEasy = "W1 可跑平日的可训练时段最长 45min，低于普通轻松课下限 60min——普通 E 日无法在许可时长内排课";
  assert.deepEqual(
    scheduleWeeks(
      [fourRunBag(1)],
      scheduleCtxOf([normalRow(1)], { availability: schedulingAvailabilityOf({ available_training_windows: windowsWith(undefined, "06:45") }) }),
    ).conflicts,
    [shortEasy],
  );
  // 周二标成禁跑日：它那段 240min 的时窗不参与「可跑平日最长时窗」
  const tuesdayOff = schedulingAvailabilityOf({
    available_training_windows: [
      { day: "tuesday", start_time: "06:00", end_time: "10:00" },
      ...(["monday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const).map((day) => ({ day, start_time: "06:00", end_time: "06:45" })),
    ],
    unavailable_days: ["tuesday"],
  });
  assert.deepEqual(scheduleWeeks([fourRunBag(1)], scheduleCtxOf([normalRow(1)], { availability: tuesdayOff })).conflicts, [shortEasy]);
});

test("双练准入=周量门槛 ∧ 用户许可：未声明/许可照旧出双练；明确不允许则带具体冲突无解，重试文案与上浮都指向双练", async () => {
  const row = normalRow(1, { totalKm: 118, longRunKm: 32, qualitySessions: 2 });
  const bag: WeekBag = { week: 1, courses: [lrCourse(32), tCourse(12), tCourse(11), eSlot("normal"), eSlot("normal"), eSlot("interval"), eSlot("interval")] };
  const ctxOf = (allowsDoubleSessions: boolean | null) =>
    scheduleCtxOf([row], { athlete: { weeklyRunDaysMax: 5 }, availability: availabilityOf([0, 1, 2, 3, 4, 5, 6], { allowsDoubleSessions }) });
  for (const permission of [null, true]) {
    const allowed = scheduleWeeks([bag], ctxOf(permission));
    assert.ok(allowed.ok, allowed.failures.join(";"));
    assert.ok(
      allowed.weeks[0]!.calendar.some((day) => day.sessions.length > 1),
      `许可=${permission} 时 >110km 周出双练日`,
    );
  }
  const refused = scheduleWeeks([bag], ctxOf(false));
  assert.equal(refused.ok, false);
  assert.match(refused.failures[0]!, /^W1 双练未获许可：课包 7 节超过每周跑步日上限 5——周量 118km 的课包需一天两练才装得下/);
  assert.deepEqual(refused.conflicts, [refused.failures[0]]);

  // 真实生成入口：重试清单把真正的约束告诉模型；模板也装不下时按「结构性无解 + 具体冲突」上浮，不是「实现缺陷」
  const base = generatorInput([row]);
  const input = generatorInput([row], {
    athlete: { ...base.athlete, weeklyRunDaysMax: 5 },
    availability: availabilityOf([0, 1, 2, 3, 4, 5, 6], { allowsDoubleSessions: false }),
  });
  const retries: string[][] = [];
  const model = {
    invoke: async (_input: unknown, retry?: { violations: string[] }) => {
      if (retry) retries.push(retry.violations);
      return draftOf([bag]);
    },
  };
  await assert.rejects(() => generateWeekContent(input, model, { pmcSeed: PMC_SEED }), /L4 结构性无解（用户可用度与课包冲突）：W1 双练未获许可/);
  assert.ok(retries.length > 0 && retries.some((violations) => violations.some((violation) => violation.includes("双练未获许可"))), "重试清单带上双练冲突");
});

test("跨周：后一周接前一周排位产物；周一质量课与上周日质量课背靠背=硬约束无解", () => {
  // 周量 48km：两节质量课 + 长跑后只剩周六轻量 E 的容量，保证体积可行（否则周量先报、盖不住要测的间隔约束）
  const rows = [normalRow(1), normalRow(2, { qualitySessions: 2, totalKm: 48 })];
  const secondWeek: WeekBag = { week: 2, courses: [lrCourse(20), tCourse(6), tCourse(5), eSlot("interval")] };
  const availability = availabilityOf([0, 2, 5, 6]); // 平日只有周一/周三 → 两节质量课只能周一+周三
  const ctx = () => scheduleCtxOf(rows, { availability });

  const qualityLongRun: WeekBag = { week: 1, courses: [lrCourse(20, 4), tCourse(6), eSlot("normal"), eSlot("interval")] }; // 长跑带 M 配速尾段=质量课
  const blocked = scheduleWeeks([qualityLongRun, secondWeek], ctx());
  assert.equal(blocked.ok, false);
  assert.match(blocked.failures.join(";"), /周一质量课与上周日质量课\/比赛背靠背/);

  const aerobicLongRun: WeekBag = { ...qualityLongRun, courses: [lrCourse(20), ...qualityLongRun.courses.slice(1)] };
  const aerobic = scheduleWeeks([aerobicLongRun, secondWeek], ctx());
  assert.ok(aerobic.ok, aerobic.failures.join(";"));
  assert.deepEqual(
    aerobic.distribution[1]!.prefix,
    factsOfDays(aerobic.weeks[0]!.calendar, aerobic.weeks[0]!.loadSeries, rows[0]!.zones, null),
    "后一周的前缀=前一周排位产物",
  );
  assert.ok(weekdaysOf(aerobic.weeks[1]!.sessions).includes(0), "上周日长跑是纯有氧时周一质量课可以排");
});

test("跨批次：下一批带上一批末周日历与负荷种子——批界上的质量课间隔同样检查", async () => {
  const rows = [normalRow(1), normalRow(2), normalRow(3)];
  const bags = rows.map((row) => fourRunBag(row.week));
  const first = await generateWeekContent(generatorInput(rows), modelOf(bags), { pmcSeed: PMC_SEED });
  assert.equal(first.source, "llm", first.attemptsDetail.map((detail) => detail.parseError ?? detail.violations.join(";")).join("|"));
  assert.deepEqual({ acute: first.loadMeta.seed.acute, chronic: first.loadMeta.seed.chronic }, PMC_SEED, "负荷种子原样进入排位");

  const last = first.loadSeries.at(-1)!;
  const nextRows = [normalRow(4, { qualitySessions: 2, totalKm: 48 })];
  const nextBags: WeekBag[] = [{ week: 4, courses: [lrCourse(20), tCourse(6), tCourse(5), eSlot("interval")] }];
  const nextInput = (batch: ScheduledOutcome) =>
    generatorInput(nextRows, {
      availability: availabilityOf([0, 2, 5, 6]),
      boundary: factsOfDays(batch.calendar.slice(-7), batch.loadSeries.slice(-7), rows[2]!.zones, null),
    });
  const nextSeed = { acute: last.atl, chronic: last.ctl };

  const second = await generateWeekContent(nextInput(first), modelOf(nextBags), { pmcSeed: nextSeed });
  assert.equal(second.source, "llm");
  assert.deepEqual({ acute: second.loadMeta.seed.acute, chronic: second.loadMeta.seed.chronic }, nextSeed, "批界链式传递上批末态种子");
  assert.deepEqual(
    second.distribution[0]!.prefix,
    factsOfDays(first.calendar.slice(-7), first.loadSeries.slice(-7), rows[2]!.zones, null),
    "批首周接上批末周日历",
  );

  // 上批末周长跑带质量尾段：批界另一侧被迫排在周一的质量课被拦下，重试耗尽后带具体冲突上浮
  const qualityTail: WeekBag = { ...bags[2]!, courses: [lrCourse(20, 4), ...bags[2]!.courses.slice(1)] };
  const withQuality = await generateWeekContent(generatorInput(rows), modelOf([bags[0]!, bags[1]!, qualityTail]), { pmcSeed: PMC_SEED });
  await assert.rejects(
    () =>
      generateWeekContent(nextInput(withQuality), modelOf(nextBags), {
        pmcSeed: { acute: withQuality.loadSeries.at(-1)!.atl, chronic: withQuality.loadSeries.at(-1)!.ctl },
      }),
    /L4 结构性无解.*周一质量课与上周日质量课\/比赛背靠背/s,
  );
});

test("未知边界：首周之前状态未知——连续段只报告可观测部分；存量仅天数上限=具体可跑日未知", () => {
  const result = scheduleWeeks([fourRunBag(1)], scheduleCtxOf([normalRow(1)]));
  const audit = result.distribution[0]!;
  assert.equal(audit.prefix.length, 7);
  assert.ok(audit.prefix.every((day) => day.run === null && day.loadPt == null));
  assert.equal(audit.prefix[6]!.date, addDays(PLAN_START_MONDAY, -1));
  assert.equal(audit.suffix, null);
  assert.ok(audit.constraints.includes("具体可跑日未知（仅每周天数上限）"));
});

test("已锁定日期（上一周已生效的安排）作为边界：原样进入前缀，选定落位不把已知连跑段续长", () => {
  const rest = (date: string): DayFact => ({ date, run: false, runMinutes: 0, loadPt: 0, key: false, quality: false });
  // 上周四阈值课、周五/周六轻量跑、周日的长跑已发生或仍生效：到上周日已连跑 3 天
  const boundary = [
    rest(addDays(PLAN_START_MONDAY, -7)),
    rest(addDays(PLAN_START_MONDAY, -6)),
    rest(addDays(PLAN_START_MONDAY, -5)),
    rest(addDays(PLAN_START_MONDAY, -4)),
    { date: addDays(PLAN_START_MONDAY, -3), run: true, runMinutes: 60, loadPt: 46, key: true, quality: true },
    { date: addDays(PLAN_START_MONDAY, -2), run: true, runMinutes: 40, loadPt: 24, key: false, quality: false },
    { date: addDays(PLAN_START_MONDAY, -1), run: true, runMinutes: 104, loadPt: 61, key: true, quality: false },
  ];
  const result = scheduleWeeks([fourRunBag(1)], scheduleCtxOf([normalRow(1)], { boundary }));
  assert.ok(result.ok, result.failures.join(";"));
  const audit = result.distribution[0]!;
  assert.deepEqual(audit.prefix, boundary);
  const chosen = audit.candidates[audit.chosen]!;
  // 交界段（上周六/日 + 本周一）计入：上周六起算的连跑不得超过 3 天
  assert.ok(audit.finalMetrics.longestRun.days <= 3, "上周六/日已连跑，选定落位不得把交界连跑续到 4 天");
  assert.ok(!chosen.runDays.includes(0), "周一留恢复日");
});

test("赛周：比赛日固定、激活课避开禁跑日；赛周不枚举候选", () => {
  const raceDate = addDays(PLAN_START_MONDAY, 13); // 第 2 周周日
  const rows = [normalRow(1), normalRow(2, { role: "race", totalKm: 52.2, longRunKm: null, qualitySessions: 2 })];
  const input = generatorInput(rows, { race: { ...RACE, date: raceDate } });
  const availability = availabilityOf([0, 2, 3, 4, 5, 6]); // 周二不可跑
  const result = scheduleWeeks(templateFallback(input), scheduleCtxOf(rows, { availability, race: input.race }));
  assert.ok(result.ok, result.failures.join(";"));
  assert.equal(result.distribution.length, 1, "只有常规周有分布留痕");
  const raceWeek = result.weeks[1]!;
  assert.ok(!weekdaysOf(raceWeek.sessions).includes(1), "赛周无课落在禁跑日");
  assert.equal(raceWeek.calendar[6]!.sessions.length, 1, "比赛日恰一节");
  assert.equal(raceWeek.calendar[6]!.sessions[0]!.date, raceDate);
  assert.ok(raceWeek.checks.every((check) => check.pass));
});

test("赛周激活窗没有可跑日：激活课不挪到通勤日/赛前隔日，带具体冲突上浮", () => {
  const raceDate = addDays(PLAN_START_MONDAY, 6);
  const availability = availabilityOf([0, 5, 6]); // 周一/周六/周日：激活窗（周二~周五）全不可跑
  const result = scheduleWeeks([raceBag(1)], scheduleCtxOf([raceRow(1)], { availability, race: { ...RACE, date: raceDate } }));
  assert.equal(result.ok, false);
  assert.match(result.failures[0]!, /^W1 赛前激活窗（二\/三\/四\/五）没有可跑日，可跑日=一\/六\/日——赛前激活课 .* 无处可排/);
  assert.deepEqual(result.conflicts, [result.failures[0]]);
});

test("边界日历取数：已发生日用实绩、其后用存量周安排、都没有=未知；活动按 Provider 的 shanghaiDay 归日", () => {
  // UTC 周日 16:30 = 北京周一 00:30 → shanghaiDay 是周一，属于新的一周
  const sundayNightUtc = "2026-11-29T16:30:00Z";
  assert.equal(shanghaiDay(sundayNightUtc), PLAN_START_MONDAY);
  const nightRun = {
    shanghaiDay: shanghaiDay(sundayNightUtc),
    name: "夜跑",
    sport: "run",
    distanceM: 12000,
    strideSessionClass: "long_easy",
    durationS: 4000,
    strideDose: 70,
  };
  const saturdayRun = {
    shanghaiDay: "2026-11-28",
    name: "周六轻松跑",
    sport: "run",
    distanceM: 6000,
    strideSessionClass: "easy",
    durationS: 1900,
    strideDose: 20,
  };

  const boundary = boundaryBefore({ startMonday: PLAN_START_MONDAY, asOfDay: PLAN_START_MONDAY, activities: [nightRun, saturdayRun] });
  assert.deepEqual(boundary[6], { date: "2026-11-29", run: false, runMinutes: 0, loadPt: 0, key: false, quality: false }, "北京时间周一凌晨的活动不进上周日");
  assert.deepEqual(boundary[5], { date: "2026-11-28", run: true, runMinutes: 1900 / 60, loadPt: 20, key: false, quality: false });
  assert.ok(
    boundary.slice(0, 5).every((day) => day.run === false),
    "过去无跑步活动的日期=按实绩休息",
  );
  // 同一条活动在下一批（12-07 起）的边界里按 shanghaiDay 落在 11-30（新一周的周一）
  const nextBatch = boundaryBefore({ startMonday: addDays(PLAN_START_MONDAY, 7), asOfDay: addDays(PLAN_START_MONDAY, 7), activities: [nightRun, saturdayRun] });
  assert.deepEqual(nextBatch[0], { date: PLAN_START_MONDAY, run: true, runMinutes: 4000 / 60, loadPt: 70, key: true, quality: false });

  // 其后的日期：无存量周文档=未知；有则按生效安排（spec 为空的跑步会话仍算跑步，关键课属性未知）
  const saturday = addDays(PLAN_START_MONDAY, -2);
  const doc = {
    sessions: [
      { date: saturday, kind: "run", spec: null, total_duration_s: 3600, estimated_dose: 35 },
      { date: addDays(PLAN_START_MONDAY, -1), kind: "rest", spec: null, total_duration_s: null, estimated_dose: null },
    ],
  } as unknown as WeeklyPlan;
  const unknownFuture = boundaryBefore({ startMonday: PLAN_START_MONDAY, asOfDay: saturday, activities: [saturdayRun] });
  assert.equal(unknownFuture[6]!.run, null);
  const planned = boundaryBefore({ startMonday: PLAN_START_MONDAY, asOfDay: saturday, activities: [saturdayRun], existingDoc: doc });
  assert.deepEqual(planned[6], { date: addDays(PLAN_START_MONDAY, -1), run: false, runMinutes: 0, loadPt: 0, key: false, quality: false });
  assert.deepEqual(boundaryBefore({ startMonday: PLAN_START_MONDAY, asOfDay: addDays(PLAN_START_MONDAY, -3), activities: [], existingDoc: doc })[5], {
    date: saturday,
    run: true,
    runMinutes: 60,
    loadPt: 35,
    key: null,
    quality: null,
  });
  // 生成当天还没有跑步活动≠休息（上午生成、下午的课还没发生）：有生效安排按安排，没有安排=未知
  assert.deepEqual(boundaryBefore({ startMonday: PLAN_START_MONDAY, asOfDay: saturday, activities: [], existingDoc: doc })[5], {
    date: saturday,
    run: true,
    runMinutes: 60,
    loadPt: 35,
    key: null,
    quality: null,
  });
  const todayUnknown = boundaryBefore({ startMonday: PLAN_START_MONDAY, asOfDay: saturday, activities: [nightRun] })[5]!;
  assert.equal(todayUnknown.run, null);
});

test("发布周的日事实（devops#1054）：文档里有安排的日期按安排（调整保留的已过安排照算）；冻结掉的已过日期有实绩按实绩、没有覆盖=未知", () => {
  const weekMonday = PLAN_START_MONDAY;
  const run = (date: string): WeeklyPlan["sessions"][number] => ({
    schema: "plan-session/v1",
    date,
    session_index: 0,
    kind: "run",
    summary: "有氧跑",
    notes_md: null,
    total_distance_m: 8000,
    total_duration_s: 2880,
    estimated_dose: 47.2,
    spec: null,
  });
  const rest = (date: string): WeeklyPlan["sessions"][number] => ({
    ...run(date),
    kind: "rest",
    summary: "休息",
    total_distance_m: null,
    total_duration_s: null,
    estimated_dose: null,
    spec: null,
  });
  // 追赶冻结后的周文档：周一至周五没有行，周六休息、周日长跑
  const frozen = { sessions: [rest(addDays(weekMonday, 5)), run(addDays(weekMonday, 6))] } as unknown as WeeklyPlan;
  const friday = addDays(weekMonday, 4);
  const tuesdayRun = {
    shanghaiDay: addDays(weekMonday, 1),
    name: "周二有氧",
    sport: "run",
    distanceM: 9000,
    strideSessionClass: "easy",
    durationS: 3000,
    strideDose: 29,
  };
  const covered = publishedWeekFacts({ weekMonday, asOfDay: friday, activities: [tuesdayRun], doc: frozen, zones: null });
  assert.deepEqual(
    covered.map((day) => day.run),
    [false, true, false, false, null, false, true],
    "实绩覆盖：周一/周三/周四没跑=休息、周二跑了、周五当天还没跑≠休息=未知",
  );
  assert.equal(covered[6]!.key, null, "没有 spec 的长跑：关键课属性未知，不猜");
  const uncovered = publishedWeekFacts({ weekMonday, asOfDay: friday, doc: frozen, zones: null });
  assert.deepEqual(
    uncovered.slice(0, 5).map((day) => day.run),
    [null, null, null, null, null],
    "实绩没有覆盖：已过日期一律未知，不按休息算",
  );
  // 调整合并后的周文档：已过日期的旧安排是锁定的，照安排算，不被实绩改写
  const merged = {
    sessions: [...[0, 1, 2, 3, 4, 5].map((offset) => rest(addDays(weekMonday, offset))), run(addDays(weekMonday, 6))],
  } as unknown as WeeklyPlan;
  const locked = publishedWeekFacts({ weekMonday, asOfDay: friday, activities: [tuesdayRun], doc: merged, zones: null });
  assert.deepEqual(
    locked.map((day) => day.run),
    [false, false, false, false, false, false, true],
  );
});

test("模板兜底与首次生成同一份上下文：模型失败转模板后照样避开禁跑日、接上同一份边界", async () => {
  const availability = availabilityOf([1, 3, 5, 6]);
  const rest = (date: string): DayFact => ({ date, run: false, runMinutes: 0, loadPt: 0, key: false, quality: false });
  const boundary = Array.from({ length: 7 }, (_, offset) => rest(addDays(PLAN_START_MONDAY, offset - 7)));
  const input = generatorInput([normalRow(1)], { availability, boundary });
  const fallback = await generateWeekContent(
    input,
    {
      invoke: async () => {
        throw new Error("boom");
      },
    },
    { pmcSeed: PMC_SEED },
  );
  assert.equal(fallback.source, "fallback");
  assert.deepEqual(fallback.distribution[0]!.prefix, boundary, "模板路径带同一份相邻日历");
  assert.deepEqual({ acute: fallback.loadMeta.seed.acute, chronic: fallback.loadMeta.seed.chronic }, PMC_SEED);
  assert.ok(weekdaysOf(fallback.weeks[0]!.sessions).every((weekday) => availability.availableWeekdays!.includes(weekday)));
});

test("审计：日期分布项报最终日历的指标、写明原因与约束；无留痕=失败；留痕里的支配关系触发失败", async () => {
  const rows = [normalRow(1), normalRow(2)];
  const input = generatorInput(rows);
  const outcome = await generateWeekContent(input, modelOf(rows.map((row) => fourRunBag(row.week))), { pmcSeed: PMC_SEED });
  for (const week of [1, 2]) {
    const item = danielsAudit(outcome, input).find((candidate) => candidate.item === `W${week} 日期分布`);
    assert.equal(item?.verdict, "pass", item?.actual ?? "");
    assert.match(item?.actual ?? "", /选定 [^：]+：连跑 \d+ 天\/连休 \d+ 天\/三日峰 [\d.]+/);
    assert.match(item?.actual ?? "", /淘汰贪心解/);
  }
  assert.equal(
    danielsAudit(outcome, input).some((item) => item.item.includes("训练频率")),
    false,
    "旧的连休提示项已被分布项取代",
  );

  // 生产上每个常规周都经分布选择：没有留痕=选择没有发生，不放行
  const bare: ScheduledOutcome = { ...structuredClone(outcome), distribution: [] };
  const missing = danielsAudit(bare, input).find((item) => item.item === "W1 日期分布");
  assert.equal(missing?.verdict, "fail");
  assert.match(missing?.actual ?? "", /无分布留痕/);

  // 留痕自检：选定解被记为遭某个可行候选超过 → 失败并点名该候选
  const tampered = structuredClone(outcome);
  const audit = tampered.distribution[1]!;
  const chosen = audit.candidates[audit.chosen]!;
  const superseding = {
    label: "更优解",
    runDays: chosen.runDays,
    feasible: true,
    failures: [],
    metrics: { longestRun: { days: 0, from: null, to: null }, longestRest: { days: 0, from: null, to: null }, maxKey3DayLoad: 0, unrecoveredKeyDays: 0 },
    dominatedBy: null,
  };
  tampered.distribution[1] = {
    ...audit,
    candidates: [
      ...audit.candidates.map((candidate, index) => (index === audit.chosen ? { ...candidate, dominatedBy: audit.candidates.length } : candidate)),
      superseding,
    ],
  };
  const item = danielsAudit(tampered, input).find((candidate) => candidate.item === "W2 日期分布");
  assert.equal(item?.verdict, "fail");
  assert.match(item?.actual ?? "", /被候选 更优解/);
});
