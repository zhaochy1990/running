import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays } from "@stride/contract";
import { danielsAudit } from "../danielsAudit.js";
import type { ContentWeekRow } from "../doctrine.js";
import { templateFallback } from "../fallback.js";
import { generateWeekContent } from "../generate.js";
import { type DayFact, distributionMetrics, dominates, enumeratePlacements, noWorseBatch, placementLabel, scheduleLabel } from "./distribution.js";
import { instantiateWeek, type PmcState, scheduleWeeks, type WeekBag, type WeekSchedule } from "./scheduler.js";
import {
  availabilityOf,
  cChecksOf,
  completeMetricsOf,
  eSlot,
  fourRunBag,
  generatorInput,
  greedyBatch,
  lrCourse,
  modelOf,
  normalRow,
  PLAN_START_MONDAY,
  PMC_SEED,
  placementOf,
  RACE,
  raceBag,
  raceRow,
  scheduleCtxOf,
  tCourse,
} from "./testSupport.js";

/**
 * 日期分布优化验收（devops#1043）：固定课包下淘汰能被「相同课程、合格负荷、
 * 更好日期分布」取代的扎堆安排。票面样例=三周四跑周，原排法
 * 「长轻松、阈值、休、休、休、短轻松、长跑」。
 */

const ROWS = [normalRow(1), normalRow(2), normalRow(3)];
const BAGS = ROWS.map((row) => fourRunBag(row.week));
const ORIGINAL = "E·T·休·休·休·E·LR";
const scheduleCtx = (overrides: Partial<Parameters<typeof scheduleCtxOf>[1]> = {}) => scheduleCtxOf(ROWS, overrides);
const mondayOf = (week: number): string => addDays(PLAN_START_MONDAY, (week - 1) * 7);
const checksOf = (week: WeekSchedule): string =>
  week.checks
    .filter((check) => !check.pass)
    .map((check) => `${check.id}: ${check.detail}`)
    .join(";");

const noWorseWithOneBetter = (a: ReturnType<typeof distributionMetrics>, b: ReturnType<typeof distributionMetrics>): boolean =>
  a.longestRun.days <= b.longestRun.days &&
  a.longestRest.days <= b.longestRest.days &&
  a.maxKey3DayLoad! <= b.maxKey3DayLoad! &&
  (a.longestRun.days < b.longestRun.days || a.longestRest.days < b.longestRest.days || a.maxKey3DayLoad! < b.maxKey3DayLoad!);

test("票面样例：贪心原排法=「长轻松、阈值、休、休、休、短轻松、长跑」，连跑三周", () => {
  assert.deepEqual(greedyBatch(BAGS, scheduleCtx()).map(scheduleLabel), [ORIGINAL, ORIGINAL, ORIGINAL]);
});

test("对照（长轻松挪周四）独立验证：过硬约束（P 门+C 门），三项均不差且至少一项更好；两个完整跨周窗口连跑 4→2、周内连休 3→1", () => {
  const original = greedyBatch(BAGS, scheduleCtx());
  // 对照：T 周二、长轻松 E 周四、短轻松 e 周六、LR 周日
  const contrast: WeekSchedule[] = [];
  let pmc: PmcState = PMC_SEED;
  for (const bag of BAGS) {
    const row = ROWS[bag.week - 1]!;
    const placement = placementOf({ 1: [tCourse(6)], 3: [eSlot("normal")], 5: [eSlot("interval")], 6: [bag.courses[0]!] });
    const result = instantiateWeek({
      dayCourses: placement,
      row,
      ctx: { weekMonday: mondayOf(bag.week), race: RACE, athlete: { weeklyRunDaysMax: 4 } },
      weekMonday: mondayOf(bag.week),
      raceWd: null,
      raceDate: null,
      pmc,
      repairs: [],
    });
    assert.ok("schedule" in result, `对照排位失败：${"failures" in result ? result.failures.join(";") : ""}`);
    if (!("schedule" in result)) return;
    assert.ok(
      result.schedule.checks.every((check) => check.pass),
      `对照须过全部 P 门：${checksOf(result.schedule)}`,
    );
    const cFailed = cChecksOf(row, result.schedule.sessions).filter((check) => !check.pass);
    assert.deepEqual(cFailed, [], "对照须过全部 C 门");
    assert.equal(scheduleLabel(result.schedule), "休·T·休·E·休·E·LR");
    pmc = result.pmc;
    contrast.push(result.schedule);
  }
  // W1→W2、W2→W3 两个完整跨周窗口
  for (const week of [1, 2]) {
    const before = completeMetricsOf(original, week);
    const after = completeMetricsOf(contrast, week);
    assert.ok(noWorseWithOneBetter(after, before), `W${week + 1} 对照须三项不差且至少一项更好：${JSON.stringify({ before, after })}`);
  }
  const before = completeMetricsOf(original, 2);
  const after = completeMetricsOf(contrast, 2);
  assert.equal(before.longestRun.days, 4, "原排法最长连跑：周六短轻松、周日长跑、周一长轻松、周二阈值");
  assert.equal(before.longestRun.from, addDays(mondayOf(2), 5));
  assert.equal(before.longestRest.days, 3);
  assert.equal(after.longestRun.days, 2);
  assert.equal(after.longestRest.days, 1);
});

