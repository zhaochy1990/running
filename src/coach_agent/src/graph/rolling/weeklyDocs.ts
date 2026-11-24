import {
  addDays,
  estimatedTotalDistanceM,
  type LoadPlan,
  type PhaseDivisionIntent,
  type RollingStrengthAvailability,
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
import { c9QualityWeekdays } from "../master_plan/phasing/content/validators.js";
import { phaseRefMatches } from "../master_plan/phasing/intent.js";
import { deriveWeekKeySessions, easyPaceOf, phaseSpansOf } from "../master_plan/v2Snapshot.js";
import { buildStrengthBatchContext, planStrengthWeek, toStrengthSession } from "./strengthSchedule.js";

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
  /**
   * #222 力量偏好：对象=按偏好排力量课（跑课定案后、补休息日前）；null=旧
   * 计划未设置（不排力量，批内首周 coach_notes 提示补选；0 次=显式关闭，
   * 不排不提示）。
   */
  strength: RollingStrengthAvailability | null;
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

/**
 * 首次追赶出课冻结（不含「已有课表」的调整）：删除 date < 明天（asOf+1）的会话
 * ——已过日期排课无意义；文档头部 notes 注明。整周没有未来 run 时**移除该周**
 * （不发布新课），绝不退回未冻结的新文档把过去日期当新课写回。
 *
 * devops#1054：冻结后的文档以最终安排为准——重点课只留还会发布的，周剂量按留下的
 * 跑步课重算；终稿过一遍契约校验——校验不过会抛错，整批按生成失败处理，不发半成品。
 */
export function freezePastSessions(docs: WeeklyPlan[], asOf: string): WeeklyPlan[] {
  const asOfDay = shanghaiDay(asOf);
  const cutoff = addDays(asOfDay, 1);
  return docs.flatMap((doc) => {
    const kept = doc.sessions.filter((session) => session.date >= cutoff);
    if (kept.length === doc.sessions.length) return [doc];
    // 契约要求每周至少一节 run 会话：冻结后无 run（整周已过）时不发布该周。
    if (!kept.some((session) => session.kind === "run")) return [];
    const firstKept = kept[0]!.date;
    const note = `本周已过日期未排课（截至 ${asOfDay}），课表自 ${firstKept} 起生效`;
    const publishedRuns = new Set(kept.filter((session) => session.kind === "run").map((session) => session.date));
    return [
      WeeklyPlanSchema.parse({
        ...doc,
        sessions: kept,
        ...(doc.key_sessions !== undefined
          ? { key_sessions: (doc.key_sessions ?? []).filter((key) => keySessionDay(key) !== null && publishedRuns.has(keySessionDay(key)!)) }
          : {}),
        planned_dose: mergedPlannedDose(
          [],
          kept.filter((session) => session.kind === "run"),
          doc.planned_dose,
        ),
        notes_md: [doc.notes_md, note].filter((text) => text != null).join("；"),
      }),
    ];
  });
}

/** key_session 的日期（派生层同源字段；无法定位日期的条目不能按日合并）。 */
function keySessionDay(key: NonNullable<WeeklyPlan["key_sessions"]>[number]): string | null {
  return key.workout_structure?.date ?? null;
}

/** 营养日期项按日合并：截至今天取旧文档，明天起取新文档，保持 7 天全覆盖。 */
function mergeNutritionDates(oldDoc: WeeklyPlan, newDoc: WeeklyPlan, cutoff: string): WeeklyPlan["nutrition"] {
  const byDate = new Map<string, WeeklyPlan["nutrition"][number]>();
  for (const item of oldDoc.nutrition) if (item.date <= cutoff) byDate.set(item.date, item);
  for (const item of newDoc.nutrition) if (item.date > cutoff) byDate.set(item.date, item);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 重点课按日合并：过去取旧文档、未来取新文档，再按总里程降序截断
 * （非恢复周 ≤3 / 恢复周 ≤1，与 deriveWeekKeySessions 同口径）——避免会话已
 * 保留过去安排、key_sessions 却仍指向被替换的新整周。
 */
function mergeKeySessions(oldDoc: WeeklyPlan, newDoc: WeeklyPlan, cutoff: string): WeeklyPlan["key_sessions"] {
  if (oldDoc.key_sessions === undefined && newDoc.key_sessions === undefined) return undefined;
  const merged = [
    ...(oldDoc.key_sessions ?? []).filter((key) => {
      const day = keySessionDay(key);
      return day !== null && day <= cutoff;
    }),
    ...(newDoc.key_sessions ?? []).filter((key) => {
      const day = keySessionDay(key);
      return day !== null && day > cutoff;
    }),
  ].sort((a, b) => (b.distance_km ?? 0) - (a.distance_km ?? 0));
  return merged.slice(0, newDoc.is_recovery_week === true ? 1 : 3);
}

/** 合并后会话的剂量和（仅用于过去安排确有保留时的周统计，避免指向未冻结的新整周）。 */
function mergedPlannedDose(past: WeeklyPlan["sessions"], future: WeeklyPlan["sessions"], fallback: number | undefined): number | undefined {
  const doses = [...past, ...future].map((session) => session.estimated_dose).filter((dose): dose is number => dose != null);
  return doses.length === 0 ? fallback : r1(doses.reduce((total, dose) => total + dose, 0));
}

/**
 * 调整已有课表的周文档合并（#952）：旧文档截至**今天**（Asia/Shanghai，含今天）
 * 的安排逐字段保留，明天起才用新文档替换——调整不是删除历史，不能把过去已发生
 * 的安排从课表里抹掉。营养日期项与 key_sessions 同步按日合并，周剂量按合并后的
 * 会话重算。以下情况本周不替换（保留原课表，绝不回退成未冻结的新文档）：
 * 历史已结束周、明天起没有任何安排（周日/跨周）、合并后没有任何 run 会话。
 */
export function mergeAdjustedWeekDocs(newDocs: WeeklyPlan[], existingDocs: WeeklyPlan[], asOf: string): WeeklyPlan[] {
  const cutoff = shanghaiDay(asOf);
  const existingByWeek = new Map(existingDocs.map((doc) => [doc.week_name.slice(0, 10), doc]));
  return newDocs.flatMap((doc) => {
    const weekStart = doc.week_name.slice(0, 10);
    const oldDoc = existingByWeek.get(weekStart);
    if (oldDoc === undefined) return [doc];
    if (addDays(weekStart, 6) < cutoff) return [];
    const past = oldDoc.sessions.filter((session) => session.date <= cutoff);
    let future = doc.sessions.filter((session) => session.date > cutoff);
    // #222 调整配额：保留的已过力量课计入本周节数——新文档未来力量课至多保留
    // （新周力量总数 − 已过节数）节，超出部分丢弃（那几天无会话行，读方按缺行处理）。
    const pastStrength = past.filter((session) => session.kind === "strength").length;
    let strengthTrimmed = 0;
    if (pastStrength > 0) {
      const allowFutureStrength = Math.max(0, doc.sessions.filter((session) => session.kind === "strength").length - pastStrength);
      let keptStrength = 0;
      const before = future.length;
      future = future.filter((session) => {
        if (session.kind !== "strength") return true;
        keptStrength += 1;
        return keptStrength <= allowFutureStrength;
      });
      strengthTrimmed = before - future.length;
    }
    // 无法安全替换时保留原周文档（不是回退成新文档）：周日无明日安排、
    // 未来全 rest/力量、合并后无 run、营养日期不全。
    if (future.length === 0) return [oldDoc];
    const sessions = [...past, ...future].sort((a, b) => a.date.localeCompare(b.date) || a.session_index - b.session_index);
    if (!sessions.some((session) => session.kind === "run")) return [oldDoc];
    const nutrition = mergeNutritionDates(oldDoc, doc, cutoff);
    if (nutrition.length !== 7) return [oldDoc];
    const keySessions = mergeKeySessions(oldDoc, doc, cutoff);
    const notes = [
      past.length > 0 && future[0] !== undefined ? `本周已过安排沿用原课表（截至 ${cutoff}），新课自 ${future[0].date} 起生效` : null,
      // 截留说明：新文档 coach_notes 里的力量节数描述的是整周，截留后按实际课表为准。
      strengthTrimmed > 0 ? `力量课按本周剩余配额排入（截至 ${cutoff} 已练 ${pastStrength} 节，截留 ${strengthTrimmed} 节）` : null,
    ].filter((text) => text != null);
    const note = notes.length > 0 ? notes.join("；") : null;
    // 终稿过契约校验（devops#1054：以最终可发布日历为准）——校验不过会抛错，整批按生成失败处理
    return [
      WeeklyPlanSchema.parse({
        ...doc,
        sessions,
        nutrition,
        ...(keySessions !== undefined ? { key_sessions: keySessions } : {}),
        ...(past.length > 0 ? { planned_dose: mergedPlannedDose(past, future, doc.planned_dose) } : {}),
        notes_md: note === null ? doc.notes_md : [doc.notes_md, note].filter((text) => text != null).join("；"),
      }),
    ];
  });
}

/** 主入口：批内每周一个 weekly-plan/v1 文档（含滚动扩展字段），逐周过硬校验。 */
export function buildWeeklyDocs(opts: WeeklyDocsInput): WeeklyPlan[] {
  const { scheduled, batchRows, policy, skeletonNew, skeletonStored, planStartMonday, raceDate, strength } = opts;
  const spans = phaseSpansOf(policy);
  const sessionsOfWeek = new Map(scheduled.weeks.map((week) => [week.week, week.sessions]));
  const easyPace = easyPaceOf(scheduled);
  // #222：批级邻界上下文一次算好（跨周的质量课/长跑前日检查共用；构建廉价，
  // 无论是否排力量都先算，避免空值守卫）。
  const strengthBatch = buildStrengthBatchContext(scheduled, raceDate);
  let legacyStrengthNotified = false;

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
    // #222：力量在跑课定案后、补休息日前排入——禁双练时可能把纯 E 课合法
    // 换日给独立力量日腾位（同周内非周六空日，不动质量课/长跑，周总量不变）。
    let workouts = [...(sessionsOfWeek.get(week) ?? [])].sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
    let strengthSessions: WeeklyPlan["sessions"] = [];
    let strengthNoteSuffix: string | null = null;
    if (strength != null) {
      const outcome = planStrengthWeek({
        prefs: strength,
        weekNumber: week,
        weekStart,
        canonical: skeletonWeek.canonical,
        role: skeletonWeek.role,
        workouts,
        batch: strengthBatch,
        // C9 质量课日集（间隔日带别判定的单源输入）：换日合法性据此保证。
        // 比赛日只在赛周传入——与校验器调用方（generate.ts）同口径。
        qualityWeekdays: c9QualityWeekdays(
          workouts.map((workout) => ({ workout })),
          row.zones,
          skeletonWeek.role === "race" ? raceDate : undefined,
        ),
      });
      if (outcome.relocations.length > 0) {
        const moves = new Map(outcome.relocations.map((relocation) => [relocation.from, relocation.to]));
        workouts = workouts.map((workout) => (moves.has(workout.date) ? { ...workout, date: moves.get(workout.date)! } : workout));
        workouts.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
      }
      strengthSessions = outcome.placements.map((placement) => toStrengthSession(placement, strength));
      strengthNoteSuffix = outcome.note;
    } else if (!legacyStrengthNotified) {
      // 旧计划未设置力量偏好：不排力量，批内首周 coach_notes 提示补选。
      legacyStrengthNotified = true;
      strengthNoteSuffix = "力量偏好未设置：本批次仅排跑步课，可编辑计划补充力量训练偏好";
    }
    const sessions: WeeklyPlan["sessions"] = workouts.map((workout, index) => toRunSession(workout, index, row.zones));
    // 力量 session_index：独立日=0；同日双练=该日跑课最大序号+1（跑步在前）。
    for (const session of strengthSessions) {
      const runIndexesOnDate = sessions.filter((run) => run.date === session.date).map((run) => run.session_index);
      session.session_index = runIndexesOnDate.length > 0 ? Math.max(...runIndexesOnDate) + 1 : 0;
      sessions.push(session);
    }
    const busyDates = new Set(sessions.map((session) => session.date));
    for (let offset = 0; offset < 7; offset += 1) {
      const date = addDays(weekStart, offset);
      if (busyDates.has(date)) continue;
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
      coach_notes: `${span.phase.training_goal}（${span.phase.rationale}）；第 ${week} 周（${skeletonWeek.role}）；出口里程碑：${milestoneNote ?? "无"}${
        strengthNoteSuffix != null ? `；${strengthNoteSuffix}` : ""
      }`,
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
