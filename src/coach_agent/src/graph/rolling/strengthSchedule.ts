/**
 * #222 力量排课（确定性、零 LLM）：在跑课定案之后、补休息日之前给每周排入
 * 结构化力量课。首批 / 滚动续排 / 调整重排共用本模块（入口都在 buildWeeklyDocs），
 * 相同输入产出相同日期/模板/顺序（幂等）。
 *
 * 三层决策：
 * 1. 周频次 = min(用户选择, 阶段/周角色上限)，比赛周与赛后周为 0；目标比赛日
 *    前第 10 天起停排正式力量（按具体日期算，不限周日比赛）。
 * 2. 选日 = 用户力量日 ∩ 可训练日 ∩ 赛前停排窗口外；禁双练时优先独立日，
 *    必要时把该日纯 E 课合法换日（见 planStrengthWeek 内的换日合法性说明）。
 * 3. 模板 = 少量已审核模板（下肢稳定/核心稳定/维持激活；动作名取自
 *    strength_illustrations/exercises.json，T-code 经 COROS 机器目录
 *    src/coros_sync/coros_exercises.json 核对）；专项/恢复期只排维持激活；下肢
 *    负重课避开质量课/长跑前一日、过渡期阈值课后两个日历日内、批末周日（下一批
 *    周一可能排质量课，跨批不可判）——落到第一个不触发这些规则的日期，全部
 *    命中才降为核心模板保节数并记原因。
 *
 * 力量课不进跑量/跑步剂量口径（total_distance_m 恒 null、estimated_dose null），
 * key_sessions 仍只派生自跑课。
 */
import {
  addDays,
  type RollingStrengthAvailability,
  type RunWorkout,
  type StrengthWorkout,
  WEEKDAY_VALUES,
  type Weekday,
  type WeeklyPlan,
} from "@stride/contract";
import { c9IsIntervalDay, weekdayOf } from "../master_plan/phasing/content/validators.js";

/** 阶段力量上限（票面 #222：基础期和早期质量期 2 节，过渡期和专项期 1 节）。 */
const PHASE_STRENGTH_CAP: Record<"recovery" | "foundation" | "early_quality" | "transition_quality" | "final_quality", number> = {
  recovery: 1,
  foundation: 2,
  early_quality: 2,
  transition_quality: 1,
  final_quality: 1,
};

type Canonical = keyof typeof PHASE_STRENGTH_CAP;

const CANONICAL_LABEL: Record<Canonical, string> = {
  recovery: "恢复期",
  foundation: "基础期",
  early_quality: "早期质量期",
  transition_quality: "过渡期",
  final_quality: "专项期",
};

/** 赛前停排窗口：目标比赛日往前数第 10 天起不排正式力量。 */
const PRE_RACE_STRENGTH_CUTOFF_DAYS = 10;

/** 周内位（同校验器 weekdayOf：周一=0…周日=6）；标签下标对齐。 */
const WEEKDAY_LABEL = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"] as const;
const SATURDAY = 5;
const SUNDAY = 6;

const labelOf = (date: string): string => WEEKDAY_LABEL[weekdayOf(date)]!;

/** 批级上下文：跨周邻界检查用的批内关键课日期集（buildWeeklyDocs 一次算好）。 */
export interface StrengthBatchContext {
  /** 批内全部质量课日期（M/T/I/R）。 */
  qualityDates: ReadonlySet<string>;
  /** 批内全部长跑位日期（LR + 比赛日）。 */
  longRunDates: ReadonlySet<string>;
  /** 批内全部阈值课日期（T；过渡期下肢降载规则用）。 */
  thresholdDates: ReadonlySet<string>;
  raceDate: string;
  /** 批内最后一周的周号（批末周日下肢降载——下一批周一可能排质量课，跨批不可判）。 */
  lastWeekOfBatch: number;
}

/** 批产物 → 批级上下文（邻界检查覆盖批内所有周）。 */
export function buildStrengthBatchContext(scheduled: { weeks: Array<{ week: number; sessions: RunWorkout[] }> }, raceDate: string): StrengthBatchContext {
  const qualityDates = new Set<string>();
  const longRunDates = new Set<string>([raceDate]);
  const thresholdDates = new Set<string>();
  for (const week of scheduled.weeks) {
    for (const workout of week.sessions) {
      if (workout.type === "M" || workout.type === "T" || workout.type === "I" || workout.type === "R") {
        qualityDates.add(workout.date);
        if (workout.type === "T") thresholdDates.add(workout.date);
      } else if (workout.type === "LR") {
        longRunDates.add(workout.date);
      }
    }
  }
  return { qualityDates, longRunDates, thresholdDates, raceDate, lastWeekOfBatch: Math.max(...scheduled.weeks.map((week) => week.week)) };
}

