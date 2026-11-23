import { addDays } from "@stride/contract";
import { hasQualitySegment, type PaceZones } from "../derive.js";
import { E_DURATION_INTERVAL_BAND } from "../validators.js";
import { courseMinutes } from "./dose.js";
import type { CalendarDay, LoadSeriesPoint, PlannedCourse, WeekSchedule } from "./scheduler.js";

/**
 * 日期分布比较（devops#1043）：固定课包下比较可执行日历，淘汰能被「相同课程、
 * 合格负荷、更好日期分布」取代的扎堆安排。本文件只做与排位无关的纯计算——
 * 日历事实（DayFact）→ 分布指标、同课数同跑步日数的替代落位枚举、候选
 * 排序；每个候选的实例化与 P/C 门禁仍走 scheduler 同一条路径，只有过门的
 * 候选进入比较。
 */

/** 一个日期上已知的跑步状态（实绩 / 生效安排 / 候选落位通用）。 */
export interface DayFact {
  date: string;
  /** 当天是否跑步；null=未知。 */
  run: boolean | null;
  /** 当日跑步时长（分钟，同日多课合计）；不跑=0，未知=null。 */
  runMinutes: number | null;
  /** 当日剂量（loadPt 口径，同日多课按日合计）；null=未知。 */
  loadPt: number | null;
  /** 当天含长跑或质量课（关键课）；null=未知。 */
  key: boolean | null;
  /** 当天含质量课（P2 判定口径，含比赛课；不含纯有氧长跑）；null=未知。 */
  quality: boolean | null;
}

/** 未知日：日期已知、状态未知——连续段只报告可观测部分。 */
export const unknownDay = (date: string): DayFact => ({ date, run: null, runMinutes: null, loadPt: null, key: null, quality: null });

/** 恢复日=休或仅短轻松跑（≤ 短带上限 60min，与 E 分层短带同源）。 */
const LIGHT_RUN_MIN = E_DURATION_INTERVAL_BAND[1];
const isRecoveryDay = (day: DayFact): boolean => day.run === false || (day.run === true && day.runMinutes != null && day.runMinutes <= LIGHT_RUN_MIN);

/** 连续段（天数 + 可观测部分的起止日期）。 */
export interface Streak {
  days: number;
  from: string | null;
  to: string | null;
}

export interface DistributionMetrics {
  /** 最长连续跑步天数。 */
  longestRun: Streak;
  /** 最长连续无跑步天数。 */
  longestRest: Streak;
  /** 包含关键课的连续三日窗口的最大负荷和；没有可评窗口（含未知日）=null。 */
  maxKey3DayLoad: number | null;
  /** 关键课次日不是恢复日的个数（保护关键课附近的恢复；次日未知不计）。 */
  unrecoveredKeyDays: number;
}

/**
 * 分布指标。入参须是日期连续的日事实序列；未知日既不算跑也不算休，并截断
 * 两侧连续段（只报告可观测部分）。只统计触及 focus（候选所在日期范围，缺省
 * 全序列）的段——完全落在前后周边界里的连跑/连休不随候选变化，不进入比较
 * （票面「受候选影响的日期」）。三日窗口须与 focus 相交、含至少一个关键课日
 * 且三日剂量全已知才参与；关键课恢复只看次日在 focus 内的。
 */
export function distributionMetrics(days: readonly DayFact[], focus: readonly [number, number] = [0, days.length - 1]): DistributionMetrics {
  const [from, to] = focus;
  const touches = (start: number, end: number): boolean => start <= to && end >= from;
  const longestRun: Streak = { days: 0, from: null, to: null };
  const longestRest: Streak = { days: 0, from: null, to: null };
  let runStart = -1;
  let restStart = -1;
  const closeRun = (end: number) => {
    if (runStart >= 0 && touches(runStart, end) && end - runStart + 1 > longestRun.days)
      Object.assign(longestRun, { days: end - runStart + 1, from: days[runStart]!.date, to: days[end]!.date });
    runStart = -1;
  };
  const closeRest = (end: number) => {
    if (restStart >= 0 && touches(restStart, end) && end - restStart + 1 > longestRest.days)
      Object.assign(longestRest, { days: end - restStart + 1, from: days[restStart]!.date, to: days[end]!.date });
    restStart = -1;
  };
  days.forEach((day, index) => {
    if (day.run === true) {
      closeRest(index - 1);
      if (runStart < 0) runStart = index;
    } else if (day.run === false) {
      closeRun(index - 1);
      if (restStart < 0) restStart = index;
    } else {
      closeRun(index - 1);
      closeRest(index - 1);
    }
  });
  closeRun(days.length - 1);
  closeRest(days.length - 1);
  let maxKey3DayLoad: number | null = null;
  for (let i = 0; i + 2 < days.length; i++) {
    if (!touches(i, i + 2)) continue;
    const window = [days[i]!, days[i + 1]!, days[i + 2]!];
    if (!window.some((day) => day.key === true) || window.some((day) => day.loadPt == null)) continue;
    const sum = window.reduce((total, day) => total + (day.loadPt ?? 0), 0);
    if (maxKey3DayLoad == null || sum > maxKey3DayLoad) maxKey3DayLoad = Math.round(sum * 10) / 10;
  }
  const unrecoveredKeyDays = days.filter((day, index) => {
    const next = days[index + 1];
    return index + 1 >= from && index + 1 <= to && day.key === true && next?.run === true && !isRecoveryDay(next);
  }).length;
  return { longestRun, longestRest, maxKey3DayLoad, unrecoveredKeyDays };
}

