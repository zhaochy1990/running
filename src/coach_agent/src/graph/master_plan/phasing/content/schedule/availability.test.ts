import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, shanghaiDay, type WeeklyPlan } from "@stride/contract";
import { danielsAudit } from "../danielsAudit.js";
import { templateFallback } from "../fallback.js";
import { generateWeekContent, type ScheduledOutcome } from "../generate.js";
import { schedulingAvailabilityOf } from "./availability.js";
import { boundaryBefore } from "./boundary.js";
import { type DayFact, factsOfDays } from "./distribution.js";
import { scheduleWeeks, type WeekBag } from "./scheduler.js";
import {
  availabilityOf,
  draftOf,
  eSlot,
  fourRunBag,
  generatorInput,
  lrCourse,
  modelOf,
  normalRow,
  PLAN_START_MONDAY,
  PMC_SEED,
  RACE,
  raceBag,
  raceRow,
  runMinutesOf,
  scheduleCtxOf,
  tCourse,
} from "./testSupport.js";

/**
 * 排课可用度与跨周边界验收（devops#1043）：禁跑日/日内窗口/单课时长上限/双练
 * 许可进入排位；首次生成、滚动续排、模板兜底带同一份已知相邻日历与负荷种子；
 * 跨周/跨批次/未知边界/已锁定日期/赛周；硬约束无解返回具体冲突。
 */

const weekdayOf = (date: string): number => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
const weekdaysOf = (sessions: Array<{ date: string }>): number[] => [...new Set(sessions.map((session) => weekdayOf(session.date)))].sort((a, b) => a - b);
const allSeven = availabilityOf([0, 1, 2, 3, 4, 5, 6]);

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

test("单课时长上限：E 课实例化钳到许可值；长跑/质量课时长由课包决定、不裁剪——审计告警而不让生成失败", async () => {
  const rows = [normalRow(1), normalRow(2)];
  const availability = availabilityOf([1, 2, 3, 4, 5, 6], { maxSessionDurationMin: 70 });
  const input = generatorInput(rows, { availability });
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
  for (const workout of outcome.weeks.flatMap((week) => week.sessions)) {
    if (workout.type === "E") assert.ok(runMinutesOf(workout) <= 70, `${workout.name} 超单课上限`);
  }
  assert.ok(
    outcome.weeks.every((week) => week.sessions.some((workout) => workout.type === "LR")),
    "长跑不因超限被裁掉",
  );
  const cap = danielsAudit(outcome, input).find((item) => item.item === "W1 单课时长上限");
  assert.equal(cap?.verdict, "warn");
  assert.match(cap?.actual ?? "", /长跑 [\d.]+km≈\d+min 超限/);
});

test("单课时长上限低于普通轻松课下限（60min）：无解原因落在上限上", () => {
  const availability = availabilityOf([1, 2, 3, 4, 5, 6], { maxSessionDurationMin: 45 });
  const result = scheduleWeeks([fourRunBag(1)], scheduleCtxOf([normalRow(1)], { availability }));
  assert.equal(result.ok, false);
  assert.match(result.failures[0]!, /^W1 单课时长上限 45min 低于普通轻松课下限 60min——普通 E 日无法在许可时长内排课/);
  assert.deepEqual(result.conflicts, [result.failures[0]]);
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

test("单课时长上限审计不计比赛课（目标事件不是训练课）", async () => {
  const raceDate = addDays(addDays(PLAN_START_MONDAY, 7), 6);
  const rows = [normalRow(1), raceRow(2)];
  const input = generatorInput(rows, { race: { ...RACE, date: raceDate }, availability: { ...allSeven, maxSessionDurationMin: 70 } });
  const outcome = await generateWeekContent(input, modelOf([fourRunBag(1), raceBag(2)]), { pmcSeed: PMC_SEED });
  const items = danielsAudit(outcome, input);
  assert.equal(items.find((candidate) => candidate.item === "W1 单课时长上限")?.verdict, "warn");
  assert.equal(
    items.some((candidate) => candidate.item === "W2 单课时长上限"),
    false,
    "42.2km 比赛课本身不计",
  );
});
