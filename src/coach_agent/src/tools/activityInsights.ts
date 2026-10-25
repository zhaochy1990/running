/**
 * Deterministic single-session insights — one tool call replaces the 4–7 calls
 * the QA agent used to chain for 复盘 questions (#509).
 *
 * 与 activities 工具同构：
 *   - `ActivityInsightsToolImpl` = 领域逻辑（纯计算，LangChain 无关）。
 *   - `createActivityInsightTools(store)` = 适配器，经 {@link defineCoachTools} 变成工具。
 *
 * 所有结论在代码里一次算好，LLM 只叙述、不做跨活动聚合算术：
 *   - session 强度定位（对照 running calibration 阈值）
 *   - plan_intent / plan_deviation（对照 weekly_plan 当日意图）
 *   - efficiency_delta（同配速心率 delta vs 近 4 周同 class 课基线，含样本数 n）
 *   - hr_drift（前后半程同心率漂移 + 温湿度归因：pace_explained / thermal / unexplained）
 *   - split_decay（正/负分割、末段衰减比）
 *   - load_position（课后 form/loadRatio + 本周质量课数）
 *
 * 数据全部来自既有 DataProvider（activities / laps / daily_training_load /
 * running_calibration / weekly_plan），沿用 provenance 契约。insight 缺失时逐字段
 * 降级（n=0 / available=false + 原因），不抛错。
 */

import type { StructuredTool } from "@langchain/core/tools";
import { addDays, mondayOnOrBefore, shanghaiDay, weekFolder } from "@stride/contract";
import * as z from "zod";
import type { CoachToolRuntime } from "../agents/coachAgent.js";
import { isQualityRunningActivity, isRunningActivity, normalizeSessionClass } from "../data/activityClassification.js";
import type { Activity, ActivityLap, DataProvider, WeeklyPlanDocument } from "../data/dataProvider.js";
import { defineCoachTools } from "./common.js";
import { toPaceSPerKm } from "./runningCalibration.js";

const getActivityInsightsSchema = z.object({
  labelId: z.string().min(1).describe("运动记录的唯一 ID（labelId），取自 get_activities_by_date_range 的返回。"),
});

type GetActivityInsightsInput = z.infer<typeof getActivityInsightsSchema>;

const PROVENANCE = { source: "stride", vendor_derived: false } as const;

/** HR 漂移残差阈值：校正配速差后仍 ≥3 bpm 才认为漂移超出配速可解释范围。 */
const RESIDUAL_DRIFT_BPM = 3;
/** 温湿度归因阈值（与 SKILL.md 一致：体感 >30°C 或湿度 ≥85% 视为热负荷背景）。 */
const HOT_FEELS_LIKE_C = 30;
const HUMID_PCT = 85;
/** 正/负分割判定：前后半程配速差 ≥1% 才不算 even。 */
const SPLIT_PCT = 1;

/** 分割/漂移计算的最小区段数。 */
const MIN_SPLIT_LAPS = 2;

interface LapPoint {
  distanceM: number;
  pace: number;
  /** 分段心率；null = 手表没记（split 不需要它，漂移归因才需要）。 */
  hr: number | null;
}

