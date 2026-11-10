/**
 * 计划课↔实际活动匹配（#858 PR-B，纯函数、零 LLM、零 DB——activities 由调用方传入）。
 *
 * 匹配启发式（票面 #858 定稿）：同日 +权重 > ±1 日；距离接近度
 * （|实际−计划|/计划 ≤ MATCH_DISTANCE_TOLERANCE 可配）；课型相容（计划
 * spec.type ↔ 活动 strideSessionClass 的相容表）。贪心一对一（候选对按综合
 * 分降序配，先到先得，一节计划课最多吃一条活动、一条活动最多对一节计划课）。
 *
 * 课型相容表（计划侧 type 枚举 E/M/T/I/R/LR，见 coach_contract workout/schema.ts；
 * 活动侧 strideSessionClass 见 go sessionclass 包 + data/activityClassification 的
 * 归一——legacy tempo/interval→quality、long→long_easy 先折叠再查表）：
 *   quality（T/I/R/M）↔ quality / long_quality
 *   long（LR）        ↔ long_easy / long_quality（LR 可嵌质量尾段）
 *   race（名称判）    ↔ race
 *   easy（E）         ↔ easy / long_easy
 * 活动无 session_class（null）按通配弱分处理——可配但置信度只有 medium。
 */
import type { RunWorkout } from "@stride/contract";
import { normalizeSessionClass } from "../../../data/activityClassification.js";
import {
  MATCH_ADJACENT_DAY_SCORE,
  MATCH_DATE_WINDOW_DAYS,
  MATCH_DISTANCE_TOLERANCE,
  MATCH_NEUTRAL_DISTANCE_SCORE,
  MATCH_NULL_CLASS_SCORE,
  MATCH_WEIGHT_CLASS,
  MATCH_WEIGHT_DATE,
  MATCH_WEIGHT_DISTANCE,
} from "./thresholds.js";

/** 计划侧一节课的最小引用（来自 weekly 文档 run 会话）。 */
export interface PlannedSessionRef {
  /** YYYY-MM-DD（周内计划日）。 */
  date: string;
  /** 会话 kind（run/strength/…，匹配只消费 run，字段保留原始值）。 */
  kind: string;
  summary: string;
  totalDistanceM: number | null;
  spec: RunWorkout | null;
}

/** 实际侧一条活动的最小引用（来自 activities，跑步与否由调用方过滤）。 */
export interface ActivityRef {
  /** YYYY-MM-DD（上海日历日，与计划 date 同轴）。 */
  day: string;
  name: string;
  distanceKm: number;
  durationS: number;
  avgPaceSKm: number | null;
  sessionClass: string | null;
}

/** 一节计划课的匹配结果：activity=null 表示没对上任何活动。 */
export interface SessionMatch {
  planned: PlannedSessionRef;
  activity: ActivityRef | null;
  confidence: "high" | "medium" | "none";
  /** 配速偏差（%，正=比计划慢）；仅质量课且 spec 带可得才有值。 */
  paceDeltaPct: number | null;
}

export interface WeekMatchResult {
  matches: SessionMatch[];
  /** 没对上任何计划课的实际活动（「跑了别的」证据 + 超量里程来源）。 */
  unmatchedActivities: ActivityRef[];
}

/** 计划课课型桶（相容表的计划侧键）。 */
export type PlannedFamily = "quality" | "long" | "race" | "easy";

/** 计划侧质量课 type 值（丹尼尔斯主刺激：T/I/R + M 马配课）。 */
const QUALITY_WORKOUT_TYPES: ReadonlySet<string> = new Set(["T", "I", "R", "M"]);

/** spec.type 缺失时的名称启发（与活动侧 isQualityRunningActivity 的语汇对齐）。 */
const RACE_NAME_RE = /race|marathon|比赛|马拉松/i;
const QUALITY_NAME_RE = /interval|tempo|threshold|speed|vo2max|race[_ -]?pace|marathon[_ -]?pace|hill repeats?|坡跑|爬坡间歇|间歇|阈值|节奏|马拉松配速|马配/i;
const LONG_NAME_RE = /长跑|long[_ -]?run|\bLR\b/i;

/** 计划课课型：spec.type 优先（滚动内核产物必填），缺失时名称启发兜底（老 LLM 周课 spec 可为 null）。 */
export function plannedFamilyOf(planned: PlannedSessionRef): PlannedFamily {
  const type = planned.spec?.type ?? null;
  if (type != null) {
    if (QUALITY_WORKOUT_TYPES.has(type)) return "quality";
    if (type === "LR") return "long";
    return "easy"; // E
  }
  const name = planned.summary;
  if (RACE_NAME_RE.test(name)) return "race";
  if (QUALITY_NAME_RE.test(name)) return "quality";
  if (LONG_NAME_RE.test(name)) return "long";
  return "easy";
}

/** 相容表：计划课型 → 可配的活动 session_class（已归一）集合。 */
const COMPAT_CLASSES: Record<PlannedFamily, ReadonlySet<string>> = {
  quality: new Set(["quality", "long_quality"]),
  long: new Set(["long_easy", "long_quality"]),
  race: new Set(["race"]),
  easy: new Set(["easy", "long_easy"]),
};

