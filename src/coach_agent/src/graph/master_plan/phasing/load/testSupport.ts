import type { SeriesWeek, WeeklySeries } from "./baseline.js";

/**
 * L3 回放测试支撑（devops#793 G 节）：伤退场景的序列级变换——与 L2 回放的
 * applyInjuryScenario（evidence 级）同构：近 6 周量砍半（只改 km 不改周标记，
 * 与 spike 参考实现口径一致）。
 */

export function injurySeries(series: WeeklySeries): WeeklySeries {
  const n = series.weeks.length;
  return { ...series, weeks: series.weeks.map((w, i) => (i >= n - 6 ? { ...w, km: w.km * 0.45 } : w)) };
}

/** 合成周序列（R0-R5 分支单测用）：按周一序列直接构造（as_of 固定 2026-10-26）。 */
export function makeSeries(kms: number[], races: Array<{ date: string; km: number }> = []): WeeklySeries {
  const base = new Date("2026-10-26T00:00:00Z");
  const weeks: SeriesWeek[] = kms.map((km, i) => {
    const x = new Date(base);
    x.setUTCDate(x.getUTCDate() - (kms.length - i) * 7);
    return { weekStart: x.toISOString().slice(0, 10), km, race: false, postRace: false, gap: km < 15, taperLike: false };
  });
  return { weeks, races, asOf: "2026-10-26" };
}
