/**
 * Recovery-status tool — expose the HRV/RHR daily series to the QA agent (#535).
 *
 * 与 activities 工具同构：
 *   - `RecoveryToolImpl` = 领域逻辑（纯计算，LangChain 无关）。
 *   - `createRecoveryTools(store)` = 适配器，经 {@link defineCoachTools} 变成工具。
 *
 * 数据全部来自既有 DataProvider（`getDailyRecoveryByDateRange` 的
 * daily_health⟕daily_hrv 日聚合 + `getVendorHrvBaseline` 的厂商基线区间），
 * 结论在代码里算好、LLM 只叙述：
 *   - `lastNight`：最近一夜 HRV 对厂商基线区间的三分类（below/within/above；缺数或无基线 = no_data）
 *   - `rhrTrend`：近 7 日 vs 前 7 日静息心率均值对比（direction = rising/falling/stable）
 *   - `coverage`：返回窗口内 HRV/RHR 各自的覆盖天数 + 来源 provider，供 LLM 判断可信度
 *
 * 无任何恢复数据时整体降级 `available=false`（新用户或厂商未同步），SKILL 指导
 * LLM 回退 PMC 负荷分析；序列稀疏/部分缺失时逐字段降级，不抛错。
 *
 * provenance 说明：日序列 rhr/hrv 是原始测量值（vendor_derived=false）；`hrvBaseline`
 * 本身是厂商自算基线，其来源由字段内的 `provider` 披露。
 */

import type { StructuredTool } from "@langchain/core/tools";
import { addDays, shanghaiDay } from "@stride/contract";
import * as z from "zod";
import type { CoachToolRuntime } from "../agents/coachAgent.js";
import type { DailyRecovery, DataProvider } from "../data/dataProvider.js";
import { defineCoachTools } from "./common.js";

const getRecoveryStatusSchema = z.object({
  days: z.number().int().min(1).max(60).optional().describe("返回最近多少天的日序列（含 asof 当天）。缺省 14，上限 60。"),
});

type GetRecoveryStatusInput = z.infer<typeof getRecoveryStatusSchema>;

/** 未显式传 `days` 时的默认窗口：恢复类问题的常规视角（两周）。 */
const DEFAULT_RECOVERY_DAYS = 14;
/** rhrTrend 需要近 7 + 前 7 = 14 天；`days` 再小也按 14 天取数（返回时序列截断到 `days`）。 */
const TREND_WINDOW_DAYS = 14;
/**
 * RHR 趋势方向阈值：前后 7 日均值变化 ≥2 bpm 才判 rising/falling（静息心率日测噪声约
 * 1–2 bpm）。疲劳积累的叙事阈值（≥5 bpm）留在 SKILL.md，由 LLM 结合 context 判断。
 */
const RHR_TREND_BPM = 2;

const PROVENANCE = { source: "stride", vendor_derived: false } as const;

/** Model-facing payload —— camelCase 与 DataProvider 行保持一致，逐字段可降级。 */
export interface RecoveryStatus {
  available: true;
  asOf: string;
  days: number;
  daily: DailyRecovery[];
  hrvBaseline: { low: number; high: number; provider: string; date: string } | null;
  lastNight: {
    date: string | null;
    hrv: number | null;
    vsBaseline: "below" | "within" | "above" | "no_data";
  };
  rhrTrend:
    | {
        available: true;
        recent7Avg: number;
        recent7Days: number;
        prior7Avg: number;
        prior7Days: number;
        deltaBpm: number;
        direction: "rising" | "falling" | "stable";
      }
    | { available: false; reason: "insufficient_rhr_data" };
  coverage: {
    windowDays: number;
    daysWithHrv: number;
    daysWithRhr: number;
    provider: string | null;
  };
  provenance: { source: "stride"; vendor_derived: false };
}

export interface RecoveryStatusUnavailable {
  available: false;
  reason: "no_recovery_data";
  provenance: { source: "stride"; vendor_derived: false };
}

class RecoveryToolImpl {
  constructor(private readonly store: DataProvider) {}

