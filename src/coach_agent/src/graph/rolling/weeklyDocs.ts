import {
  addDays,
  estimatedTotalDistanceM,
  type LoadPlan,
  type PhaseDivisionIntent,
  type RunWorkout,
  shanghaiDay,
  type WeeklyPlan,
  WeeklyPlanSchema,
  weekFolder,
  workoutTotals,
} from "@stride/contract";
import type { ContentWeekRow } from "../master_plan/phasing/content/doctrine.js";
import type { ScheduledOutcome } from "../master_plan/phasing/content/generate.js";
import { courseDose, DEFAULT_DOSE_COEFFICIENTS } from "../master_plan/phasing/content/schedule/dose.js";
import { phaseRefMatches } from "../master_plan/phasing/intent.js";
import { deriveWeekKeySessions, easyPaceOf, phaseSpansOf } from "../master_plan/v2Snapshot.js";

/**
 * 滚动周课文档构造（#858 PR-A Round 1，纯函数、单一真源）：把 L4 批产物
 * （ScheduledOutcome）按周映射成 weekly-plan/v1 文档数组，并填滚动扩展字段
 * （week_index、phase_name、里程碑、目标 km、偏差、剂量投影——契约 rolling.ts 段）。
 *
 * #858 PR-C 下半：key_sessions 进 weekly 文档（复用 v2 快照的 toKeySession
 * 派生——deriveWeekKeySessions 单源，排序截断规则同快照），使 Go 读合并可以
 * 零业务逻辑透传 v2 周行。营养段是契约必填的空骨架（滚动层不生成营养——
 * 那是 weekly 图的职责）。
 */

const r1 = (x: number) => Math.round(x * 10) / 10;

export interface WeeklyDocsInput {
  scheduled: ScheduledOutcome;
  batchRows: ContentWeekRow[];
  policy: PhaseDivisionIntent;
  /** 重投后的新骨架（目标 km 与周角色来源）。 */
  skeletonNew: LoadPlan;
  /** 存量骨架（偏差基准）。 */
  skeletonStored: LoadPlan;
  planStartMonday: string;
  /** 目标比赛日（key_sessions 的 race 判定，同 v2 快照 raceDate）。 */
  raceDate: string;
  athlete: { weeklyRunDaysMax: number };
}

/** RunWorkout → v1 run 会话（估距/时长/dose 可得则填；dose=L4b 同源剂量系数）。 */
function toRunSession(workout: RunWorkout, sessionIndex: number, zones: ContentWeekRow["zones"]) {
  const totals = workoutTotals(workout);
  const dose = courseDose(workout, zones, DEFAULT_DOSE_COEFFICIENTS);
  const [easyLo, easyHi] = zones.easy ?? [null, null];
  const easyMid = easyLo != null && easyHi != null ? (easyLo + easyHi) / 2 : null;
  return {
    schema: "plan-session/v1" as const,
    date: workout.date,
    session_index: sessionIndex,
    kind: "run" as const,
    summary: workout.name,
    notes_md: workout.note,
    total_distance_m: totals.total_distance_m ?? estimatedTotalDistanceM(workout, easyMid),
    total_duration_s: totals.total_duration_s,
    estimated_dose: dose.loadPt,
    spec: workout,
  };
}

/** 空营养骨架（契约 length=7 必填；滚动层不生成营养内容）。 */
function emptyNutrition(weekStart: string): WeeklyPlan["nutrition"] {
  return Array.from({ length: 7 }, (_, offset) => ({
    schema: "plan-nutrition/v1",
    date: addDays(weekStart, offset),
    kcal_target: null,
    carbs_g: null,
    protein_g: null,
    fat_g: null,
    water_ml: null,
    meals: [],
    notes_md: null,
  }));
}

/** 掉队追赶冻结：删除 date < 明天（asOf+1）的会话——已过日期排课无意义；文档头部 notes 注明。 */
export function freezePastSessions(docs: WeeklyPlan[], asOf: string): WeeklyPlan[] {
  const asOfDay = shanghaiDay(asOf);
  const cutoff = addDays(asOfDay, 1);
  return docs.map((doc) => {
    const kept = doc.sessions.filter((session) => session.date >= cutoff);
    if (kept.length === doc.sessions.length) return doc;
    // 契约要求每周至少一节 run 会话：冻结后无 run（整周已过）时保留原样——
    // 该周本就不该出现在批窗内（projection 已保证批首周=当前周），防御兜底。
    if (!kept.some((session) => session.kind === "run")) return doc;
    const firstKept = kept[0]!.date;
    const note = `本周已过日期未排课（截至 ${asOfDay}），课表自 ${firstKept} 起生效`;
    return { ...doc, sessions: kept, notes_md: [doc.notes_md, note].filter((text) => text != null).join("；") };
  });
}