export interface StrengthWeekTarget {
  /** 本周目标节数（0=本周不排）。 */
  target: number;
  /** 减量原因（目标被压低时的一句话；正常为 null）。 */
  reason: string | null;
}

/** 周频次决策：用户选择 ∩ 阶段上限 ∩ 周角色 ∩ 赛前/赛后窗口。 */
export function strengthWeeklyTarget(
  prefs: RollingStrengthAvailability,
  week: { weekStart: string; canonical: Canonical; role: string },
  raceDate: string,
): StrengthWeekTarget {
  if (prefs.sessionsPerWeek <= 0) return { target: 0, reason: null };
  if (week.role === "race") return { target: 0, reason: "比赛周不排正式力量" };
  if (week.weekStart > raceDate) return { target: 0, reason: "赛后恢复周不排力量" };
  const cutoff = addDays(raceDate, -PRE_RACE_STRENGTH_CUTOFF_DAYS);
  if (week.weekStart >= cutoff) return { target: 0, reason: `赛前${PRE_RACE_STRENGTH_CUTOFF_DAYS}天起停排正式力量` };
  const cap = PHASE_STRENGTH_CAP[week.canonical];
  const roleCapped = week.role === "absorb" || week.role === "taper" ? Math.min(cap, 1) : cap;
  const target = Math.min(prefs.sessionsPerWeek, roleCapped);
  if (target === prefs.sessionsPerWeek) return { target, reason: null };
  const label = week.role === "absorb" ? "吸收周" : week.role === "taper" ? "减量周" : CANONICAL_LABEL[week.canonical];
  return { target, reason: `${label}力量减量：每周至多 ${roleCapped} 节` };
}

/** 阶段力量目标（v2 快照 phases[].strength.sessions_per_week 用：用户选择 ∩ 阶段上限）。 */
export function phaseStrengthTarget(sessionsPerWeek: number, canonical: Canonical): number {
  return Math.min(sessionsPerWeek, PHASE_STRENGTH_CAP[canonical]);
}

// ── 力量模板（已审核少量模板；动作与 T-code 对应 strength_illustrations/exercises.json）──

interface ExerciseSpec {
  canonical_id: string;
  display_name: string;
  sets: number;
  target_kind: "reps" | "time_s";
  target_value: number;
  rest_seconds: number;
  note: string | null;
  provider_id: string | null;
}

type TemplateId = "lower_body" | "core" | "light";

interface StrengthTemplate {
  name: string;
  /** 下肢负重类（受邻界规则约束，见 lowerBodyDowngrade）。 */
  lowerBody: boolean;
  note: string;
  exercises: ExerciseSpec[];
}

function exercise(displayName: string, tCode: string, sets: number, reps: number, restSeconds: number, note: string | null): ExerciseSpec {
  return {
    canonical_id: tCode,
    display_name: displayName,
    sets,
    target_kind: "reps",
    target_value: reps,
    rest_seconds: restSeconds,
    note,
    provider_id: tCode,
  };
}

function timed(displayName: string, tCode: string, sets: number, seconds: number, restSeconds: number, note: string | null): ExerciseSpec {
  return {
    canonical_id: tCode,
    display_name: displayName,
    sets,
    target_kind: "time_s",
    target_value: seconds,
    rest_seconds: restSeconds,
    note,
    provider_id: tCode,
  };
}