test("实际排位入口：原解必须被淘汰——贪心候选被超过、选定分布改善、留痕自洽且描述最终日历", () => {
  const result = scheduleWeeks(BAGS, scheduleCtx());
  assert.ok(result.ok, result.failures.join(";"));
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.distribution.length, 3);
  for (const audit of result.distribution) {
    const greedy = audit.candidates[0]!;
    assert.equal(greedy.label, ORIGINAL, "candidates[0] 恒为贪心基准");
    assert.ok(greedy.feasible, "贪心解本身可行（被淘汰不是因为不可行）");
    assert.ok(greedy.dominatedBy != null, `W${audit.week} 贪心解须被某个同形态可行候选三项均不差且至少一项更好地超过`);
    const dominator = audit.candidates[greedy.dominatedBy]!;
    assert.ok(
      dominator.metrics != null && greedy.metrics != null && noWorseWithOneBetter(dominator.metrics, greedy.metrics),
      `W${audit.week} 留痕里的支配关系须成立：${greedy.label} ← ${dominator.label}`,
    );
    assert.notEqual(audit.chosen, 0, `W${audit.week} 不得再选原解`);
    assert.match(audit.reason, /淘汰贪心解/);
    assert.equal(audit.converged, true, "三周都走到不动点");
    // 审计数字描述最终日历：finalMetrics=选定候选在最终前后周下的指标
    assert.deepEqual(audit.finalMetrics, completeMetricsOf(result.weeks, audit.week - 1));
  }
  // 票面口径（完整跨周窗口）：原排法连跑 4 / 连休 3 → 选定 2 / 1
  const before = completeMetricsOf(greedyBatch(BAGS, scheduleCtx()), 2);
  const after = completeMetricsOf(result.weeks, 2);
  assert.equal(before.longestRun.days, 4);
  assert.equal(before.longestRest.days, 3);
  assert.equal(after.longestRun.days, 2);
  assert.equal(after.longestRest.days, 1);
  for (const week of result.weeks) assert.equal(checksOf(week), "", "最终日历 P 门全过");
});

test("正例·真实生成入口：固定课包 + 固定负荷种子 → 强制淘汰旧解且分布改善（无改善即失败）", async () => {
  const input = generatorInput(ROWS);
  const outcome = await generateWeekContent(input, modelOf(BAGS), { pmcSeed: PMC_SEED });
  assert.equal(outcome.source, "llm");
  for (const weekChecks of [...outcome.checks, ...outcome.scheduleChecks])
    for (const check of weekChecks) assert.equal(check.pass, true, `${check.id}: ${check.detail}`);
  assert.equal(outcome.distribution.length, 3);
  for (const audit of outcome.distribution) {
    const greedy = audit.candidates[0]!;
    assert.equal(greedy.label, ORIGINAL);
    assert.notEqual(audit.chosen, 0, `W${audit.week} 旧解未被淘汰`);
    assert.ok(audit.finalMetrics.longestRest.days < greedy.metrics!.longestRest.days, `W${audit.week} 分布未改善`);
  }
});

