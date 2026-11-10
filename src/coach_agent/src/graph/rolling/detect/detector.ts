/**
 * 周偏差判定（#858 PR-B，纯函数、零 LLM、零 DB）：拿「计划周课（weekly 文档，
 * 含每日明细+spec）」对比「实际活动」，判定这周练得怎么样、最可能的原因是什么。
 * 产物（WeekDeviation）供 PR-C 的夜检/追问弹窗消费——数据只做**预判**
 * （preselect），用户可改选；受伤检测不出来（永远不预选 injured）。
 *
 * 分类优先级（票面 #858 定稿，先证据后规则）：
 *   跑了别的（有 class∈{quality,long_quality,race} 的 unmatched 且计划质量课/
 *   LR 有缺）> 超量（ratio ≥ 1.25）> 缺课侧（质量课/LR 全缺=missed、部分缺=
 *   volume_short——「缺课 > 练差」体现在先看缺课再看配速）> 练差侧（质量课齐
 *   但配速慢 ≥5% = poor_pace；课齐量差 ratio<0.8 = volume_short）> within_tolerance。
 */
import { addDays, type WeeklyPlan } from "@stride/contract";
import { normalizeSessionClass } from "../../../data/activityClassification.js";
import { type ActivityRef, matchWeekSessions, plannedFamilyOf, type SessionMatch } from "./matcher.js";
import { MISSED_RATIO, OVER_RATIO, PACE_SLOW_PCT, RATIO_EPSILON, SEVERE_RATIO } from "./thresholds.js";

/** 周偏差分类（分类优先级见文件头）。 */
export type DeviationClass = "within_tolerance" | "poor_pace" | "volume_short" | "missed" | "ran_other" | "over_delivery";

/** 追问菜单六项（票面定稿）：配速没达到/量没练完/没时间跑/受伤/跑了别的/完成超量。 */
export type AskReason = "pace_unmet" | "volume_unmet" | "no_time" | "injured" | "ran_other" | "over_delivered";