const TEMPLATES: Record<TemplateId, StrengthTemplate> = {
  lower_body: {
    name: "力量·下肢稳定",
    lowerBody: true,
    note: "先做 5-10 分钟动态热身。马拉松下肢稳定课：单侧动作左右两侧都做；与跑步同日时安排在跑后",
    exercises: [
      exercise("保加利亚分腿蹲", "T1164", 3, 8, 60, "每侧；膝盖对齐脚尖，控速下蹲"),
      exercise("单腿硬拉抬膝", "T1144", 3, 8, 60, "每侧；髋部铰链，背部平直"),
      exercise("单腿臀桥保持", "T1219", 3, 12, 45, "每侧；顶端停 2 秒"),
      exercise("站立侧抬腿", "T1116", 3, 15, 30, "每侧；臀中肌发力，躯干不晃"),
      exercise("站立提踵", "T1070", 3, 15, 45, "全程控制，顶端停顿"),
      timed("平板支撑", "T1010", 3, 45, 45, "身体成一条直线，不塌腰"),
    ],
  },
  core: {
    name: "力量·核心稳定",
    lowerBody: false,
    note: "先做 5 分钟动态热身。核心稳定课：动作质量优先于次数；与跑步同日时安排在跑后",
    exercises: [
      exercise("死虫式", "T1243", 3, 10, 30, "每侧；对侧手脚延展，腰部贴地"),
      exercise("鸟狗平衡", "T1249", 3, 10, 30, "每侧；躯干稳定不晃动"),
      timed("侧平板", "T1185", 3, 30, 30, "每侧；髋部抬起成直线"),
      exercise("平板支撑摸肩", "T1183", 3, 12, 30, "交替抬手摸对侧肩，骨盆不移"),
      exercise("仰卧臀桥", "T1132", 3, 15, 30, "顶端挤压臀肌 2 秒"),
    ],
  },
  light: {
    name: "力量·维持激活",
    lowerBody: false,
    note: "先做 5 分钟动态热身。低负荷维持课（减量/赛前阶段）：自感轻松，不加重不力竭",
    exercises: [
      timed("平板支撑", "T1010", 2, 40, 40, null),
      timed("侧平板", "T1185", 2, 25, 30, "每侧"),
      exercise("站立侧抬腿", "T1116", 2, 15, 30, "每侧"),
      exercise("站立提踵", "T1070", 2, 15, 30, null),
      exercise("鸟狗平衡", "T1249", 2, 8, 30, "每侧"),
    ],
  },
};

/** 动作时长粗估（秒）：次数按 3 秒/次计，组间休息全额计入（保守估计）。 */
function estimateDurationS(exercises: ExerciseSpec[]): number {
  return exercises.reduce(
    (total, ex) => total + ex.sets * (ex.target_kind === "time_s" ? ex.target_value : ex.target_value * 3) + ex.sets * ex.rest_seconds,
    0,
  );
}

/**
 * 本周是否排一节下肢负重课（确定性）：基础/早期质量/过渡期——两节=下肢+核心、
 * 单节按周奇偶；专项/恢复期不排（只给维持激活——阶段策略原文：力量减量维持
 * 神经激活 / 维持性核心）。
 */
function wantsLowerBody(weekNumber: number, canonical: Canonical, count: number): boolean {
  if (canonical === "final_quality" || canonical === "recovery") return false;
  return count >= 2 || weekNumber % 2 === 1;
}

// ── 选日与出课 ────────────────────────────────────────────────────────────────

function weekdayDatesOfWeek(weekStart: string, weekdays: ReadonlyArray<Weekday>): string[] {
  const wanted = new Set(weekdays.map((name) => WEEKDAY_VALUES.indexOf(name)));
  const dates: string[] = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const date = addDays(weekStart, offset);
    if (wanted.has(weekdayOf(date))) dates.push(date);
  }
  return dates;
}

function weekdayNameOf(date: string): Weekday {
  return WEEKDAY_VALUES[weekdayOf(date)]!;
}

export interface StrengthPlacement {
  date: string;
  templateId: TemplateId;
  /** 同日有跑课（双练，跑步在前）。 */
  stacked: boolean;
}

export interface StrengthWeekOutcome {
  /** 本周排课说明（含少排/降载原因；正常为 null）。 */
  note: string | null;
  placements: StrengthPlacement[];
  /** E 课换日（date → newDate；禁双练时给独立力量日腾位，同周内合法窗口）。 */
  relocations: Array<{ from: string; to: string }>;
}

/**
 * 下肢负重课的降载判定：返回降载原因（null=可排下肢）。四条规则命中其一即不排
 * 下肢（见调用处：让给其它日期，全部命中才降为核心模板保节数）。
 */