test("日期组合与课型位置均参与比较；同输入重现选择与理由", () => {
  const placements = enumeratePlacements(placementOf({ 0: [eSlot("normal")], 1: [tCourse(6)], 5: [eSlot("interval")], 6: [BAGS[0]!.courses[0]!] }), null);
  const labels = placements.map(placementLabel);
  // 日期组合：同样 4 个跑步日落在不同日期（基准 周一/周二/周六/周日 vs 周二/周四/周六/周日 vs 周二/周五/周六/周日）
  assert.ok(labels.includes("E·T·休·休·休·E·LR"), "基准落位在首位");
  assert.ok(labels.includes("休·T·休·E·休·E·LR"));
  assert.ok(labels.includes("休·T·休·休·E·E·LR"));
  // 同一日期组合（周二/周四/周六/周日）上的课型位置：阈值课与长轻松互换
  assert.ok(labels.includes("休·E·休·T·休·E·LR"));
  // 不删课不加课不双练：每个候选都是 4 课 4 个跑步日，长跑在周日
  for (const placement of placements) {
    assert.equal(placement.flat().length, 4);
    assert.equal(placement.filter((courses) => courses.length > 0).length, 4);
    assert.equal(placement[6]!.length, 1);
    assert.equal(placement[6]![0]!.kind, "course");
  }
  // 重现：同输入两次排位的留痕（选定、指标、原因）与日历逐字段相等
  const first = scheduleWeeks(BAGS, scheduleCtx());
  const second = scheduleWeeks(BAGS, scheduleCtx());
  assert.deepEqual(first.distribution, second.distribution);
  assert.deepEqual(
    first.weeks.map((week) => week.calendar.map((day) => day.sessions.map((session) => session.name))),
    second.weeks.map((week) => week.calendar.map((day) => day.sessions.map((session) => session.name))),
  );
});

test("三日负荷峰参与比较：连跑连休相同的两个候选，三日峰低者淘汰高者；三日峰不可评时只比连跑/连休", () => {
  const metrics = (load: number | null, run = 2, rest = 1): ReturnType<typeof distributionMetrics> => ({
    longestRun: { days: run, from: null, to: null },
    longestRest: { days: rest, from: null, to: null },
    maxKey3DayLoad: load,
    unrecoveredKeyDays: 0,
  });
  assert.equal(dominates(metrics(96), metrics(139)), true);
  assert.equal(dominates(metrics(139), metrics(96)), false);
  assert.equal(dominates(metrics(null), metrics(139)), false);
  assert.equal(dominates(metrics(null, 1), metrics(null, 2)), true);
});

test("分布指标：同日多课按日合计、未知日截断连续段、三日窗须含关键课且三日剂量全知", () => {
  const day = (date: string, run: boolean | null, loadPt: number | null, key: boolean | null): DayFact => ({
    date,
    run,
    runMinutes: run ? 60 : 0,
    loadPt,
    key,
    quality: key,
  });
  const metrics = distributionMetrics([
    day("2026-11-30", false, 0, false),
    day("2026-12-01", true, 70, true), // 双练日按日合计 40+30
    day("2026-12-02", true, 30, false),
    day("2026-12-03", null, null, null), // 未知日
    day("2026-12-04", true, 50, false),
    day("2026-12-05", false, 0, false),
    day("2026-12-06", true, 10, true),
    day("2026-12-07", false, 0, false),
  ]);
  // 连跑 2 被未知日截断；连休 1（12-05、12-07 各自被跑日隔开）
  assert.equal(metrics.longestRun.days, 2);
  assert.equal(metrics.longestRest.days, 1);
  // 含关键课的三日窗：[11-30,12-01,12-02]=100、[12-05,12-06,12-07]=10；12-03 未知使相邻窗不可评
  assert.equal(metrics.maxKey3DayLoad, 100);
  // 关键课次日（12-02）是恢复日（60min 短轻松）→ 不计
  assert.equal(metrics.unrecoveredKeyDays, 0);
  const heavy = distributionMetrics([day("2026-12-06", true, 10, true), { ...day("2026-12-07", true, 50, false), runMinutes: 75 }]);
  assert.equal(heavy.unrecoveredKeyDays, 1, "关键课次日 75min 普通轻松跑=没留恢复日");
});