  async getRecoveryStatus(input: GetRecoveryStatusInput, runtime: CoachToolRuntime): Promise<RecoveryStatus | RecoveryStatusUnavailable> {
    const userId = runtime.context?.userId;
    if (!userId) {
      throw new Error("get_recovery_status: missing userId in runtime context");
    }
    const asof = runtime.context?.asof;
    if (!asof) {
      throw new Error("get_recovery_status: missing asof in runtime context");
    }
    const days = input.days ?? DEFAULT_RECOVERY_DAYS;
    const end = shanghaiDay(asof);
    // 趋势窗口锚定在最新有数的一天（见 rhrTrend），其前 7 日可能落在请求窗口之前：
    // 多取 13 天保证锚点在近两周内时两个窗口都完整；日聚合行极小，多取无成本。
    const start = addDays(end, -(Math.max(days, TREND_WINDOW_DAYS) + TREND_WINDOW_DAYS - 2));
    const [recovery, baseline] = await Promise.all([this.store.getDailyRecoveryByDateRange(userId, start, end), this.store.getVendorHrvBaseline(userId, end)]);
    const measured = recovery.filter((row) => row.rhr !== null || row.hrv !== null);
    if (measured.length === 0) {
      return { available: false, reason: "no_recovery_data", provenance: PROVENANCE };
    }
    // 序列按请求的日历窗口截断（含 asof 当天）；稀疏同步时行数少于 days，coverage 如实反映。
    const daily = measured.filter((row) => row.date >= addDays(end, -(days - 1)));
    return {
      available: true,
      asOf: end,
      days,
      daily,
      hrvBaseline:
        baseline && baseline.low !== null && baseline.high !== null
          ? { low: baseline.low, high: baseline.high, provider: baseline.provider, date: baseline.date }
          : null,
      lastNight: lastNightVsBaseline(measured, baseline),
      rhrTrend: rhrTrend(measured),
      coverage: {
        windowDays: days,
        daysWithHrv: daily.filter((row) => row.hrv !== null).length,
        daysWithRhr: daily.filter((row) => row.rhr !== null).length,
        provider: baseline?.provider ?? null,
      },
      provenance: PROVENANCE,
    };
  }
}

/** 最近一夜 HRV（取数窗口内最新的非空行，可能在请求窗口之外——date 披露滞后）。 */
function lastNightVsBaseline(daily: DailyRecovery[], baseline: Awaited<ReturnType<DataProvider["getVendorHrvBaseline"]>>): RecoveryStatus["lastNight"] {
  const lastNight = daily.findLast((row) => row.hrv !== null) ?? null;
  if (!lastNight || lastNight.hrv === null || !baseline || baseline.low === null || baseline.high === null) {
    return { date: lastNight?.date ?? null, hrv: lastNight?.hrv ?? null, vsBaseline: "no_data" };
  }
  const hrv = lastNight.hrv;
  const vsBaseline = hrv < baseline.low ? "below" : hrv > baseline.high ? "above" : "within";
  return { date: lastNight.date, hrv, vsBaseline };
}

/**
 * 近 7 日 vs 前 7 日静息心率均值。窗口锚定在最新有数的一天（而非 asof），厂商停更时
 * 两个窗口仍以最后一次同步为中心对称取数。
 */
function rhrTrend(measured: DailyRecovery[]): RecoveryStatus["rhrTrend"] {
  const anchor = measured.findLast((row) => row.rhr !== null);
  if (!anchor) {
    return { available: false, reason: "insufficient_rhr_data" };
  }
  const recent = windowAverage(measured, addDays(anchor.date, -6), anchor.date);
  const prior = windowAverage(measured, addDays(anchor.date, -13), addDays(anchor.date, -7));
  if (!recent || !prior) {
    return { available: false, reason: "insufficient_rhr_data" };
  }
  const deltaBpm = recent.mean - prior.mean;
  return {
    available: true,
    recent7Avg: round(recent.mean, 1),
    recent7Days: recent.count,
    prior7Avg: round(prior.mean, 1),
    prior7Days: prior.count,
    deltaBpm: round(deltaBpm, 1),
    direction: deltaBpm >= RHR_TREND_BPM ? "rising" : deltaBpm <= -RHR_TREND_BPM ? "falling" : "stable",
  };
}

/** [start, end] 闭区间内非空 rhr 的算术平均与样本数；一个样本都没有才返回 null。 */
function windowAverage(measured: DailyRecovery[], start: string, end: string): { mean: number; count: number } | null {
  const values = measured.filter((row) => row.date >= start && row.date <= end && row.rhr !== null).map((row) => row.rhr as number);
  if (values.length === 0) return null;
  return { mean: values.reduce((sum, value) => sum + value, 0) / values.length, count: values.length };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * 构建恢复状态工具（注入数据存储）。
 *
 * @example
 * ```ts
 * tools: [...createRecoveryTools(store)]
 * ```
 */
export function createRecoveryTools(store: DataProvider): StructuredTool[] {
  const impl = new RecoveryToolImpl(store);
  return defineCoachTools([
    {
      name: "get_recovery_status",
      description:
        "获取运动员最近 N 天的恢复状态：HRV/静息心率日序列（Asia/Shanghai 日历日，最早在前）+ 厂商 HRV 基线区间。" +
        "代码一次算好三组确定性结论：lastNight（最近一夜 HRV 对厂商基线的三分类，below=交感受抑制）、rhrTrend（近 7 日 vs 前 7 日静息心率均值与方向）、coverage（覆盖天数与来源 provider，判断数据可信度）。" +
        "状态/疲劳/恢复/HRV/静息心率类问题必先调用本工具；available=false（no_recovery_data，新用户或厂商未同步恢复数据）时回退 get_daily_training_load 用 PMC 负荷分析，不要编造数值。",
      schema: getRecoveryStatusSchema,
      handler: (input, runtime) => impl.getRecoveryStatus(input, runtime),
    },
  ]);
}