function lowerBodyDowngrade(args: {
  date: string;
  /** 双练：当天有跑课，力量叠在跑后。 */
  stacked: boolean;
  canonical: Canonical;
  batch: StrengthBatchContext;
  batchFinalWeek: boolean;
}): string | null {
  const { date, stacked, canonical, batch, batchFinalWeek } = args;
  // 与长跑/质量课同日双练：跑后已疲劳，不再压下肢（票面「力量可排在合适的跑课之后」）。
  if (stacked && (batch.longRunDates.has(date) || batch.qualityDates.has(date))) return `${labelOf(date)}与长跑/质量课同日双练，下肢课降为核心`;
  const next = addDays(date, 1);
  if (batch.qualityDates.has(next) || batch.longRunDates.has(next)) return `${labelOf(date)}次日是质量课/长跑，下肢课降为核心`;
  // 过渡期「T 课后 48h 内不练腿」（阶段策略原文）：阈值课后两个日历日内避开下肢。
  if (canonical === "transition_quality" && (batch.thresholdDates.has(addDays(date, -1)) || batch.thresholdDates.has(addDays(date, -2)))) {
    return `${labelOf(date)}在阈值课后两个日历日内，下肢课降为核心`;
  }
  if (batchFinalWeek && weekdayOf(date) === SUNDAY) return `${labelOf(date)}为批末周日（次日质量课跨批不可判），下肢课降为核心`;
  return null;
}

/**
 * 单周力量排课决策（纯函数）：不改入参——换日/出课由调用方应用。
 * 候选日 = 用户力量日（归一周内顺序）；逐日判定：停排窗口/不可用日拒绝，
 * 无跑课直接排，有跑课按双练许可或 E 换日，都不可行则少排并记原因。
 *
 * E 换日合法性（票面「在跑课现有合法窗口内调整轻松跑，并复用原排课校验」）：
 * 只挪纯 E 课、整日互斥地挪到同周空日，训练日数/质量课邻接/周量/单课处方
 * 全不变，唯一按日位判 E 的校验是 C9 时长带（间隔日 30-60min / 普通日
 * 60-90min；taper·再生周全短带是周级常量）。因此只允许换到 **C9 带别与源日
 * 相同** 的日子（间隔日判定复用校验器单源 c9IsIntervalDay）——源日 E 已过
 * C9，带别相同的目标日必然也过。周六两头都排除（P3 长跑前日轻量位，且 C9
 * 对该日豁免时长带改判日合计里程，换入换出都会破坏）。不可用日不作目标。
 */