/** Model-facing insight payload —— snake_case，逐字段可降级。 */
export interface ActivityInsights {
  available: true;
  session: {
    label_id: string;
    day: string;
    name: string | null;
    sport: string | null;
    distance_km: number | null;
    duration_s: number | null;
    avg_pace_s_per_km: number | null;
    avg_hr: number | null;
    max_hr: number | null;
    feel: number | null;
    /** 运动员体感原话（自由文本，可分段）；null = 没说过。 */
    feel_note: string | null;
    dose: number | null;
    session_class: string | null;
    is_quality: boolean;
    weather: { feels_like_c: number | null; humidity_pct: number | null } | null;
  };
  calibration: {
    threshold_hr: number | null;
    threshold_pace_s_per_km: number | null;
    hr_pct_of_threshold: number | null;
    pace_pct_of_threshold: number | null;
  } | null;
  plan_intent:
    | { available: true; sessions: Array<{ summary: string | null; distance_km: number | null; is_quality: boolean }> }
    | {
        available: false;
        reason: "no_active_weekly_plan" | "no_run_session_on_day";
      };
  plan_deviation: {
    distance_km: number | null;
    intensity: "as_planned" | "easier_than_planned" | "harder_than_planned";
  } | null;
  efficiency_delta:
    | { n: number; method: "regression" | "mean"; expected_hr_bpm: number | null; delta_bpm: number | null }
    | { n: 0; reason: "no_baseline" | "session_class_missing" };
  hr_drift:
    | {
        laps_used: number;
        first_half_hr: number;
        second_half_hr: number;
        hr_delta_bpm: number;
        residual_bpm: number;
        pace_corrected: boolean;
        attribution: "pace_explained" | "thermal_drift" | "unexplained_drift";
      }
    | { available: false; reason: "insufficient_lap_hr_data" };
  split_decay:
    | {
        laps_used: number;
        first_half_pace_s_per_km: number;
        second_half_pace_s_per_km: number;
        pace_drift_pct: number;
        split: "negative" | "positive" | "even";
        last_lap_decay_pct: number;
      }
    | { available: false; reason: "insufficient_lap_data" };
  load_position: {
    available: boolean;
    /** form/load_ratio 实际取自哪天的 PMC 行（当天缺行时回退最近一行，叙述时要带日期）。 */
    as_of: string | null;
    day_dose: number | null;
    form: number | null;
    load_ratio: number | null;
    week_quality_count: number;
    week_quality_classes: string[];
  };
  provenance: { source: "stride"; vendor_derived: false };
}

export interface ActivityInsightsUnavailable {
  available: false;
  reason: "activity_not_found" | "not_a_running_activity";
  provenance: { source: "stride"; vendor_derived: false };
}

class ActivityInsightsToolImpl {
  constructor(private readonly store: DataProvider) {}

  async getActivityInsights(input: GetActivityInsightsInput, runtime: CoachToolRuntime): Promise<ActivityInsights | ActivityInsightsUnavailable> {
    const userId = runtime.context?.userId;
    if (!userId) {
      throw new Error("get_activity_insights: missing userId in runtime context");
    }
    const asof = runtime.context?.asof;
    if (!asof) {
      throw new Error("get_activity_insights: missing asof in runtime context");
    }
    const activity = await this.store.getActivityDetail(userId, input.labelId);
    if (!activity) {
      return { available: false, reason: "activity_not_found", provenance: PROVENANCE };
    }
    if (!isRunningActivity(activity)) {
      return { available: false, reason: "not_a_running_activity", provenance: PROVENANCE };
    }
    const day = shanghaiDayOf(activity);

    const windowStart = addDays(day, -28);
    const [summaries, loads, calibration, plan] = await Promise.all([
      this.store.getActivitySummariesByDateRange(userId, windowStart, addDays(day, -1)),
      this.store.getDailyTrainingLoadByDateRange(userId, addDays(day, -7), day),
      this.store.getLatestRunningCalibration(userId, asof),
      this.store.getWeeklyPlan(userId, weekFolder(mondayOnOrBefore(day))),
    ]);

    const points = usableLaps(activity.laps);
    const hot = (activity.feelsLike ?? -Infinity) >= HOT_FEELS_LIKE_C || (activity.humidity ?? -Infinity) >= HUMID_PCT;

    return {
      available: true,
      session: {
        label_id: activity.labelId,
        day,
        name: activity.name,
        sport: activity.sport,
        distance_km: activity.distanceM === null ? null : round(activity.distanceM / 1000, 2),
        duration_s: activity.durationS,
        avg_pace_s_per_km: activity.avgPaceSKm,
        avg_hr: activity.avgHr,
        max_hr: activity.maxHr,
        feel: activity.feel,
        feel_note: activity.feelNote,
        dose: activity.strideDose === null ? null : round(activity.strideDose, 1),
        session_class: activity.strideSessionClass,
        is_quality: isQualityRunningActivity(activity),
        weather: activity.feelsLike === null && activity.humidity === null ? null : { feels_like_c: activity.feelsLike, humidity_pct: activity.humidity },
      },
      calibration: calibrationView(activity, calibration),
      ...planView(activity, day, plan),
      efficiency_delta: efficiencyDelta(activity, summaries),
      hr_drift: hrDrift(points, hot),
      split_decay: splitDecay(points),
      load_position: loadPosition(activity, day, summaries, loads),
      provenance: PROVENANCE,
    };
  }
}