test("指标只算受候选影响的日期：完全落在前后周边界里的连跑/连休/三日窗不计（票面「受候选影响的日期」）", () => {
  const day = (date: string, run: boolean, loadPt: number, key = false): DayFact => ({
    date,
    run,
    runMinutes: run ? 60 : 0,
    loadPt,
    key,
    quality: key,
  });
  // 上周：周一~周四连休 4 天、周五~周日连跑 3 天（周日长跑）；本周：周二阈值、周四轻松、周日长跑
  const prefix = [
    day("2026-11-23", false, 0),
    day("2026-11-24", false, 0),
    day("2026-11-25", false, 0),
    day("2026-11-26", false, 0),
    day("2026-11-27", true, 30),
    day("2026-11-28", true, 30),
    day("2026-11-29", true, 60, true),
  ];
  const week = [
    day("2026-11-30", false, 0),
    day("2026-12-01", true, 50, true),
    day("2026-12-02", false, 0),
    day("2026-12-03", true, 40),
    day("2026-12-04", false, 0),
    day("2026-12-05", false, 0),
    day("2026-12-06", true, 60, true),
  ];
  const focused = distributionMetrics([...prefix, ...week], [7, 13]);
  assert.equal(focused.longestRun.days, 1, "上周五~周日的连跑 3 不算本周的");
  assert.equal(focused.longestRest.days, 2, "上周一的连休 4 不算本周的（本周最长周五/周六 2 天）");
  assert.equal(focused.maxKey3DayLoad, 110, "上周五六日三日窗（120）与本周不相交、不计；本周最高=上周日长跑+周二阈值");
  // 对照：整段序列（批级指标）照常算出 3 / 4 / 120
  const whole = distributionMetrics([...prefix, ...week]);
  assert.deepEqual([whole.longestRun.days, whole.longestRest.days, whole.maxKey3DayLoad], [3, 4, 120]);
});

test("整批接受判据（交界复核）：四项均不变差才采纳（持平也算），任一项变差即拒绝", () => {
  const metrics = (run: number, rest: number, load: number | null, unrec: number): ReturnType<typeof distributionMetrics> => ({
    longestRun: { days: run, from: null, to: null },
    longestRest: { days: rest, from: null, to: null },
    maxKey3DayLoad: load,
    unrecoveredKeyDays: unrec,
  });
  assert.equal(noWorseBatch(metrics(2, 1, 90, 0), metrics(3, 1, 95, 1)), true, "全部更好");
  assert.equal(noWorseBatch(metrics(3, 1, 95, 1), metrics(3, 1, 95, 1)), true, "持平（换个同样好的排法也采纳——推向不动点）");
  assert.equal(noWorseBatch(metrics(2, 2, 95, 1), metrics(3, 1, 95, 1)), false, "连休变差");
  assert.equal(noWorseBatch(metrics(3, 1, 95, 2), metrics(3, 1, 95, 1)), false, "关键课次日未恢复变差");
});

test("交界复核：带上下一周重排会改变本周选择，整批指标不比原排法差，留痕与最终日历一致", () => {
  const rows = [normalRow(1, { totalKm: 58, longRunKm: 20, qualitySessions: 2 }), normalRow(2, { totalKm: 58, longRunKm: 22, qualitySessions: 0 })];
  const bags: WeekBag[] = [
    { week: 1, courses: [lrCourse(20), tCourse(5), tCourse(6), eSlot("normal"), eSlot("interval")] },
    { week: 2, courses: [lrCourse(22), eSlot("normal"), eSlot("interval")] },
  ];
  const ctx = scheduleCtxOf(rows, { athlete: { weeklyRunDaysMax: 6 }, pmcSeed: { acute: 21, chronic: 41 } });
  const result = scheduleWeeks(bags, ctx);
  assert.ok(result.ok, result.failures.join(";"));
  assert.deepEqual(result.weeks.map(scheduleLabel), ["T·休·T·休·E·休·LR", "休·E·休·E·休·休·LR"]);
  assert.ok(
    result.distribution.every((audit) => audit.converged),
    "两周都走到不动点",
  );
  // 对照：只看本周（不知道下一周）时第一周选的是 E·休·T·休·T·休·LR（两节质量课周二/周四
  // 背靠背周五长跑前日）——交界复核改选了两节质量课周一/周三、关键课次日全部留恢复日的排法
  const alone = scheduleWeeks([bags[0]!], { ...ctx, rows: [rows[0]!] });
  assert.equal(scheduleLabel(alone.weeks[0]!), "E·休·T·休·T·休·LR");
  assert.equal(result.distribution[0]!.finalMetrics.unrecoveredKeyDays, 0);
  // 「整批不变差才采纳」的判据本身见上一个用例；这里钉住的是复核确实改变了选择
});

