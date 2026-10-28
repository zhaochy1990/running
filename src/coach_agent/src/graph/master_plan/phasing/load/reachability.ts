import type { PhaseDivisionIntent } from "../intent.js";
import { phaseRefMatches } from "../intent.js";

/**
 * 带下限可达性（devops#793 F 节，daniels-l3-load.md §4 门 2 的 L2 侧配套）：
 * 布局本身（前置 recovery 长度、伤退低起点）决定 lo 是否 ACWR 可达——
 * 如 rec2+F2 布局下 transQ 带 75-100 第 5 周爬不到。L2 门用最大爬坡包络
 * 模拟校验；L3 构造低于 lo 的逐周递增/帽压制周仍合法（爬坡豁免兜底）。
 *
 * 本文件同时是构造物理常量（ACWR 帽/recovery 构造位）的单一真源——
 * 展开器（load/expand.ts）与这里的包络模拟共用同一套数，避免 L2 门与
 * L3 构造口径劈叉。保持叶子模块（只依赖 intent 契约）。
 */

/** 构造用 ACWR 帽（门 1.3 留 2% 余量；实测教训：建设周单调不降修正与帽冲突已撤回）。 */
export const BUILD_CAP = 1.28;
/** recovery 构造位：min(带 lo, max(15, 起点×0.7))。 */
export const RECOVERY_FLOOR_KM = 15;
export const RECOVERY_FACTOR = 0.7;
/** 比赛里程（km）：FM（判断层教义只验证 FM；距离 profile 化另票，spec §7）——赛周公式与 L4 门激活量判据共用。 */
export const RACE_KM = 42.195;
/** FM 赛周激活带（km，丹尼尔斯原教义 10-15km@MP）：展开器赛周公式与 L4 门低量档判据同源。 */
export const ACTIVATION_MIN_KM = 10;
export const ACTIVATION_MAX_KM = 15;
/** 与 L3 带贴合门一致的 lo 容差（km）。 */
const LO_TOLERANCE_KM = 2;

export interface ReachabilitySeed {
  /** 赛前 4 实际完成周均值（滚动均值种子，补零口径）。 */
  seedAvg4Km: number;
  /** 常态基线（recovery 周构造位 = min(lo, max(15, 0.7×该值))）。 */
  recoveryLevelKm: number;
  /** ACWR 不适用（断练回归/零史——滚动均值被零周污染）时本门整体豁免：
   *  可达性本质是 ACWR 论证，构造从起点爬坡、L3 带贴合豁免兜底。 */
  acwrApplicable: boolean;
}

/** 阶段在周 w 的体量带（无带时返回 null）。 */
export function bandOf(intent: PhaseDivisionIntent, phase: { canonical: string; name: string }): { weekly_km_min: number; weekly_km_max: number } | null {
  return intent.volume_bands.find((b) => phaseRefMatches(phase, b.phase)) ?? null;
}

/**
 * 包络模拟构芯：按展开器同款物理（recovery 低量平、建设周 min(hi, 1.28×滚动
 * 均值)、taper 不要求进带）逐周爬坡，返回各阶段（recovery/taper 周除外）布局
 * 内最高位。T 兜底的 lo 夹持（fallback.ts #813）与本门的可达性判定共用同一
 * 模拟，口径不劈叉。
 */
export function envelopeReachedKm(intent: PhaseDivisionIntent, seed: ReachabilitySeed): Map<string, number> {
  const phases = [...intent.phases].sort((a, b) => a.start_week - b.start_week);
  const N = phases.at(-1)?.end_week ?? 0;
  const reached = new Map<string, number>();
  if (N === 0 || !seed.acwrApplicable) return reached;
  const taperW = Math.min(intent.taper_weeks, 3);
  const window: number[] = [seed.seedAvg4Km, seed.seedAvg4Km, seed.seedAvg4Km, seed.seedAvg4Km];
  for (let w = 1; w <= N; w++) {
    const p = phases.find((x) => x.start_week <= w && w <= x.end_week) ?? phases.at(-1)!;
    const band = bandOf(intent, p);
    const lo = band?.weekly_km_min ?? 10;
    const hi = band?.weekly_km_max ?? 120;
    const inTaper = p.canonical === "final_quality" && p.end_week - w < taperW;
    let km: number;
    if (p.canonical === "recovery") {
      km = Math.min(lo, Math.max(RECOVERY_FLOOR_KM, seed.recoveryLevelKm * RECOVERY_FACTOR));
    } else if (inTaper) {
      km = lo * 0.7; // taper 周不要求进带，量值仅供滚动均值延续
    } else {
      km = Math.min(hi, BUILD_CAP * (window.reduce((s, x) => s + x, 0) / window.length));
    }
    window.push(km);
    window.shift();
    if (p.canonical !== "recovery" && !inTaper) {
      reached.set(p.canonical, Math.max(reached.get(p.canonical) ?? 0, km));
    }
  }
  return reached;
}

/** 带下限可达性门：lo 不可达的建设阶段清单（空=全可达；ACWR 不适用整体豁免）。 */
export function bandLoReachabilityIssues(intent: PhaseDivisionIntent, seed: ReachabilitySeed): string[] {
  if (!seed.acwrApplicable) return [];
  const reached = envelopeReachedKm(intent, seed);
  const phases = [...intent.phases].sort((a, b) => a.start_week - b.start_week);
  const issues: string[] = [];
  for (const p of phases) {
    // 只校验建设阶段：final_quality 的 lo 是「平台目标」语义，短跑道/低量下
    // 从 ACWR 帽下直接进 taper 合法（L3 爬坡豁免兜底）；票面 F 的两形态
    // （伤退低起点、前置 recovery 布局）都落在建设阶段。
    if (p.canonical !== "foundation" && p.canonical !== "early_quality" && p.canonical !== "transition_quality") continue;
    const band = bandOf(intent, p);
    const lo = band?.weekly_km_min ?? 0;
    if (lo > 0 && (reached.get(p.canonical) ?? 0) < lo - LO_TOLERANCE_KM) {
      issues.push(`${p.canonical} lo=${lo} 布局内最高爬至 ${Math.round(reached.get(p.canonical) ?? 0)}`);
    }
  }
  return issues;
}