// ── 各洞察维度的计算 ──

function calibrationView(activity: Activity, calibration: Awaited<ReturnType<DataProvider["getLatestRunningCalibration"]>>): ActivityInsights["calibration"] {
  if (!calibration) return null;
  const thresholdPace = toPaceSPerKm(calibration.thresholdSpeedMps);
  return {
    threshold_hr: calibration.thresholdHr,
    threshold_pace_s_per_km: thresholdPace,
    hr_pct_of_threshold: activity.avgHr !== null && calibration.thresholdHr !== null ? round((activity.avgHr / calibration.thresholdHr) * 100, 1) : null,
    pace_pct_of_threshold: activity.avgPaceSKm !== null && thresholdPace !== null ? round((activity.avgPaceSKm / thresholdPace) * 100, 1) : null,
  };
}

function planView(activity: Activity, day: string, plan: WeeklyPlanDocument | null): Pick<ActivityInsights, "plan_intent" | "plan_deviation"> {
  const sessions = planSessionsOnDay(plan, day);
  if (sessions.length === 0) {
    return {
      plan_intent: { available: false, reason: plan ? "no_run_session_on_day" : "no_active_weekly_plan" },
      plan_deviation: null,
    };
  }
  const planned = sessions.map((session) => {
    const summary = typeof session.summary === "string" ? session.summary : null;
    const distanceM = typeof session.total_distance_m === "number" ? session.total_distance_m : null;
    return {
      summary,
      distance_km: distanceM === null ? null : round(distanceM / 1000, 2),
      is_quality: isQualityRunningActivity({ name: summary, sport: "run", sportName: null, sportNote: null, strideSessionClass: null }),
    };
  });
  const plannedKm = planned.reduce((sum, session) => sum + (session.distance_km ?? 0), 0);
  const plannedQuality = planned.some((session) => session.is_quality);
  const actualQuality = isQualityRunningActivity(activity);
  return {
    plan_intent: { available: true, sessions: planned },
    plan_deviation: {
      distance_km: plannedKm > 0 && activity.distanceM !== null ? round(activity.distanceM / 1000 - plannedKm, 2) : null,
      intensity: plannedQuality === actualQuality ? "as_planned" : plannedQuality ? "easier_than_planned" : "harder_than_planned",
    },
  };
}

function efficiencyDelta(activity: Activity, summaries: Activity[]): ActivityInsights["efficiency_delta"] {
  if (activity.strideSessionClass === null || activity.avgHr === null || activity.avgPaceSKm === null) {
    return { n: 0, reason: "session_class_missing" };
  }
  // 基线按归一化后的 session_class 分组：365 天窗口内新旧值并存（#745 枚举
  // 升级），tempo/interval 与 quality、long 与 long_easy 必须共用同一条基线，
  // 否则效率回归的样本被值域变化人为切薄。
  const classKey = normalizeSessionClass(activity.strideSessionClass);
  const baseline = summaries
    .filter((candidate) => normalizeSessionClass(candidate.strideSessionClass) === classKey)
    .filter((candidate) => candidate.avgHr !== null && candidate.avgPaceSKm !== null)
    .map((candidate) => ({ pace: candidate.avgPaceSKm as number, hr: candidate.avgHr as number }));
  if (baseline.length === 0) {
    return { n: 0, reason: "no_baseline" };
  }
  const fit = linearFit(baseline);
  if (fit) {
    const expected = fit.intercept + fit.slope * activity.avgPaceSKm;
    return { n: baseline.length, method: "regression", expected_hr_bpm: round(expected, 1), delta_bpm: round(activity.avgHr - expected, 1) };
  }
  // 样本不足或配速无方差：退化为基线平均心率差（同配速近似）。
  const meanHr = baseline.reduce((sum, point) => sum + point.hr, 0) / baseline.length;
  return { n: baseline.length, method: "mean", expected_hr_bpm: round(meanHr, 1), delta_bpm: round(activity.avgHr - meanHr, 1) };
}