/** 一周候选在已知前后周下的指标：prefix（前 7 天）+ 本周 + suffix（下一周；未知=null），focus=本周。 */
export function contextMetrics(prefix: readonly DayFact[], week: readonly DayFact[], suffix: readonly DayFact[] | null): DistributionMetrics {
  return distributionMetrics([...prefix, ...week, ...(suffix ?? [])], [prefix.length, prefix.length + week.length - 1]);
}

export const formatDistributionMetrics = (metrics: DistributionMetrics): string =>
  `连跑 ${metrics.longestRun.days} 天/连休 ${metrics.longestRest.days} 天/三日峰 ${metrics.maxKey3DayLoad ?? "不可评"}`;

/** 两段日事实是否逐日相同（交界复核的不动点/收敛判定）。 */
export const sameFacts = (a: readonly DayFact[] | null, b: readonly DayFact[] | null): boolean =>
  a === b ||
  (a != null &&
    b != null &&
    a.length === b.length &&
    a.every((day, index) => {
      const other = b[index]!;
      return day.date === other.date && day.run === other.run && day.loadPt === other.loadPt && day.key === other.key && day.quality === other.quality;
    }));

const LOAD_EPS = 1e-6;
const keyLoadNoWorse = (a: DistributionMetrics, b: DistributionMetrics): boolean =>
  a.maxKey3DayLoad == null || b.maxKey3DayLoad == null || a.maxKey3DayLoad <= b.maxKey3DayLoad + LOAD_EPS;
const keyLoadBetter = (a: DistributionMetrics, b: DistributionMetrics): boolean =>
  a.maxKey3DayLoad != null && b.maxKey3DayLoad != null && a.maxKey3DayLoad < b.maxKey3DayLoad - LOAD_EPS;

/** a 三项均不差且至少一项更好 = 淘汰 b（三日负荷不可评的那一对只比连跑/连休）。 */
export function dominates(a: DistributionMetrics, b: DistributionMetrics): boolean {
  const runNoWorse = a.longestRun.days <= b.longestRun.days;
  const restNoWorse = a.longestRest.days <= b.longestRest.days;
  if (!(runNoWorse && restNoWorse && keyLoadNoWorse(a, b))) return false;
  return a.longestRun.days < b.longestRun.days || a.longestRest.days < b.longestRest.days || keyLoadBetter(a, b);
}

/**
 * 整批接受判据（交界复核）：a 的四项（连跑/连休/三日峰/关键课次日未恢复）均
 * 不比 b 差——单看一周的改排可能让相邻周变差，按整批判才单调。指标持平的
 * 改排也采纳：它不变差，而且是把选择推向不动点（留痕与最终日历一致）的那一步。
 */
export function noWorseBatch(a: DistributionMetrics, b: DistributionMetrics): boolean {
  return (
    a.longestRun.days <= b.longestRun.days && a.longestRest.days <= b.longestRest.days && keyLoadNoWorse(a, b) && a.unrecoveredKeyDays <= b.unrecoveredKeyDays
  );
}

/**
 * 非被超过候选之间的取舍序：先保护关键课附近的恢复（关键课次日是恢复日），
 * 再比较日期分布（连休、连跑）；全等时保持传入顺序（调用方的稳定序）。三日峰
 * 不进取舍序：前沿上连跑、连休都相同的两个候选，三日峰低的必然支配高的，
 * 不会同时留在前沿。
 */
export function compareCandidates(a: DistributionMetrics, b: DistributionMetrics): number {
  return a.unrecoveredKeyDays - b.unrecoveredKeyDays || a.longestRest.days - b.longestRest.days || a.longestRun.days - b.longestRun.days;
}

/** 排位产物日历 → 日事实（跨周边界与审计共用；calendar 与 loadSeries 按日期对齐）。 */
export function factsOfDays(calendar: readonly CalendarDay[], loadSeries: readonly LoadSeriesPoint[], zones: PaceZones, raceDate: string | null): DayFact[] {
  const loadByDate = new Map(loadSeries.map((point) => [point.date, point.loadPt]));
  return calendar.map((day) => {
    const quality = day.sessions.some((workout) => hasQualitySegment(workout, zones)) || day.date === raceDate;
    const minutes = day.sessions.map(courseMinutes);
    return {
      date: day.date,
      run: day.sessions.length > 0,
      runMinutes: minutes.length === 0 ? 0 : minutes.some((value) => value == null) ? null : (minutes as number[]).reduce((total, value) => total + value, 0),
      loadPt: loadByDate.get(day.date) ?? null,
      key: quality || day.sessions.some((workout) => workout.type === "LR"),
      quality,
    };
  });
}

