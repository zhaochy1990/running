import type { RunWorkout, WorkoutStep } from "@stride/contract";
import { isQualityStep, type PaceZones } from "../derive.js";

/**
 * L4b 处方剂量估算器（devops#799）：分步剂量=段时长×强度带系数，量纲与生产
 * stride_training_dose 同源——系数由生产回归标定（见本目录
 * dose-calibration-report.md 与 fixtures/dose-calibration-2026-10-29.json）。
 *
 * 标定口径：生产 activity_zones(zone_type=pace) 的区间时长（校准六区：
 * recovery+easy→E、marathon→M、threshold→T、interval→I、repetition→R）
 * 对 activity_training_load.training_dose 过原点最小二乘，全局一套系数。
 * 稳健性：剔 race 类重拟合偏差 <3%、3σ 截断重拟合偏差 <2%、bootstrap
 * p5-p95 区间见报告（R 带 7.1h 曝光最薄、CI 最宽，如实记录）。
 */

/** 五带剂量系数（dose/分钟；E 基准=1 的相对值见报告，此处为绝对值便于与生产 PMC 同量纲）。 */
export interface DoseCoefficients {
  E: number;
  M: number;
  T: number;
  I: number;
  R: number;
}

/** 标定版本（再标定后递增；随 load_meta.coefficient_version 落库）。 */
export const COEFFICIENT_VERSION = "lsq-20261029";

/**
 * 生产回归标定缺省值（2026-10-29，739 活动过原点 OLS，R²=0.851/RMSE=18.0）。
 * 相对 E：1.00 / 2.30 / 2.21 / 3.39 / 4.95——与 POC 手拍 {1, 2.5, 3.3, 4.2, 5.0}
 * 形状吻合。可被 config training_plan.dose_coefficients 覆盖。
 */
export const DEFAULT_DOSE_COEFFICIENTS: DoseCoefficients = { E: 0.59, M: 1.37, T: 1.31, I: 2.01, R: 2.94 };

/** 步处方落带的剂量带（判定表同源：质量谱内按配速中点归类；谱外/open=有氧 E）。 */
export type DoseBand = keyof DoseCoefficients;

/**
 * 配速处方（s/km）→ 剂量带：中点慢于质量谱慢端（M 带上沿+10s 容差）=有氧 E；
 * 谱内按中点落带（r/i/t/m 带缺失一侧判 E——不猜）。带边界 null（开放端）按
 * 无界处理。跨带处方（教练 MP-10s）按中点归类——剂量是连续量，归类只取系数。
 */
export function doseBandOfPace(low: number, high: number, zones: PaceZones): DoseBand {
  const mid = (low + high) / 2;
  const mBand = zones.m;
  // m 带=[快端, 慢端]（s/km，快=小）；慢端与判定表 qualitySpectrum 同口径
  // （m[1]+10s 容差）——剂量带归类与质量/有氧分账（isQualityStep）不劈叉
  if (mBand == null || mBand[1] == null) return "E";
  if (mid > mBand[1] + 10) return "E";
  if (mBand[0] == null || mid >= mBand[0]) return "M";
  if (zones.t != null && zones.t[0] != null) {
    if (mid >= zones.t[0]) return "T";
    if (zones.i != null && zones.i[0] != null) return mid >= zones.i[0] ? "I" : "R";
    return "T";
  }
  return "M";
}

/** 步时长（分钟）：time 直读；distance 按处方中点配速折算；open 配速不可知=null。 */
function stepMinutes(step: WorkoutStep): number | null {
  if (step.duration.kind === "time_s") return step.duration.value / 60;
  if (step.duration.kind === "distance_m" && step.target.kind === "pace_s_km") {
    return ((step.duration.value / 1000) * ((step.target.low + step.target.high) / 2)) / 60;
  }
  return null;
}

/** 步距离（km）：distance 直读；time 按处方中点折算；open 配速不可知=null。 */
function stepKm(step: WorkoutStep): number | null {
  if (step.duration.kind === "distance_m") return step.duration.value / 1000;
  if (step.duration.kind === "time_s" && step.target.kind === "pace_s_km") {
    return step.duration.value / ((step.target.low + step.target.high) / 2);
  }
  return null;
}