function hrDrift(points: LapPoint[], hot: boolean): ActivityInsights["hr_drift"] {
  // 漂移归因需要分段心率；split 与此解耦（无 HR 的课仍有正负分割）。
  const withHr = points.filter((point): point is LapPoint & { hr: number } => point.hr !== null);
  if (withHr.length < MIN_SPLIT_LAPS) {
    return { available: false, reason: "insufficient_lap_hr_data" };
  }
  const halves = splitHalves(withHr);
  if (!halves) {
    return { available: false, reason: "insufficient_lap_hr_data" };
  }
  const firstHr = weightedMean(halves.first.map((point) => [point.hr, point.distanceM]));
  const secondHr = weightedMean(halves.second.map((point) => [point.hr, point.distanceM]));
  const firstPace = weightedMean(halves.first.map((point) => [point.pace, point.distanceM]));
  const secondPace = weightedMean(halves.second.map((point) => [point.pace, point.distanceM]));
  if (firstHr === null || secondHr === null || firstPace === null || secondPace === null) {
    return { available: false, reason: "insufficient_lap_hr_data" };
  }
  const hrDelta = secondHr - firstHr;
  const fit = linearFit(withHr);
  // ponytail: 漂移归因是 3bpm 残差 + 温湿度二分的启发式；接逐秒 timeseries 后可精算（#509 范围外）。
  const residual = fit ? hrDelta - fit.slope * (secondPace - firstPace) : hrDelta;
  return {
    laps_used: withHr.length,
    first_half_hr: round(firstHr, 1),
    second_half_hr: round(secondHr, 1),
    hr_delta_bpm: round(hrDelta, 1),
    residual_bpm: round(residual, 1),
    pace_corrected: fit !== null,
    attribution: residual < RESIDUAL_DRIFT_BPM ? "pace_explained" : hot ? "thermal_drift" : "unexplained_drift",
  };
}

function splitDecay(points: LapPoint[]): ActivityInsights["split_decay"] {
  if (points.length < MIN_SPLIT_LAPS) {
    return { available: false, reason: "insufficient_lap_data" };
  }
  const halves = splitHalves(points);
  if (!halves) {
    return { available: false, reason: "insufficient_lap_data" };
  }
  const firstPace = weightedMean(halves.first.map((point) => [point.pace, point.distanceM]));
  const secondPace = weightedMean(halves.second.map((point) => [point.pace, point.distanceM]));
  const overallPace = weightedMean(points.map((point) => [point.pace, point.distanceM]));
  if (firstPace === null || secondPace === null || overallPace === null) {
    return { available: false, reason: "insufficient_lap_data" };
  }
  const paceDriftPct = ((secondPace - firstPace) / firstPace) * 100;
  const last = points[points.length - 1];
  if (!last) {
    return { available: false, reason: "insufficient_lap_data" };
  }
  return {
    laps_used: points.length,
    first_half_pace_s_per_km: Math.round(firstPace),
    second_half_pace_s_per_km: Math.round(secondPace),
    pace_drift_pct: round(paceDriftPct, 1),
    split: paceDriftPct <= -SPLIT_PCT ? "negative" : paceDriftPct >= SPLIT_PCT ? "positive" : "even",
    last_lap_decay_pct: round(((last.pace - overallPace) / overallPace) * 100, 1),
  };
}

function loadPosition(
  activity: Activity,
  day: string,
  summaries: Activity[],
  loads: Awaited<ReturnType<DataProvider["getDailyTrainingLoadByDateRange"]>>,
): ActivityInsights["load_position"] {
  const weekStart = mondayOnOrBefore(day);
  const weekActivities = summaries.filter((candidate) => shanghaiDayOf(candidate) >= weekStart);
  const qualityWeek = [...weekActivities, activity].filter((candidate) => isQualityRunningActivity(candidate));
  const dayRow = loads.find((row) => row.date === day) ?? loads[loads.length - 1] ?? null;
  return {
    available: dayRow !== null,
    as_of: dayRow?.date ?? null,
    day_dose: dayRow?.trainingDose ?? (activity.strideDose === null ? null : round(activity.strideDose, 1)),
    form: dayRow?.form ?? null,
    load_ratio: dayRow?.loadRatio ?? null,
    week_quality_count: qualityWeek.length,
    week_quality_classes: [...new Set(qualityWeek.map((candidate) => candidate.strideSessionClass).filter((value): value is string => value !== null))],
  };
}