/** 两个 YYYY-MM-DD 相差的天数（绝对值；日历日比较，无时区歧义）。 */
function dayDistance(a: string, b: string): number {
  return Math.abs((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * 质量带中点（s/km）：spec 的 work 步里 target.kind=pace_s_km 的带，按步时长
 * （distance_m/time_s 量值，repeat 展开）加权平均——多段质量刺激（如 I 课嵌
 * R 段）时主导刺激占大头。无 pace 处方（hr/power/open）或无 work 步 → null
 * （配速练差依据缺失，不算练差）。
 */
export function qualityBandMidpointSPerKm(spec: RunWorkout | null): number | null {
  if (spec === null) return null;
  let weighted = 0;
  let weight = 0;
  for (const block of spec.blocks) {
    for (let repetition = 0; repetition < block.repeat; repetition += 1) {
      for (const step of block.steps) {
        if (step.step_kind !== "work" || step.target.kind !== "pace_s_km") continue;
        const stepWeight = step.duration.kind === "distance_m" || step.duration.kind === "time_s" ? step.duration.value : null;
        if (stepWeight === null) continue;
        weighted += ((step.target.low + step.target.high) / 2) * stepWeight;
        weight += stepWeight;
      }
    }
  }
  return weight > 0 ? weighted / weight : null;
}

/** 单个候选对的综合分（0~1，越高越先配）。 */
interface Candidate {
  plannedIndex: number;
  activityIndex: number;
  score: number;
  sameDay: boolean;
  explicitClass: boolean;
  /** 平局裁决用（结果确定可复现）。 */
  plannedDate: string;
  activityDay: string;
}

/** 计划 run 会话 ↔ 周内活动的一对一贪心匹配；非 run 会话原样返回（activity=null、confidence=none）。 */
export function matchWeekSessions(planned: PlannedSessionRef[], activities: ActivityRef[]): WeekMatchResult {
  const candidates: Candidate[] = [];
  for (const [plannedIndex, session] of planned.entries()) {
    if (session.kind !== "run") continue;
    const family = plannedFamilyOf(session);
    const compat = COMPAT_CLASSES[family];
    for (const [activityIndex, activity] of activities.entries()) {
      const dayDelta = dayDistance(session.date, activity.day);
      if (dayDelta > MATCH_DATE_WINDOW_DAYS) continue;

      // 距离接近度：计划距离缺失时不设门（中性分），可得时超容差不配。
      let distanceScore = MATCH_NEUTRAL_DISTANCE_SCORE;
      if (session.totalDistanceM != null && session.totalDistanceM > 0) {
        const delta = Math.abs(activity.distanceKm * 1000 - session.totalDistanceM) / session.totalDistanceM;
        if (delta > MATCH_DISTANCE_TOLERANCE) continue;
        distanceScore = 1 - delta / MATCH_DISTANCE_TOLERANCE;
      }

      // 课型相容：显式相容=1，活动无 class=通配弱分，不相容直接不配。
      const normalized = normalizeSessionClass(activity.sessionClass);
      const explicitClass = normalized != null && compat.has(normalized);
      const classScore = explicitClass ? 1 : normalized == null ? MATCH_NULL_CLASS_SCORE : 0;
      if (classScore === 0) continue;

      const dateScore = dayDelta === 0 ? 1 : MATCH_ADJACENT_DAY_SCORE;
      candidates.push({
        plannedIndex,
        activityIndex,
        score: MATCH_WEIGHT_DATE * dateScore + MATCH_WEIGHT_DISTANCE * distanceScore + MATCH_WEIGHT_CLASS * classScore,
        sameDay: dayDelta === 0,
        explicitClass,
        plannedDate: session.date,
        activityDay: activity.day,
      });
    }
  }

  // 贪心一对一：综合分降序；并列时先配更早的计划课、再先配更早的活动（结果确定可复现）。
  candidates.sort(
    (a, b) => b.score - a.score || a.plannedDate.localeCompare(b.plannedDate) || a.activityDay.localeCompare(b.activityDay) || a.plannedIndex - b.plannedIndex,
  );
  const plannedTaken = new Set<number>();
  const activityTaken = new Set<number>();
  const activityOf = new Map<number, { activity: ActivityRef; confidence: "high" | "medium" }>();
  for (const candidate of candidates) {
    if (plannedTaken.has(candidate.plannedIndex) || activityTaken.has(candidate.activityIndex)) continue;
    const activity = activities[candidate.activityIndex];
    if (activity === undefined) continue;
    plannedTaken.add(candidate.plannedIndex);
    activityTaken.add(candidate.activityIndex);
    activityOf.set(candidate.plannedIndex, {
      activity,
      // 置信度：同日 + 显式课型相容 = high；±1 日漂移或活动无 class = medium。
      confidence: candidate.sameDay && candidate.explicitClass ? "high" : "medium",
    });
  }

  const matches: SessionMatch[] = planned.map((session, index) => {
    const matched = activityOf.get(index);
    if (matched === undefined) return { planned: session, activity: null, confidence: "none", paceDeltaPct: null };
    // 配速练差只对质量课成立：E 课/LR 不算练差依据（票面拍板）。
    const bandMid = plannedFamilyOf(session) === "quality" ? qualityBandMidpointSPerKm(session.spec) : null;
    const paceDeltaPct =
      bandMid != null && bandMid > 0 && matched.activity.avgPaceSKm != null
        ? Math.round(((matched.activity.avgPaceSKm - bandMid) / bandMid) * 1000) / 10
        : null;
    return { planned: session, activity: matched.activity, confidence: matched.confidence, paceDeltaPct };
  });

  const unmatchedActivities = activities.filter((_, index) => !activityTaken.has(index));
  return { matches, unmatchedActivities };
}
