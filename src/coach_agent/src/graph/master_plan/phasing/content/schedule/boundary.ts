import { addDays, type WeeklyPlan } from "@stride/contract";
import { isRunLikeActivity, normalizeSessionClass, QUALITY_SESSION_CLASSES } from "../../../../../data/activityClassification.js";
import type { PhasingActivityInput } from "../../evidence.js";
import { hasQualitySegment, type PaceZones } from "../derive.js";
import { type DayFact, unknownDay } from "./distribution.js";
import { courseMinutes } from "./dose.js";

/**
 * 批次首周之前的已知相邻日历（devops#1043）：首周之前 7 天逐日取事实——已发生
 * 的日期用实绩（活动按 Provider 的 shanghaiDay 归日），其后的日期用仍生效的
 * 存量周安排；两者都没有=未知日。生成当天只认已发生的实绩（没跑≠休息）。
 * 首次生成只带实绩（无存量安排）；滚动续排带实绩 + 上一批末周的生效课表。
 */

/** 跑步日活动线（km）：与 habitual 周序列同口径（buildWeeklySeries）。 */
const RUN_DAY_MIN_KM = 0.5;
/** 实绩里的关键课：质量课族 + 长距离有氧/质量课。 */
const KEY_CLASSES = new Set([...QUALITY_SESSION_CLASSES, "long_easy"]);

const classOf = (activity: PhasingActivityInput): string | null => normalizeSessionClass(activity.strideSessionClass);
const hasClass = (activity: PhasingActivityInput, classes: Set<string>): boolean => {
  const sessionClass = classOf(activity);
  return sessionClass != null && classes.has(sessionClass);
};
/** 全部已知才求和；任一未知=null。 */
const sumOf = (values: ReadonlyArray<number | null | undefined>): number | null =>
  values.every((value) => value != null) ? (values as number[]).reduce((total, value) => total + value, 0) : null;
const restFact = (date: string): DayFact => ({ date, run: false, runMinutes: 0, loadPt: 0, key: false, quality: false });

/** 实绩日：≥0.5km 的跑步活动算跑步，同日多条合计。 */
function actualFact(date: string, activities: readonly PhasingActivityInput[]): DayFact {
  const runs = activities.filter((activity) => isRunLikeActivity(activity) && (activity.distanceM ?? 0) / 1000 >= RUN_DAY_MIN_KM);
  if (runs.length === 0) return restFact(date);
  return {
    date,
    run: true,
    runMinutes: sumOf(runs.map((activity) => (activity.durationS == null ? null : activity.durationS / 60))),
    loadPt: sumOf(runs.map((activity) => activity.strideDose)),
    key: runs.some((activity) => hasClass(activity, KEY_CLASSES)),
    quality: runs.some((activity) => hasClass(activity, QUALITY_SESSION_CLASSES)),
  };
}

/**
 * 生效安排日：存量周文档的跑步会话（无跑步会话=按安排休息）。会话没有 spec
 * （只有时长/剂量汇总）时关键课属性未知。
 */
function plannedFact(date: string, sessions: WeeklyPlan["sessions"], zones: PaceZones | null): DayFact {
  const runs = sessions.filter((session) => session.kind === "run");
  if (runs.length === 0) return restFact(date);
  const specs = runs.flatMap((session) => (session.spec != null ? [session.spec] : []));
  const quality = specs.length === runs.length && zones != null ? specs.some((spec) => hasQualitySegment(spec, zones)) : null;
  return {
    date,
    run: true,
    runMinutes: sumOf(
      runs.map((session) => (session.spec != null ? courseMinutes(session.spec) : session.total_duration_s == null ? null : session.total_duration_s / 60)),
    ),
    loadPt: sumOf(runs.map((session) => session.estimated_dose)),
    key: quality == null ? null : quality || specs.some((spec) => spec.type === "LR"),
    quality,
  };
}

export function boundaryBefore(args: {
  /** 批次首周周一。 */
  startMonday: string;
  /** 生成时点（上海日历日）；其后的日期算未来。 */
  asOfDay: string | null;
  /** 截至 asOfDay 的活动（Provider 已按 shanghaiDay 归日）；缺省=实绩未知。 */
  activities?: readonly PhasingActivityInput[];
  /** 首周之前一周的存量周文档；无=null（未来日=未知）。 */
  existingDoc?: WeeklyPlan | null;
  /** 存量周所处周的训练带（质量课判定用）；缺省=质量课属性未知。 */
  zones?: PaceZones | null;
}): DayFact[] {
  const activitiesByDay = new Map<string, PhasingActivityInput[]>();
  for (const activity of args.activities ?? []) activitiesByDay.set(activity.shanghaiDay, [...(activitiesByDay.get(activity.shanghaiDay) ?? []), activity]);
  return Array.from({ length: 7 }, (_, offset): DayFact => {
    const date = addDays(args.startMonday, offset - 7);
    if (args.asOfDay != null && date <= args.asOfDay) {
      const actual = args.activities == null ? unknownDay(date) : actualFact(date, activitiesByDay.get(date) ?? []);
      // 生成当天还没有跑步活动≠休息（上午生成、下午的长跑还没发生）：按生效安排，
      // 没有安排=未知
      if (date < args.asOfDay || actual.run === true) return actual;
    }
    if (args.existingDoc == null) return unknownDay(date);
    return plannedFact(
      date,
      args.existingDoc.sessions.filter((session) => session.date === date),
      args.zones ?? null,
    );
  });
}