/** 主入口：批内每周一个 weekly-plan/v1 文档（含滚动扩展字段），逐周过硬校验。 */
export function buildWeeklyDocs(opts: WeeklyDocsInput): WeeklyPlan[] {
  const { scheduled, batchRows, policy, skeletonNew, skeletonStored, planStartMonday, raceDate } = opts;
  const spans = phaseSpansOf(policy);
  const sessionsOfWeek = new Map(scheduled.weeks.map((week) => [week.week, week.sessions]));
  const easyPace = easyPaceOf(scheduled);

  const docs: WeeklyPlan[] = batchRows.map((row) => {
    const week = row.week;
    const weekStart = addDays(planStartMonday, (week - 1) * 7);
    const skeletonWeek = skeletonNew.weeks.find((candidate) => candidate.week === week);
    const storedWeek = skeletonStored.weeks.find((candidate) => candidate.week === week);
    if (skeletonWeek === undefined) throw new Error(`buildWeeklyDocs: 第 ${week} 周不在新骨架内`);
    const span = spans.find((candidate) => week >= candidate.start && week <= candidate.end);
    if (span === undefined) throw new Error(`buildWeeklyDocs: 第 ${week} 周不在政策阶段区间内`);

    // 会话：排位产物（含日期）→ run 会话；按日期排序、同日内 session_index 递增；
    // 无课日补 rest 会话（周计划要表达「这天不跑」而不是缺行）。
    const workouts = [...(sessionsOfWeek.get(week) ?? [])].sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
    const sessions: WeeklyPlan["sessions"] = workouts.map((workout, index) => toRunSession(workout, index, row.zones));
    const runDates = new Set(workouts.map((workout) => workout.date));
    for (let offset = 0; offset < 7; offset += 1) {
      const date = addDays(weekStart, offset);
      if (runDates.has(date)) continue;
      sessions.push({
        schema: "plan-session/v1",
        date,
        session_index: 0,
        kind: "rest",
        summary: "休息",
        notes_md: null,
        total_distance_m: null,
        total_duration_s: null,
        estimated_dose: null,
        spec: null,
      });
    }
    sessions.sort((a, b) => a.date.localeCompare(b.date) || a.session_index - b.session_index);

    // 阶段叙事：训练目标（rationale）+ 出口里程碑（L2 里程碑绑阶段出口周）。
    const milestone = policy.milestones.find((candidate) => phaseRefMatches(span.phase, candidate.phase));
    const milestoneNote = milestone != null ? `${milestone.signal}：${milestone.criterion}` : null;

    // 负荷投影：周剂量=该周 loadPt 求和；比值投影取该周末日点（chronic=0 时 null）。
    const weekPoints = scheduled.loadSeries.filter((point) => point.week === week);
    const lastPoint = weekPoints.at(-1);

    const baseKm = storedWeek?.km ?? 0;
    // key_sessions：v2 快照同源派生（E 课剔除、赛周只留比赛课、非恢复周 ≤3 /
    // 恢复周 ≤1 按总里程降序截断）——Go 读合并据此透传 v2 周行，零训练学推导。
    const keySessions = deriveWeekKeySessions(workouts, raceDate, easyPace, {
      isRaceWeek: skeletonWeek.role === "race",
      isRecoveryWeek: skeletonWeek.canonical === "recovery",
    });
    return WeeklyPlanSchema.parse({
      schema: "weekly-plan/v1",
      week_name: weekFolder(weekStart),
      sessions,
      nutrition: emptyNutrition(weekStart),
      notes_md: null,
      coach_notes: `${span.phase.training_goal}（${span.phase.rationale}）；第 ${week} 周（${skeletonWeek.role}）；出口里程碑：${milestoneNote ?? "无"}`,
      week_index: week,
      phase_name: span.name,
      phase_goal: `${span.phase.training_goal}（${span.phase.rationale}）`,
      ...(milestoneNote != null ? { milestone_note: milestoneNote } : {}),
      target_weekly_km_low: skeletonWeek.km,
      target_weekly_km_high: skeletonWeek.km,
      is_recovery_week: skeletonWeek.canonical === "recovery",
      key_sessions: keySessions,
      planned_dose: r1(weekPoints.reduce((total, point) => total + point.loadPt, 0)),
      load_ratio_projection: lastPoint != null ? (lastPoint.ratio ?? null) : null,
      km_deviation_pct: baseKm > 0 ? r1(((skeletonWeek.km - baseKm) / baseKm) * 100) : 0,
      source: scheduled.source,
    });
  });
  return docs;
}
