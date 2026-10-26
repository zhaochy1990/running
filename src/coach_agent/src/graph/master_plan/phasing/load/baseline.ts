import { z } from "zod/v4";
import { isRunLikeActivity, normalizeSessionClass } from "../../../../data/activityClassification.js";
import type { PhasingActivityInput } from "../evidence.js";

/**
 * 常态基线 R0-R5（devops#793，daniels-l3-load.md §2.1）：从活动周序列推导
 * habitual_week_km——体量带下限与块位起点的共用锚。纯函数、无存储。
 *
 * R0 周序列连续补零（跳零周会令断练期均值虚高数倍）→ R1 无效周剔除 →
 * R2 中位取值 → R3 新鲜度衰减 → R4 场景门 → R5 硬安全门。
 * 分支语义经 21 用户两轮实测校准（spec §2.1），spike 参考实现同源。
 */

const r1 = (x: number) => Math.round(x * 10) / 10;

/** 断练周判定线（km）：低于该值的周不算「在跑」。 */
const GAP_WEEK_KM = 15;
/** R2 中位窗口（周）：12 → 不足 3 个有效周扩 16 → 24。 */
const MEDIAN_WINDOWS = [12, 16, 24] as const;
/** R0 回看窗口（周）：24 周 R2 窗口 + 4 周余量。 */
const SERIES_WEEKS_BACK = 28;
/** R3 新鲜度衰减：距最后 ≥15km 周超 4 周起 ×0.97/周，下限 ×0.65。 */
const STALE_GRACE_WEEKS = 4;
const STALE_DECAY = 0.97;
const STALE_FLOOR = 0.65;
/** R4 场景系数。 */
const DETRAIN_FACTOR = 0.4;
const POST_RACE_FACTOR = 0.8;
const STALE_FACTOR = 0.85;
/** 能力衰减触发：基线（中位）远高于近期均值=基线过期但仍在跑（R3 衰减与
 *  avg4≥15 在阈值上互斥——「基线过期」的真信号是中位 vs 近期的背离）。 */
const STALE_DIVERGENCE = 1.5;
/** R5：avg4≥15km 时起点 ≤1.3×avg4。 */
const SAFETY_CAP = 1.3;
/** R4 赛后窗口（天）。 */
const POST_RACE_DAYS = 21;
/** 起点下限（km）：再低也按 10 给（计划永远给，daniels.md §2.4）。 */
const START_FLOOR_KM = 10;

export interface SeriesWeek {
  /** 周一（YYYY-MM-DD，UTC+8 日界）。 */
  weekStart: string;
  km: number;
  race: boolean;
  /** 赛后 14 天内的周。 */
  postRace: boolean;
  /** 断练周（<15km）。 */
  gap: boolean;
  /** taper 特征周：量 < 前 3 周均值 70% 且后续 21 天内有比赛。 */
  taperLike: boolean;
}

export interface WeeklySeries {
  weeks: SeriesWeek[];
  races: Array<{ date: string; km: number }>;
  /** 序列基准日（R4 赛后窗口以它计距）。 */
  asOf: string;
}

/** 训练日归属用 UTC+8（与 evidence.ts 的 dayOf 同口径，中国跑者时区）。 */
const dayOf = (date: Date | string) => new Date(new Date(date).getTime() + 8 * 3600_000).toISOString().slice(0, 10);