test("两跑周：保留课数/跑步日/长跑/周量约束；三天连休由跑日数造成——留痕写明原因、不选更差的解", () => {
  const rows = [normalRow(1, { totalKm: 42, longRunKm: 22 })];
  const bag: WeekBag = { week: 1, courses: [lrCourse(22), eSlot("normal")] };
  const result = scheduleWeeks([bag], scheduleCtxOf(rows, { athlete: { weeklyRunDaysMax: 2 } }));
  assert.ok(result.ok, result.failures.join(";"));
  const week = result.weeks[0]!;
  assert.equal(week.sessions.length, 2, "课数不变");
  assert.equal(new Set(week.sessions.map((session) => session.date)).size, 2, "跑步日数不变");
  assert.ok(week.sessions.some((session) => session.type === "LR"));
  assert.equal(checksOf(week), "");
  const audit = result.distribution[0]!;
  assert.ok(audit.constraints.includes("已达每周跑步日上限 2"));
  // 两跑/周必有一段 ≥3 天连休（5 个休日被长跑日劈成两段）；在所有可行候选里取最短的
  const restDays = audit.candidates.flatMap((candidate) => (candidate.metrics == null ? [] : [candidate.metrics.longestRest.days]));
  assert.equal(Math.min(...restDays), 3);
  assert.equal(audit.finalMetrics.longestRest.days, 3);
});

test("六跑周：保留课数与跑步日数，全部过门；选定候选不被任何可行候选超过", () => {
  const rows = [normalRow(1, { totalKm: 80, longRunKm: 26, qualitySessions: 2 })];
  const bag: WeekBag = { week: 1, courses: [lrCourse(26), tCourse(6), tCourse(5), eSlot("normal"), eSlot("normal"), eSlot("interval")] };
  const result = scheduleWeeks([bag], scheduleCtxOf(rows, { athlete: { weeklyRunDaysMax: 6 } }));
  assert.ok(result.ok, result.failures.join(";"));
  const week = result.weeks[0]!;
  assert.equal(week.sessions.length, 6, "课数不变");
  assert.equal(new Set(week.sessions.map((session) => session.date)).size, 6, "跑步日数不变");
  assert.equal(checksOf(week), "");
  const audit = result.distribution[0]!;
  const chosen = audit.candidates[audit.chosen]!;
  assert.equal(chosen.dominatedBy, null);
  for (const candidate of audit.candidates) {
    assert.ok(candidate.metrics == null || !noWorseWithOneBetter(candidate.metrics, chosen.metrics!), "选定候选不得被可行候选三项均不差且至少一项更好地超过");
  }
});

test("只能在相邻日训练的人：日期组合被可跑日锁死，集中由约束造成——报告具体日期与原因", () => {
  const rows = [normalRow(1, { totalKm: 38 })];
  const bag: WeekBag = { week: 1, courses: [lrCourse(20), tCourse(6), eSlot("interval")] };
  const result = scheduleWeeks([bag], scheduleCtxOf(rows, { availability: availabilityOf([4, 5, 6]) })); // 周五/周六/周日
  assert.ok(result.ok, result.failures.join(";"));
  const week = result.weeks[0]!;
  // 周六只能是轻量 E、周日是长跑 → 阈值课只能周五：三天连跑不可避免
  assert.equal(scheduleLabel(week), "休·休·休·休·T·E·LR");
  assert.ok(week.checks.find((check) => check.id === "P8 可跑日")?.pass);
  const audit = result.distribution[0]!;
  assert.equal(audit.candidates.length, 1, "可跑日=三个相邻日时没有其它同形态落位");
  assert.equal(audit.chosen, 0);
  assert.match(audit.reason, /未被超过/);
  assert.ok(audit.constraints.includes("可跑日=周五/六/日"));
  assert.ok(audit.constraints.includes("已达每周跑步日上限 3"));
  const metrics = audit.finalMetrics;
  assert.equal(metrics.longestRun.days, 3);
  assert.equal(metrics.longestRun.from, addDays(PLAN_START_MONDAY, 4));
  assert.equal(metrics.longestRest.days, 4);
});

