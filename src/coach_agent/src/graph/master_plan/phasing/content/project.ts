import { thresholdPaceFromVdot, vdotFromRace } from "../vdot.js";
import type { PaceZones } from "./derive.js";

/**
 * projectZones 能力递进投影（devops#811，daniels-l4-content.md §4 / contract.md 规则⑥）：
 * 把「当前 VDOT → 目标完赛时间」翻译成逐周 VDOT 轨迹 + 训练六带。
 *
 * 形状（§4 ①-⑥）：target_vdot=vdotFromRace；目标不高于当前=恒定维持；否则起点
 * v0=min(当前, 目标−2)（丹氏第 14 章 2Q 原生式）、逐周 +min(直线均摊, 分档封顶)；
 * 封顶=群体 p90 取整（20 用户标定+17 用户 1800 三元组回测中位偏差 −0.08 无偏）。
 * 撞帽=贴帽凹线、比赛周带可未达目标（丹氏「逼近不抵达」）；残差→风险声明，
 * 比赛课处方仍锚 goal_pace（规则⑤，带不降级处方）。带换算=阈值配速闭式逆
 * （thresholdPaceFromVdot）× 校准管线同源速度比（go/internal/compute/calibration/
 * zones.go paceZoneSpeedRatios——勿另发明比例）。
 */

/** 每周 VDOT 递增封顶（/周，按递增前 VDOT 分档；p90 分档取整 0.82/0.49/0.22 → 0.8/0.5/0.25）。 */
const CAP_TIERS: ReadonlyArray<{ minVdot: number; cap: number }> = [
  { minVdot: 52, cap: 0.25 },
  { minVdot: 45, cap: 0.5 },
  { minVdot: 0, cap: 0.8 },
];
const capOf = (vdot: number) => CAP_TIERS.find((tier) => vdot >= tier.minVdot)!.cap;

/** 六带速度比（相对阈值速度，快端→慢端；r 快端开放；校准管线同源）。 */
const ZONE_SPEED_RATIOS = { easy: [0.72, 0.84], m: [0.84, 0.97], t: [0.97, 1.03], i: [1.03, 1.11], r: [1.11, null] } as const;

const round2 = (x: number) => Math.round(x * 100) / 100;

/** VDOT → 训练六带（s/km 取整秒；带=阈值配速÷速度比）。 */
function zonesOfVdot(vdot: number): PaceZones {
  const pT = thresholdPaceFromVdot(vdot);
  const pace = (ratio: number) => Math.round(pT / ratio);
  return {
    easy: [pace(ZONE_SPEED_RATIOS.easy[1]), pace(ZONE_SPEED_RATIOS.easy[0])],
    m: [pace(ZONE_SPEED_RATIOS.m[1]), pace(ZONE_SPEED_RATIOS.m[0])],
    t: [pace(ZONE_SPEED_RATIOS.t[1]), pace(ZONE_SPEED_RATIOS.t[0])],
    i: [pace(ZONE_SPEED_RATIOS.i[1]), pace(ZONE_SPEED_RATIOS.i[0])],
    r: [null, pace(ZONE_SPEED_RATIOS.r[0])],
  };
}

export interface ProjectedWeekZones {
  week: number;
  /** 该周训练带锚定的 VDOT（v0 起、逐周 +min(ideal, cap)；维持路径恒定当前）。 */
  vdot: number;
  /** 该周训练六带（s/km 取整秒；r 快端开放）。 */
  zones: PaceZones;
}

export interface ProjectZonesMeta {
  /** 任一周 ideal>cap（曲线贴帽凹线）。 */
  capped: boolean;
  /** target_vdot − 终点 VDOT（撞帽时=残余差距，multi_cycle 风险量化素材）。 */
  residual: number;
  /** 直线抵达所需斜率（VDOT/周）——风险声明「所需斜率 vs 群体分位（cap=p90）」的对照项。 */
  requiredSlope: number;
}

export interface ProjectZonesResult {
  weeks: ProjectedWeekZones[];
  meta: ProjectZonesMeta;
}

/**
 * 投影主入口（纯函数）。runwayWeeks ≥1；currentVdot/targetTimeSec 无效或距离
 * 不在方程域内（vdotFromRace 返回 NaN）直接抛错——投影是生成输入的构造前提，
 * 脏证据应在更上游拦截。
 */
export function projectZones(currentVdot: number, targetTimeSec: number, distanceM: number, runwayWeeks: number): ProjectZonesResult {
  const targetVdot = vdotFromRace(distanceM, targetTimeSec);
  if (!Number.isFinite(currentVdot) || currentVdot <= 0 || !Number.isFinite(targetVdot)) {
    throw new Error(`projectZones: 无效入参 current=${currentVdot} targetTime=${targetTimeSec}s distance=${distanceM}m`);
  }
  if (!Number.isInteger(runwayWeeks) || runwayWeeks < 1) {
    throw new Error(`projectZones: runwayWeeks=${runwayWeeks}`);
  }

  const push = (weeks: ProjectedWeekZones[], week: number, vdot: number) => weeks.push({ week, vdot: round2(vdot), zones: zonesOfVdot(vdot) });
  const slope = (gap: number) => round2(runwayWeeks > 1 ? gap / (runwayWeeks - 1) : gap);

  // ② 目标不高于当前：恒定当前带（维持），无递进。
  if (targetVdot <= currentVdot) {
    const weeks: ProjectedWeekZones[] = [];
    for (let w = 1; w <= runwayWeeks; w++) push(weeks, w, currentVdot);
    return { weeks, meta: { capped: false, residual: round2(targetVdot - currentVdot), requiredSlope: slope(targetVdot - currentVdot) } };
  }

  // ③ 起点：不高于目标−2（丹氏 2Q「头 6 周」原生式——目标远高于当前时降起点）。
  let v = Math.min(currentVdot, targetVdot - 2);
  const weeks: ProjectedWeekZones[] = [];
  push(weeks, 1, v);
  let capped = false;
  // ④ 逐周：ideal=剩余均摊（未撞帽=直线精确抵达），cap=分档封顶（撞帽=贴帽凹线）。
  for (let w = 2; w <= runwayWeeks; w++) {
    const ideal = (targetVdot - v) / (runwayWeeks - w + 1);
    const cap = capOf(v);
    if (ideal > cap) capped = true;
    v += Math.min(ideal, cap);
    push(weeks, w, v);
  }
  return { weeks, meta: { capped, residual: round2(targetVdot - v), requiredSlope: slope(targetVdot - Math.min(currentVdot, targetVdot - 2)) } };
}