const mondayOf = (day: string) => {
  const x = new Date(`${day}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
};

/**
 * R0 数据准备：28 周补零周序列 + 比赛清单（class race 且 ≥10km）。
 * 跑步行判定与 evidence 月度画像同口径（isRunLikeActivity，骑行不入画像）；
 * 只计 as_of 之前、≥0.5km 的活动；完成周=周一+7d ≤ as_of 由窗口保证
 * （末桶=as_of 周的前一个周一）。
 */
export function buildWeeklySeries(activities: PhasingActivityInput[], asOf: string): WeeklySeries {
  const byWeek = new Map<string, number>();
  const races: Array<{ date: string; km: number }> = [];
  for (const a of activities.filter(isRunLikeActivity)) {
    const km = (a.distanceM ?? 0) / 1000;
    if (km < 0.5) continue;
    const day = dayOf(a.date);
    if (day >= asOf) continue;
    const wk = mondayOf(day);
    byWeek.set(wk, (byWeek.get(wk) ?? 0) + km);
    if (normalizeSessionClass(a.strideSessionClass) === "race" && km >= 10) races.push({ date: day, km });
  }
  const start = new Date(`${mondayOf(asOf)}T00:00:00Z`);
  const weeks: SeriesWeek[] = [];
  for (let i = SERIES_WEEKS_BACK; i >= 1; i--) {
    const x = new Date(start);
    x.setUTCDate(x.getUTCDate() - i * 7);
    const key = x.toISOString().slice(0, 10);
    const km = byWeek.get(key) ?? 0;
    const weekEnd = new Date(x);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
    const race = races.some((r) => mondayOf(r.date) === key);
    const postRace = races.some((r) => {
      const d = (new Date(key).getTime() - new Date(mondayOf(r.date)).getTime()) / 86400000;
      return d > 0 && d <= 14;
    });
    const taperLike = (() => {
      if (km <= 0 || races.length === 0) return false;
      const prior = weeks.slice(-3).map((w) => w.km);
      if (prior.length === 0 || prior.every((v) => v === 0)) return false;
      const priorMean = prior.reduce((s, v) => s + v, 0) / prior.length;
      const raceAhead = races.some((r) => {
        const d = (new Date(r.date).getTime() - weekEnd.getTime()) / 86400000;
        return d > 0 && d <= 21;
      });
      return raceAhead && km < priorMean * 0.7;
    })();
    weeks.push({ weekStart: key, km, race, postRace, gap: km < GAP_WEEK_KM, taperLike });
  }
  return { weeks, races, asOf };
}

/**
 * 常态基线契约（evidence.habitual 的单一真源；evidence.ts 直接内嵌本 schema）。
 */
export const HabitualSchema = z.object({
  /** 常态周量（km，1 位小数）：R5 之后的最终起点。 */
  week_km: z.number().nonnegative(),
  /** R2 取值路径：median@12w/16w/24w → best2 → fallback_recent4。 */
  level: z.string().min(1),
  scenario: z.enum(["normal", "post_race", "detrain_return", "stale", "fallback_avg4"]),
  /** 近 4 个日历周均值（含补零；R4/R5 的判定输入）。 */
  avg4_km: z.number().nonnegative(),
  /** R3 衰减系数（1=新鲜）。 */
  decay_factor: z.number().min(0).max(1),
  /** 断练回归/零史场景下 ACWR 不适用（滚动均值被零周污染，显式标记给下游）。 */
  acwr_applicable: z.boolean(),
  /** 近 8 个日历周峰值（LR 曲线的「近期最长跑」代理）。 */
  pre_peak_km: z.number().nonnegative(),
});
export type HabitualBaseline = z.infer<typeof HabitualSchema>;
/** R4 场景标签（政策面观测字段）。 */
export type HabitualScenario = HabitualBaseline["scenario"];

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

/**
 * R0-R5 主入口：周序列 → 常态基线。R1 有效周=非比赛/非赛后 14 天/非断练/非
 * taper 特征；R2 日历窗口中位（12→16→24 各需 ≥3 有效周）→ 24 周内最优 2 周 →
 * 回退近 4 完成周均值；R3 过期衰减；R4 五档场景门（按序短路）；R5 硬安全门。
 */
export function habitualBaseline(series: WeeklySeries): HabitualBaseline {
  const weeks = series.weeks;
  const valid = weeks.filter((w) => !w.race && !w.postRace && !w.gap && !w.taperLike);
  const within = (win: number) => {
    const cutoff = weeks[weeks.length - win]?.weekStart ?? weeks[0]?.weekStart ?? "9999";
    return valid.filter((w) => w.weekStart >= cutoff);
  };

  // R2 取值
  let level = "fallback_recent4";
  let base: number | null = null;
  for (const win of MEDIAN_WINDOWS) {
    const recent = within(win).map((w) => w.km);
    if (recent.length >= 3) {
      base = median(recent);
      level = `median@${win}w`;
      break;
    }
  }
  if (base == null) {
    const best2 = within(24)
      .slice(-2)
      .map((w) => w.km);
    if (best2.length >= 2) {
      base = Math.max(...best2);
      level = "best2";
    }
  }

  const avg4 = weeks.slice(-4).reduce((s, w) => s + w.km, 0) / 4;
  if (base == null) base = avg4;

  // R3 新鲜度：距最后 ≥15km 周超 4 周起 ×0.97/周，下限 0.65
  const lastRealIdx = weeks.reduce((acc, w, i) => (w.km >= GAP_WEEK_KM ? i : acc), -1);
  const staleWeeks = lastRealIdx >= 0 ? weeks.length - 1 - lastRealIdx : weeks.length;
  const decay = staleWeeks > STALE_GRACE_WEEKS ? Math.max(STALE_FLOOR, STALE_DECAY ** (staleWeeks - STALE_GRACE_WEEKS)) : 1;
  base *= decay;

  // R4 场景门（按序短路）：断练回归 → 赛后 → 能力衰减 → 正常
  const tailGaps = (() => {
    let n = 0;
    for (let i = weeks.length - 1; i >= 0 && weeks[i]!.gap; i--) n++;
    return n;
  })();
  const daysSinceRace = series.races.length
    ? Math.round((new Date(series.asOf).getTime() - Math.max(...series.races.map((r) => new Date(r.date).getTime()))) / 86400000)
    : 999;
  let scenario: HabitualScenario = "normal";
  let start: number;
  if (valid.length === 0) {
    scenario = "fallback_avg4";
    start = avg4;
  } else if (avg4 < GAP_WEEK_KM || tailGaps >= 2) {
    scenario = "detrain_return";
    start = DETRAIN_FACTOR * base;
  } else if (daysSinceRace <= POST_RACE_DAYS) {
    scenario = "post_race";
    start = POST_RACE_FACTOR * base;
  } else if (base > STALE_DIVERGENCE * avg4) {
    // 能力衰减：基线过期但仍在跑（avg4≥15 已由断练分支保证不进来）
    scenario = "stale";
    start = STALE_FACTOR * base;
  } else {
    start = base;
  }

  // R5 硬安全门
  if (avg4 >= GAP_WEEK_KM) start = Math.min(start, SAFETY_CAP * avg4);

  return {
    week_km: r1(Math.max(START_FLOOR_KM, start)),
    level,
    scenario,
    avg4_km: r1(avg4),
    /** 两位小数：r1 会把 0.97 舍成 1.0、0.65 舍成 0.7（乘数不容失真）。 */
    decay_factor: Math.round(decay * 100) / 100,
    acwr_applicable: scenario !== "detrain_return" && scenario !== "fallback_avg4",
    pre_peak_km: r1(Math.max(0, ...weeks.slice(-8).map((w) => w.km))),
  };
}