test("分布优化让赛周无解而贪心日历可行：回退贪心日历并在留痕里说明，不把原本可行的批变无解", () => {
  // 周三比赛：优化后的第一周抬高了进入赛周的 ATL，赛周次日比值 1.32 超 cap；贪心链下恰好过
  const rows = [normalRow(1), raceRow(2)];
  const bags = [fourRunBag(1), raceBag(2)];
  const race = { ...RACE, date: addDays(mondayOf(2), 3) };
  const ctx = scheduleCtxOf(rows, { race, pmcSeed: { acute: 6, chronic: 27 } });
  const result = scheduleWeeks(bags, ctx);
  assert.ok(result.ok, result.failures.join(";"));
  assert.deepEqual(result.weeks.map(scheduleLabel), greedyBatch(bags, ctx).map(scheduleLabel), "回退到贪心日历");
  assert.equal(scheduleLabel(result.weeks[0]!), ORIGINAL);
  const audit = result.distribution[0]!;
  assert.match(audit.reason, /分布优化后的日历排位无解（W2 排位无解：P6 日负荷比 1\.32 超 cap 1\.3/);
  assert.match(audit.reason, /回退到贪心日历/);
  assert.equal(audit.candidates.length, 1);
  // 同一个第一周单独排（没有赛周）时优化照常生效——无解是跨周负荷轨迹造成的，不是这一周排不出
  const alone = scheduleWeeks([bags[0]!], { ...ctx, rows: [rows[0]!] });
  assert.ok(alone.ok && alone.distribution[0]!.chosen !== 0);
});

/** 赛周夹具：模板课包（构造保证合法），第一周长跑按需带 M 配速尾段（质量课）。 */
function raceInputOf(raceWd: number, qualityTailKm: number) {
  const raceDate = addDays(mondayOf(2), raceWd);
  const rows: ContentWeekRow[] = [normalRow(1), normalRow(2, { role: "race", totalKm: 52.2, longRunKm: null, qualitySessions: 2 })];
  const input = generatorInput(rows, { race: { ...RACE, date: raceDate } });
  const bags = templateFallback(input).map((bag) => ({
    ...bag,
    courses: bag.courses.map((course) => (course.kind === "course" && course.type === "LR" ? lrCourse(20, qualityTailKm) : course)),
  }));
  return { input, bags };
}

test("周五/周六比赛：周一激活课紧接上周日带质量尾段的长跑是既有赛周例外——LLM 课包照常通过、审计提示", async () => {
  for (const raceWd of [4, 5]) {
    const { input, bags } = raceInputOf(raceWd, 4);
    const outcome = await generateWeekContent(input, modelOf(bags), { pmcSeed: PMC_SEED });
    assert.equal(outcome.source, "llm", `比赛日周内位 ${raceWd}：${outcome.attemptsDetail.map((detail) => detail.violations.join(";")).join(" | ")}`);
    assert.equal(outcome.attempts, 1, "首次就过，不被迫退模板");
    const activation = outcome.weeks[1]!.sessions.find((session) => session.name.includes("激活"))!;
    assert.equal(activation.date, mondayOf(2), "激活课落周一（赛前 5 天位——原书周二位的周五/周六比赛形态）");
    assert.ok(
      outcome.scheduleChecks[1]!.every((check) => check.pass),
      "跨周背靠背未按 P2 判",
    );
    const items = danielsAudit(outcome, input);
    const noted = items.find((item) => item.item === "赛周激活课接长跑");
    assert.equal(noted?.verdict, "warn");
    assert.match(noted?.actual ?? "", /周一激活课紧接上周日长跑/);
    assert.equal(
      items.some((item) => item.verdict === "fail"),
      false,
      "审计无硬失败",
    );
  }
});

test("上周日长跑是纯有氧（不含质量尾段）时，周一激活课不触发提示", async () => {
  for (const raceWd of [4, 5]) {
    const { input, bags } = raceInputOf(raceWd, 0);
    const outcome = await generateWeekContent(input, modelOf(bags), { pmcSeed: PMC_SEED });
    assert.equal(outcome.source, "llm");
    assert.equal(
      danielsAudit(outcome, input).some((item) => item.item === "赛周激活课接长跑"),
      false,
    );
  }
});