// ── 通用小工具 ──

function planSessionsOnDay(plan: WeeklyPlanDocument | null, day: string): Array<Record<string, unknown>> {
  const sessions = plan && Array.isArray(plan["sessions"]) ? (plan["sessions"] as unknown[]) : [];
  return sessions.filter(
    (session): session is Record<string, unknown> =>
      session !== null &&
      typeof session === "object" &&
      (session as Record<string, unknown>)["kind"] === "run" &&
      (session as Record<string, unknown>)["date"] === day,
  );
}

function usableLaps(laps: ActivityLap[]): LapPoint[] {
  return laps
    .filter((lap) => (lap.distanceM ?? 0) > 0 && lap.avgPace !== null)
    .map((lap) => ({ distanceM: lap.distanceM as number, pace: lap.avgPace as number, hr: lap.avgHr }));
}

/** 按累计距离切成前后两半；任一半没有距离（如单 lap）返回 null。 */
function splitHalves<T extends LapPoint>(points: T[]): { first: T[]; second: T[] } | null {
  const total = points.reduce((sum, point) => sum + point.distanceM, 0);
  if (total <= 0) return null;
  const first: T[] = [];
  const second: T[] = [];
  let acc = 0;
  for (const point of points) {
    (acc < total / 2 ? first : second).push(point);
    acc += point.distanceM;
  }
  const firstDistance = first.reduce((sum, point) => sum + point.distanceM, 0);
  const secondDistance = second.reduce((sum, point) => sum + point.distanceM, 0);
  return firstDistance > 0 && secondDistance > 0 ? { first, second } : null;
}

/** 加权平均（权重 = 距离）。 */
function weightedMean(pairs: Array<[number, number]>): number | null {
  const weight = pairs.reduce((sum, [, w]) => sum + w, 0);
  if (weight <= 0) return null;
  return pairs.reduce((sum, [value, w]) => sum + value * w, 0) / weight;
}

/** HR ~ pace 最小二乘拟合；样本 <3 或配速无方差时返回 null。 */
function linearFit(points: Array<{ pace: number; hr: number }>): { slope: number; intercept: number } | null {
  if (points.length < 3) return null;
  const meanPace = points.reduce((sum, point) => sum + point.pace, 0) / points.length;
  const meanHr = points.reduce((sum, point) => sum + point.hr, 0) / points.length;
  let sxx = 0;
  let sxy = 0;
  for (const point of points) {
    sxx += (point.pace - meanPace) ** 2;
    sxy += (point.pace - meanPace) * (point.hr - meanHr);
  }
  if (sxx <= 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: meanHr - slope * meanPace };
}

function shanghaiDayOf(activity: Pick<Activity, "date">): string {
  // date 是 UTC instant；活动归属的 Asia/Shanghai 日历日要 +8 后取日期。
  return shanghaiDay(activity.date.toISOString());
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * 构建单次复盘洞察工具（注入数据存储）。
 *
 * @example
 * ```ts
 * tools: [...createActivityInsightTools(store)]
 * ```
 */
export function createActivityInsightTools(store: DataProvider): StructuredTool[] {
  const impl = new ActivityInsightsToolImpl(store);
  return defineCoachTools([
    {
      name: "get_activity_insights",
      description:
        "单次跑步复盘的确定性洞察（一次调用替代多次拼装）：返回强度定位（对照阈值心率/配速）、同配速心率基线 delta（近 4 周同 class 课，含样本数）、前后半程心率漂移归因（含温湿度）、正/负分割与末段衰减、当日 weekly_plan 意图与偏差、课后负荷位置（form/loadRatio/本周质量课数）。" +
        "复盘某一次跑步时先调用本工具再作答；available=false 或某字段降级（n=0 / available=false）时回退 get_activities_by_date_range、get_activity_details、get_daily_training_load、get_running_calibration，不要编造数值。",
      schema: getActivityInsightsSchema,
      handler: (input, runtime) => impl.getActivityInsights(input, runtime),
    },
  ]);
}