export const factsOfWeek = (schedule: WeekSchedule, zones: PaceZones, raceDate: string | null): DayFact[] =>
  factsOfDays(schedule.calendar, schedule.loadSeries, zones, raceDate);

/** 批次首周之前 7 天的前缀事实：边界里有的取边界，没有的=未知日。 */
export function boundaryPrefix(boundary: readonly DayFact[] | undefined, weekMonday: string): DayFact[] {
  const byDate = new Map((boundary ?? []).map((day) => [day.date, day]));
  return Array.from({ length: 7 }, (_, offset) => {
    const date = addDays(weekMonday, offset - 7);
    return byDate.get(date) ?? unknownDay(date);
  });
}

// ── 替代落位枚举 ─────────────────────────────────────────────────────────────

const isLr = (course: PlannedCourse): boolean => course.kind === "course" && course.type === "LR";
const isStructured = (course: PlannedCourse): boolean => course.kind === "course";
const shortTag = (course: PlannedCourse): string => (course.kind === "e-slot" ? "E" : course.type);
/** 同类课互换不改变日历（非 strides 的 E 槽位等价）：按内容签名去重。 */
const identityTag = (course: PlannedCourse): string =>
  course.kind === "e-slot" ? (course.strides ? "E+strides" : "E") : `${course.type}:${course.name}:${JSON.stringify(course.blocks)}`;

/** 周一→周日的落位标签，如「休·T·休·E·休·E·LR」。 */
export const placementLabel = (dayCourses: PlannedCourse[][]): string =>
  dayCourses.map((courses) => (courses.length === 0 ? "休" : courses.map(shortTag).join("+"))).join("·");

export const runDaysOf = (dayCourses: PlannedCourse[][]): number[] => dayCourses.flatMap((courses, weekday) => (courses.length > 0 ? [weekday] : []));

/** 排位产物日历的周一→周日标签（E 课记 E、结构课记类型），如「休·T·休·E·休·E·LR」。 */
export const scheduleLabel = (schedule: WeekSchedule): string =>
  schedule.calendar.map((day) => (day.sessions.length === 0 ? "休" : day.sessions.map((workout) => workout.type ?? "?").join("+"))).join("·");

/** 组能否落在某日（与贪心同口径的结构先验）：LR→周日；结构课→周一至周五；周日只属于 LR。 */
function groupFitsDay(courses: PlannedCourse[], weekday: number): boolean {
  if (courses.some(isLr)) return weekday === 6;
  if (courses.some(isStructured)) return weekday <= 4;
  return weekday !== 6;
}

function* combinations<T>(items: readonly T[], size: number): Generator<T[]> {
  if (size === 0) {
    yield [];
    return;
  }
  for (let i = 0; i <= items.length - size; i++) for (const rest of combinations(items.slice(i + 1), size - 1)) yield [items[i]!, ...rest];
}

const signatureOf = (dayCourses: PlannedCourse[][]): string => dayCourses.map((courses) => courses.map(identityTag).sort().join("+")).join("|");

/**
 * 基准落位的替代方案：同一批课、同样多的跑步日，落在可跑日的其它日期/课型
 * 位置上。保持跑课数、跑步日数、长跑与质量课配额（不删课、不加课、不双练）；
 * 质量课两两间隔 ≥2 天（与贪心 spacingOk 同口径）。基准本身排首位（稳定序：
 * 完全等价时选它），内容等价的落位去重。
 */
export function enumeratePlacements(base: PlannedCourse[][], allowedWeekdays: readonly number[] | null): PlannedCourse[][][] {
  const groups = base.filter((courses) => courses.length > 0);
  const weekdays = allowedWeekdays ?? [0, 1, 2, 3, 4, 5, 6];
  const placements: PlannedCourse[][][] = [base.map((courses) => [...courses])];
  const seen = new Set([signatureOf(base)]);
  const emit = (assignment: number[]) => {
    const dayCourses: PlannedCourse[][] = Array.from({ length: 7 }, (): PlannedCourse[] => []);
    assignment.forEach((weekday, index) => {
      dayCourses[weekday]!.push(...groups[index]!);
    });
    const structuredDays = assignment.filter((_, index) => groups[index]!.some((course) => isStructured(course) && !isLr(course)));
    if (structuredDays.some((a, i, all) => all.some((b, j) => i < j && Math.abs(a - b) < 2))) return;
    const signature = signatureOf(dayCourses);
    if (!seen.has(signature)) {
      seen.add(signature);
      placements.push(dayCourses);
    }
  };
  const assign = (days: number[], index: number, used: boolean[], current: number[]) => {
    if (index === groups.length) {
      emit(current);
      return;
    }
    for (let j = 0; j < days.length; j++) {
      if (used[j] || !groupFitsDay(groups[index]!, days[j]!)) continue;
      used[j] = true;
      current.push(days[j]!);
      assign(days, index + 1, used, current);
      current.splice(index, 1);
      used[j] = false;
    }
  };
  for (const days of combinations(weekdays, groups.length))
    assign(
      days,
      0,
      days.map(() => false),
      [],
    );
  return placements;
}
