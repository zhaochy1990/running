/**
 * Daniels VDOT 双向换算（devops#789，daniels-l1-evidence.md §4.6）。
 *
 * 采用公开 Daniels–Gilbert 方程（与官方 V.O2 计算器同式，vdoto2.com global.js
 * Formula.getVDOT 实测比对一致）：
 *   VO2(v)   = 0.182258·v + 0.000104·v² − 4.6        （v = m/min）
 *   %max(t)  = 0.8 + 0.298956·e^(−0.193261·t) + 0.189439·e^(−0.012778·t)（t = min）
 *   VDOT     = VO2(距离/时间) / %max(时间)
 * 等效时间按同方程反解（VO2(d/t)/%max(t) 随 t 单调递减，二分可解）。
 *
 * 锚点对照原书表（vdot.test.ts）：5K/10K/HM 列公开方程误差 ≤±1%（2nd 版书与
 * 公开方程一致）；FM 列 2nd 版为人工保守修订（@VDOT50 原书 3:19:03 vs 公开
 * 方程 3:10:4x，约 +4.5%），公开方程与官方计算器均不复现该列——本模块按公开
 * 方程实现，短距离→长距离的高估由调用方的 ×1.03 保守折扣机制吸收。
 */

export const RACE_DISTANCES_M = { "5K": 5000, "10K": 10000, HM: 21097.5, FM: 42195 } as const;
export type RaceDistanceKey = keyof typeof RACE_DISTANCES_M;
/** 由短到长；「比源距离更长」的折扣判定用。 */
const RACE_DISTANCE_ORDER: readonly RaceDistanceKey[] = ["5K", "10K", "HM", "FM"];

const vo2 = (vMetersPerMin: number) => 0.182258 * vMetersPerMin + 0.000104 * vMetersPerMin ** 2 - 4.6;
const fracMax = (tMin: number) => 0.8 + 0.298956 * Math.exp(-0.193261 * tMin) + 0.189439 * Math.exp(-0.012778 * tMin);

/**
 * 比赛成绩 → VDOT（距离≥1200m 的任意路跑距离；官方计算器对 <1200m 另有
 * 插值修正，本体系锚点最短 5K，不实现）。无效入参返回 NaN。
 */
export function vdotFromRace(distanceM: number, timeSec: number): number {
  if (!Number.isFinite(distanceM) || !Number.isFinite(timeSec) || distanceM < 1200 || timeSec <= 0) return Number.NaN;
  const tMin = timeSec / 60;
  return vo2(distanceM / tMin) / fracMax(tMin);
}

/** VDOT → 等效完赛时间（秒），对 5K-FM 全程单调可逆，二分 60 轮收敛到 <0.1s。 */
export function raceTimeSecFromVdot(distanceM: number, vdot: number): number {
  if (!Number.isFinite(distanceM) || !Number.isFinite(vdot) || distanceM <= 0 || vdot <= 0) return Number.NaN;
  const f = (tSec: number) => vdotFromRace(distanceM, tSec) - vdot;
  let lo = 60; // 1 分钟起（任何人类路跑距离都快于 1min）
  let hi = 86400; // 24 小时封顶（远超全马关门时间）
  if (f(lo) < 0 || f(hi) > 0) return Number.NaN;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  return Math.round((lo + hi) / 2);
}

/**
 * 校准阈值配速 → VDOT：阈值配速即速度-时长模型的 60 分钟可持续速度
 * （%max(60)≈0.888），按「60 分钟比赛表现」代入同方程。
 */
export function vdotFromThresholdPace(paceSecPerKm: number): number {
  if (!Number.isFinite(paceSecPerKm) || paceSecPerKm <= 0) return Number.NaN;
  return vo2(60000 / paceSecPerKm) / fracMax(60);
}

/**
 * VDOT → 校准阈值配速（s/km）：vdotFromThresholdPace 的闭式逆。解
 * vo2(v) = VDOT·%max(60)（0.000104·v² + 0.182258·v − 4.6 − VDOT·%max(60) = 0
 * 的正根，v = m/min）。L4 projectZones 的带换算入口（devops#811）。
 */
export function thresholdPaceFromVdot(vdot: number): number {
  if (!Number.isFinite(vdot) || vdot <= 0) return Number.NaN;
  const discriminant = 0.182258 ** 2 + 4 * 0.000104 * (4.6 + vdot * fracMax(60));
  const vMetersPerMin = (-0.182258 + Math.sqrt(discriminant)) / (2 * 0.000104);
  return 60000 / vMetersPerMin;
}

export interface EquivalentsOptions {
  /** 短距离比赛锚：比该距离更长的等效成绩打保守折扣（默认不打）。 */
  sourceKey?: RaceDistanceKey;
  discountLonger?: number;
}

/** 同一 VDOT 的四距离等效时间（秒，取整）。 */
export function equivalentsFromVdot(vdot: number, options: EquivalentsOptions = {}): Record<RaceDistanceKey, number> {
  const out = {} as Record<RaceDistanceKey, number>;
  for (const key of RACE_DISTANCE_ORDER) {
    const sec = raceTimeSecFromVdot(RACE_DISTANCES_M[key], vdot);
    const discount =
      options.sourceKey && options.discountLonger && RACE_DISTANCE_ORDER.indexOf(key) > RACE_DISTANCE_ORDER.indexOf(options.sourceKey)
        ? options.discountLonger
        : 1;
    out[key] = Math.round(sec * discount);
  }
  return out;
}