export interface WeekDeviation {
  /** 周一 YYYY-MM-DD（week_name 前 10 位）。 */
  weekStart: string;
  plannedKm: number;
  actualKm: number;
  /** 实际/计划（计划侧距离不可得时按 1 处理，不触发比率门）。 */
  deliveryRatio: number;
  /** 质量课完成 x/y（LR 单列 longRunDone）。 */
  qualityDone: number;
  qualityPlanned: number;
  /** 本周是否跑了计划长跑；null=本周没排 LR。 */
  longRunDone: boolean | null;
  class: DeviationClass;
  /** within_tolerance 时为 null；missed 严重时仍 no_time（受伤让用户自己选，不预判）。 */
  preselect: AskReason | null;
  /** <60% 或质量课全缺。 */
  severe: boolean;
  /** 一句话中文证据（追问弹窗直接展示）。 */
  evidence: string;
  detail: SessionMatch[];
  unmatched: ActivityRef[];
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/** 「跑了别的」证据：unmatched 活动里带强度属性的 session_class（归一后）。 */
const RAN_OTHER_CLASSES = new Set(["quality", "long_quality", "race"]);

/** 周偏差判定主入口。 */
export function assessWeek(args: { weekDoc: WeeklyPlan; activities: ActivityRef[] }): WeekDeviation {
  const { weekDoc } = args;
  const weekStart = weekDoc.week_name.slice(0, 10);
  const weekEnd = addDays(weekStart, 6);

  // 只看本周（周一~周日）的活动：day 对齐 weekDoc.week_name；跨周 ±1 日漂移在周内匹配。
  const weekActivities = args.activities.filter((activity) => activity.day >= weekStart && activity.day <= weekEnd);

  const plannedRuns = weekDoc.sessions.filter((session) => session.kind === "run");
  const planned = plannedRuns.map((session) => ({
    date: session.date,
    kind: session.kind,
    summary: session.summary,
    totalDistanceM: session.total_distance_m,
    spec: session.spec,
  }));
  const { matches, unmatchedActivities } = matchWeekSessions(planned, weekActivities);

  // 口径：plannedKm = run 会话 total_distance_m 求和（与逐课匹配同轴）；会话
  // 距离全缺时退回 target_weekly_km_low（滚动内核两个口径都填，取其一即可）。
  const sessionKm = plannedRuns.reduce((total, session) => total + (session.total_distance_m ?? 0), 0) / 1000;
  const plannedKm = sessionKm > 0 ? sessionKm : (weekDoc.target_weekly_km_low ?? 0);
  const actualKm = weekActivities.reduce((total, activity) => total + activity.distanceKm, 0);
  const deliveryRatio = plannedKm > 0 ? actualKm / plannedKm : 1;

  // 质量课与 LR 完成度。
  const qualityMatches = matches.filter((match) => plannedFamilyOf(match.planned) === "quality");
  const qualityPlanned = qualityMatches.length;
  const qualityDone = qualityMatches.filter((match) => match.activity !== null).length;
  const longMatches = matches.filter((match) => plannedFamilyOf(match.planned) === "long");
  const longRunDone = longMatches.length > 0 ? longMatches.every((match) => match.activity !== null) : null;

  const qualityMissing = qualityDone < qualityPlanned;
  const longMissing = longRunDone === false;
  const keyPlanned = qualityPlanned + longMatches.length;
  const keyDone = qualityDone + longMatches.filter((match) => match.activity !== null).length;
  const allKeyMissing = keyPlanned > 0 && keyDone === 0;

  const slowestPct = qualityMatches.reduce((worst, match) => (match.paceDeltaPct != null ? Math.max(worst, match.paceDeltaPct) : worst), 0);
  const ranOtherKm = unmatchedActivities
    .filter((activity) => {
      const normalized = normalizeSessionClass(activity.sessionClass);
      return normalized != null && RAN_OTHER_CLASSES.has(normalized);
    })
    .reduce((total, activity) => total + activity.distanceKm, 0);
  const hasRanOtherEvidence = ranOtherKm > 0;

  // 分类优先级（先证据后规则，见文件头）。
  let deviationClass: DeviationClass;
  let preselect: AskReason | null;
  if (hasRanOtherEvidence && (qualityMissing || longMissing)) {
    deviationClass = "ran_other";
    preselect = "ran_other";
  } else if (deliveryRatio >= OVER_RATIO - RATIO_EPSILON) {
    deviationClass = "over_delivery";
    preselect = "over_delivered";
  } else if (qualityMissing || longMissing) {
    // 缺课侧：全部缺=missed、部分缺=volume_short；preselect 一律 no_time（没时间跑）。
    deviationClass = allKeyMissing ? "missed" : "volume_short";
    preselect = "no_time";
  } else if (slowestPct >= PACE_SLOW_PCT) {
    deviationClass = "poor_pace";
    preselect = "pace_unmet";
  } else if (deliveryRatio < MISSED_RATIO - RATIO_EPSILON) {
    // 课齐量差（无缺课，E 量没跑够）：preselect=volume_unmet（量没练完）。
    deviationClass = "volume_short";
    preselect = "volume_unmet";
  } else {
    deviationClass = "within_tolerance";
    preselect = null;
  }

  const severe = deliveryRatio < SEVERE_RATIO - RATIO_EPSILON || (qualityPlanned > 0 && qualityDone === 0);

  // 一句话中文证据：质量课完成度、长跑、周量、（如有）配速偏慢与「跑了别的」里程。
  const parts: string[] = [];
  if (qualityPlanned > 0) parts.push(`计划 ${qualityPlanned} 节质量课完成 ${qualityDone}`);
  if (longRunDone !== null) parts.push(longRunDone ? "长跑完成" : "长跑未跑");
  if (plannedKm > 0) parts.push(`周量 ${r1(actualKm)}/${r1(plannedKm)}km（${Math.round(deliveryRatio * 100)}%）`);
  if (slowestPct >= PACE_SLOW_PCT) parts.push(`质量课配速偏慢 ${r1(slowestPct)}%`);
  if (deviationClass === "ran_other") parts.push(`另有 ${r1(ranOtherKm)}km 强度活动未对上计划课`);
  const evidence = parts.length > 0 ? parts.join("；") : "本周无计划课与活动";

  return {
    weekStart,
    plannedKm: r1(plannedKm),
    actualKm: r1(actualKm),
    deliveryRatio: Math.round(deliveryRatio * 1000) / 1000,
    qualityDone,
    qualityPlanned,
    longRunDone,
    class: deviationClass,
    preselect,
    severe,
    evidence,
    detail: matches,
    unmatched: unmatchedActivities,
  };
}

/** 多周批处理便利函数：活动按周自筛（assessWeek 内部只取当周），调用方无需预分组。 */
export function assessWeeks(args: { weekDocs: WeeklyPlan[]; activities: ActivityRef[] }): WeekDeviation[] {
  return args.weekDocs.map((weekDoc) => assessWeek({ weekDoc, activities: args.activities }));
}