export function planStrengthWeek(args: {
  prefs: RollingStrengthAvailability;
  weekNumber: number;
  weekStart: string;
  canonical: Canonical;
  role: string;
  workouts: RunWorkout[];
  batch: StrengthBatchContext;
  /** 本周 C9 质量课日集（周内位；校验器 c9QualityWeekdays 产物）。 */
  qualityWeekdays: ReadonlySet<number>;
}): StrengthWeekOutcome {
  const { prefs, weekNumber, weekStart, canonical, role, workouts, batch, qualityWeekdays } = args;
  const targetInfo = strengthWeeklyTarget(prefs, { weekStart, canonical, role }, batch.raceDate);
  if (targetInfo.target === 0) {
    return {
      note: targetInfo.reason != null ? `力量 0/${prefs.sessionsPerWeek} 节（${targetInfo.reason}）` : null,
      placements: [],
      relocations: [],
    };
  }

  const cutoff = addDays(batch.raceDate, -PRE_RACE_STRENGTH_CUTOFF_DAYS);
  const unavailableDates = new Set(weekdayDatesOfWeek(weekStart, prefs.unavailableDays));
  const runsByDate = new Map<string, RunWorkout[]>();
  for (const workout of workouts) {
    const list = runsByDate.get(workout.date) ?? [];
    list.push(workout);
    runsByDate.set(workout.date, list);
  }
  // 候选日按周内顺序归一（用户提交顺序不保证；同输入同输出）。
  const candidates = weekdayDatesOfWeek(weekStart, prefs.availableDays);
  const strengthDayWeekdays = new Set<Weekday>(prefs.availableDays);

  const slots: Array<{ date: string; stacked: boolean }> = [];
  const relocations: Array<{ from: string; to: string }> = [];
  const reduceReasons: string[] = [];
  if (targetInfo.reason != null) reduceReasons.push(targetInfo.reason);

  for (const date of candidates) {
    if (slots.length >= targetInfo.target) break;
    if (date >= cutoff) {
      reduceReasons.push(`${labelOf(date)}进入赛前${PRE_RACE_STRENGTH_CUTOFF_DAYS}天停排窗口`);
      continue;
    }
    if (unavailableDates.has(date)) {
      reduceReasons.push(`${labelOf(date)}不可训练`);
      continue;
    }
    const runsHere = runsByDate.get(date) ?? [];
    if (runsHere.length === 0) {
      slots.push({ date, stacked: false });
      continue;
    }
    if (prefs.allowsDoubleSessions) {
      slots.push({ date, stacked: true });
      continue;
    }
    const isSaturday = weekdayOf(date) === SATURDAY;
    const sourceIntervalDay = c9IsIntervalDay(qualityWeekdays, weekdayOf(date));
    const relocateTo =
      !isSaturday && runsHere.every((workout) => workout.type === "E")
        ? findRelocationTarget(
            weekStart,
            runsByDate,
            unavailableDates,
            strengthDayWeekdays,
            date,
            (target) => weekdayOf(target) !== SATURDAY && c9IsIntervalDay(qualityWeekdays, weekdayOf(target)) === sourceIntervalDay,
          )
        : null;
    if (relocateTo !== null) {
      relocations.push({ from: date, to: relocateTo });
      runsByDate.set(relocateTo, [...(runsByDate.get(relocateTo) ?? []), ...runsHere]);
      runsByDate.delete(date);
      slots.push({ date, stacked: false });
    } else {
      reduceReasons.push(`${labelOf(date)}被跑课占用且无法换日`);
    }
  }

  // 模板指派 + 邻界降载：专项/恢复期全维持激活；其余阶段本周应有一节下肢负重课，
  // 落到**第一个不触发降载规则的日期**（两节时另一节为核心）——先到的那天排不了
  // 就让给后面能排的那天，保住「核心+下肢打底」。所有日期都降载才改核心并记原因。
  const maintenanceOnly = canonical === "final_quality" || canonical === "recovery";
  const lowerBodyWanted = wantsLowerBody(weekNumber, canonical, slots.length);
  const batchFinalWeek = weekNumber === batch.lastWeekOfBatch;
  const downgrades = lowerBodyWanted ? slots.map((slot) => lowerBodyDowngrade({ ...slot, canonical, batch, batchFinalWeek })) : [];
  const lowerBodyIndex = downgrades.findIndex((reason) => reason === null);
  if (lowerBodyWanted && lowerBodyIndex === -1) reduceReasons.push(...downgrades.filter((reason): reason is string => reason !== null));
  const placements = slots.map((slot, index) => ({
    ...slot,
    templateId: maintenanceOnly ? ("light" as const) : index === lowerBodyIndex ? ("lower_body" as const) : ("core" as const),
  }));

  const note =
    placements.length === prefs.sessionsPerWeek && reduceReasons.length === 0
      ? null
      : `力量 ${placements.length}/${prefs.sessionsPerWeek} 节${reduceReasons.length > 0 ? `（${[...new Set(reduceReasons)].join("；")}）` : ""}`;
  return { note, placements, relocations };
}

/** E 换日目标：同周内无跑课、非不可用日、非力量候选日，且满足调用方给的合法性判定。 */
function findRelocationTarget(
  weekStart: string,
  runsByDate: Map<string, RunWorkout[]>,
  unavailableDates: Set<string>,
  strengthDayWeekdays: Set<Weekday>,
  from: string,
  accepts: (date: string) => boolean,
): string | null {
  for (let offset = 0; offset < 7; offset += 1) {
    const date = addDays(weekStart, offset);
    if (date === from) continue;
    if ((runsByDate.get(date) ?? []).length > 0) continue;
    if (unavailableDates.has(date)) continue;
    if (strengthDayWeekdays.has(weekdayNameOf(date))) continue;
    if (!accepts(date)) continue;
    return date;
  }
  return null;
}

/** 力量会话（plan-session/v1 kind=strength + 完整 strength-workout/v1 spec；session_index 由调用方回填）。 */
export function toStrengthSession(placement: StrengthPlacement, prefs: RollingStrengthAvailability): WeeklyPlan["sessions"][number] {
  const template = TEMPLATES[placement.templateId];
  const exercises: ExerciseSpec[] = [...template.exercises];
  const spec: StrengthWorkout = {
    schema: "strength-workout/v1",
    name: template.name,
    date: placement.date,
    note: template.note,
    exercises,
  };
  return {
    schema: "plan-session/v1",
    date: placement.date,
    session_index: 0,
    kind: "strength",
    summary: template.name,
    notes_md: placement.stacked ? "同日双练：跑步在前，力量安排在跑后" : null,
    total_distance_m: null,
    total_duration_s: estimateDurationS(exercises),
    estimated_dose: null,
    spec,
  };
}