/** 课的分段核算：剂量点数 + 有氧/强度里程（判定表口径：质量步=强度、其余=有氧）。 */
export interface CourseDose {
  /** 处方剂量（Σ步时长×带系数；rest 步不计）。 */
  loadPt: number;
  /** 有氧里程 km（含 open 时间步的 0 距离贡献）。 */
  aerobicKm: number;
  /** 强度（质量段）里程 km。 */
  intensityKm: number;
  /** 总里程 km；任一跑步步里程不可知（open+time）则 null。 */
  km: number | null;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** 单课剂量核算（repeat 展开；rest=不在跑不计；recovery/open=有氧 E 带）。 */
export function courseDose(workout: RunWorkout, zones: PaceZones, coefficients: DoseCoefficients): CourseDose {
  let loadPt = 0;
  let aerobicKm = 0;
  let intensityKm = 0;
  let kmKnown = true;
  for (const block of workout.blocks) {
    for (let rep = 0; rep < block.repeat; rep++) {
      for (const step of block.steps) {
        if (step.step_kind === "rest") continue;
        const minutes = stepMinutes(step);
        const band: DoseBand = step.target.kind === "pace_s_km" ? doseBandOfPace(step.target.low, step.target.high, zones) : "E";
        if (minutes != null) loadPt += minutes * coefficients[band];
        const stepKmV = stepKm(step);
        if (stepKmV == null) {
          kmKnown = false;
          continue;
        }
        if (isQualityStep(step, zones)) intensityKm += stepKmV;
        else aerobicKm += stepKmV;
      }
    }
  }
  return {
    loadPt: Math.round(loadPt * 10) / 10,
    aerobicKm: round1(aerobicKm),
    intensityKm: round1(intensityKm),
    km: kmKnown ? round1(aerobicKm + intensityKm) : null,
  };
}

// ── 标定拟合器（标定脚本与单测共用；快照 fixtures/dose-calibration-2026-10-29.json）──

export interface CalibrationRow {
  /** 五带区间时长（分钟；E=recovery+easy 两区合并）。 */
  bands: [number, number, number, number, number];
  /** 生产 training_dose。 */
  dose: number;
}

export interface FitReport {
  coefficients: DoseCoefficients;
  n: number;
  r2: number;
  rmse: number;
  /** 各带曝光小时数（拟合样本内）。 */
  exposureHours: [number, number, number, number, number];
  /** 残差分位（|pred−y|，p50/p90）。 */
  residualP50: number;
  residualP90: number;
}

/** 5×5 线性方程组高斯消元（部分主元；标定唯一用途，奇异矩阵抛错）。 */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    if (Math.abs(m[pivot]![col]!) < 1e-12) throw new Error("fitDoseCoefficients: 奇异方程组（某带零曝光）");
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    for (let r = col + 1; r < n; r++) {
      const f = m[r]![col]! / m[col]![col]!;
      for (let c = col; c <= n; c++) m[r]![c]! -= f * m[col]![c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r]![n]!;
    for (let c = r + 1; c < n; c++) s -= m[r]![c]! * x[c]!;
    x[r] = s / m[r]![r]!;
  }
  return x;
}

/** 过原点最小二乘（无截距：零时长=零剂量，物理约束）。 */
export function fitDoseCoefficients(rows: CalibrationRow[]): FitReport {
  if (rows.length < 10) throw new Error(`fitDoseCoefficients: 样本不足（n=${rows.length}）`);
  const ata: number[][] = Array.from({ length: 5 }, () => new Array<number>(5).fill(0));
  const aty = new Array<number>(5).fill(0);
  const exposure = new Array<number>(5).fill(0);
  let yMean = 0;
  for (const { bands, dose } of rows) {
    for (let i = 0; i < 5; i++) {
      exposure[i]! += bands[i]!;
      aty[i]! += bands[i]! * dose;
      for (let j = 0; j < 5; j++) ata[i]![j]! += bands[i]! * bands[j]!;
    }
    yMean += dose;
  }
  yMean /= rows.length;
  const raw = solve(ata, aty);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const coefficients: DoseCoefficients = { E: r2(raw[0]!), M: r2(raw[1]!), T: r2(raw[2]!), I: r2(raw[3]!), R: r2(raw[4]!) };

  let ssRes = 0;
  let ssTot = 0;
  const residuals: number[] = [];
  for (const { bands, dose } of rows) {
    const pred = bands.reduce((s, x, i) => s + x * raw[i]!, 0);
    ssRes += (dose - pred) ** 2;
    ssTot += (dose - yMean) ** 2;
    residuals.push(Math.abs(dose - pred));
  }
  residuals.sort((a, b) => a - b);
  const pct = (p: number) => residuals[Math.min(residuals.length - 1, Math.floor(p * residuals.length))]!;
  return {
    coefficients,
    n: rows.length,
    r2: Math.round((1 - ssRes / ssTot) * 1000) / 1000,
    rmse: Math.round(Math.sqrt(ssRes / rows.length) * 10) / 10,
    exposureHours: exposure.map((x) => Math.round((x / 60) * 10) / 10) as [number, number, number, number, number],
    residualP50: Math.round(pct(0.5) * 10) / 10,
    residualP90: Math.round(pct(0.9) * 10) / 10,
  };
}
