import { addDays, type WeeklyPlan, WeeklyPlanSchema, weekFolder } from "@stride/contract";

/**
 * #858 PR-D 伤病维持课构造（纯函数、确定性、零 LLM）：减量模式（mode=reduced）
 * 下每周出一张「维持周」文档——E 有氧为主、量=maintenance_km（重估带内）、
 * 去质量课、力量保留、rest 补齐。伤病期不推强度：会话 spec=null、summary 只给
 * E 心率/体感口径，不给具体配速带。
 *
 * coach_notes 前缀「伤病维持期」是可复现判据（isMaintenanceWeeklyDoc）——夜检
 * 与 worker 用它判定「本周维持行已存在」（不重复 enqueue / 目标周顺延）。
 */

/** 维持周标记前缀（夜检/worker 判「本周已有维持行」的单源判据）。 */
export const MAINTENANCE_COACH_NOTE_PREFIX = "伤病维持期";

/** E 会话配速口径提示（心率/体感，不给配速带——伤病期不推强度）。 */
const E_PACE_CUE = "轻松体感/E 心率区，不追配速";

/** E 跑估时兜底口径（s/km）：伤病期无配速带，时长=km×330s 粗估，注释即契约。 */
const E_PACE_S_PER_KM_FALLBACK = 330;

/** 力量会话标准时长（40 分钟保持性会话，伤病期不加重）。 */
const STRENGTH_DURATION_S = 40 * 60;

/** 长跑上限（km）与长跑占周量比例上限（25%）。 */
const LONG_RUN_KM_CAP = 14;
const LONG_RUN_VOLUME_RATIO = 0.25;

export interface MaintenanceInput {
  /** 第 1 周周一（YYYY-MM-DD，master content.start_date 同值）——week_index 基准。 */
  planStartMonday: string;
  /** 维持周周一（YYYY-MM-DD）。 */
  weekStart: string;
  /** 每周最多跑步天数（availability.weekly_run_days_max）。 */
  weeklyRunDaysMax: number;
  /** 维持周量（km，重估带内值——Go plan_injury_state.maintenance_km 单值锚）。 */
  maintenanceKm: number;
  /** 每周力量会话数（力量保留）。 */
  strengthPerWeek: number;
  /** 阶段目标附注（可缺省——有则拼进 coach_notes 给教练上下文）。 */
  phaseGoalNote?: string;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/** 跑日分布：runDays 天均匀铺满周一..周日，最后一天（周日）固定为长跑日。 */
function runDayOffsets(runDays: number): number[] {
  if (runDays === 1) return [6];
  return Array.from({ length: runDays }, (_, i) => Math.round((i * 6) / (runDays - 1)));
}

/**
 * 维持周分布：长跑 1 天 ≤min(14, 25% 周量)，其余 E 均分（尾差收口到最后一节
 * E，保证总量精确=maintenanceKm）。runDays=1 时唯一跑日承载全量（长跑上限
 * 不适用——没有其他天可分）。
 */
function distributeRunKm(maintenanceKm: number, runDays: number): { longRunKm: number; easyKms: number[] } {
  if (runDays === 1) return { longRunKm: r1(maintenanceKm), easyKms: [] };
  const longRunKm = r1(Math.min(LONG_RUN_KM_CAP, maintenanceKm * LONG_RUN_VOLUME_RATIO));
  const easyTotal = maintenanceKm - longRunKm;
  const per = easyTotal / (runDays - 1);
  const easyKms = Array.from({ length: runDays - 1 }, () => r1(per));
  // 尾差收口：均分取整残差全部落在最后一节 E（确定性）。
  const residue = r1(easyTotal - easyKms.reduce((total, km) => total + km, 0));
  easyKms[easyKms.length - 1] = r1(easyKms[easyKms.length - 1]! + residue);
  return { longRunKm, easyKms };
}

function runSession(date: string, km: number, summary: string, notes: string | null): WeeklyPlan["sessions"][number] {
  return {
    schema: "plan-session/v1",
    date,
    session_index: 0,
    kind: "run",
    summary,
    notes_md: notes,
    // 估距=计划量本身；估时=km×330s/km 兜底口径（伤病期无配速带可推）。
    total_distance_m: Math.round(km * 1000),
    total_duration_s: Math.round(km * E_PACE_S_PER_KM_FALLBACK),
    estimated_dose: null,
    spec: null,
  };
}

function strengthSession(date: string, sessionIndex: number): WeeklyPlan["sessions"][number] {
  return {
    schema: "plan-session/v1",
    date,
    session_index: sessionIndex,
    kind: "strength",
    summary: "力量保持（核心/下肢稳定，自感中等强度）",
    notes_md: "伤病维持期力量保留：不加重、不冲刺跳跃类动作",
    total_distance_m: null,
    total_duration_s: STRENGTH_DURATION_S,
    estimated_dose: null,
    spec: null,
  };
}

function restSession(date: string): WeeklyPlan["sessions"][number] {
  return {
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
  };
}

/** 空营养骨架（契约 length=7 必填；维持层不生成营养——同 buildWeeklyDocs 口径）。 */
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

/** 周文档是否为伤病维持周（coach_notes 含「伤病维持期」标记——可复现判据）。 */
export function isMaintenanceWeeklyDoc(doc: Pick<WeeklyPlan, "coach_notes">): boolean {
  return (doc.coach_notes ?? "").includes(MAINTENANCE_COACH_NOTE_PREFIX);
}

/**
 * 主入口：确定性构造一张维持周文档（weekly-plan/v1，过硬校验后返回）。
 * 输出周文档带滚动扩展字段：week_index（按 planStartMonday 推算）、
 * phase_name="maintenance"（特殊标记——纯函数查不到当周 v2 阶段名，schema 可选
 * 字段以特殊值表达「维持期」）、target_weekly_km_low/high=maintenanceKm。
 */
export function buildMaintenanceWeek(input: MaintenanceInput): WeeklyPlan {
  const { planStartMonday, weekStart, maintenanceKm, strengthPerWeek, phaseGoalNote } = input;
  if (maintenanceKm <= 0) throw new Error("buildMaintenanceWeek: maintenanceKm 须为正数");
  if (mondayMismatch(weekStart)) throw new Error("buildMaintenanceWeek: weekStart 须为周一");
  const runDays = Math.max(1, Math.min(7, Math.floor(input.weeklyRunDaysMax)));
  // 力量天数钳到 7：每天至多一节（避免同日同 session_index 碰撞，schema 会拒）。
  const strengthDays = Math.max(0, Math.min(7, Math.floor(strengthPerWeek)));

  const weekIndex = Math.floor((Date.parse(`${weekStart}T00:00:00Z`) - Date.parse(`${planStartMonday}T00:00:00Z`)) / (7 * 86_400_000)) + 1;
  if (weekIndex < 1) throw new Error("buildMaintenanceWeek: weekStart 早于 planStartMonday");

  const { longRunKm, easyKms } = distributeRunKm(maintenanceKm, runDays);
  const offsets = runDayOffsets(runDays);

  const sessions: WeeklyPlan["sessions"] = [];
  // 跑日：offsets 最后一位=长跑日；其余 E（首节 E 带 strides 备注——每周 1 次）。
  for (let i = 0; i < runDays; i += 1) {
    const date = addDays(weekStart, offsets[i]!);
    if (i === runDays - 1 && runDays > 1) {
      sessions.push(runSession(date, longRunKm, `E 有氧长跑 ${longRunKm} 公里（${E_PACE_CUE}）`, null));
    } else {
      const km = runDays > 1 ? easyKms[i]! : longRunKm;
      const stridesNote = i === 0 ? "跑后 strides 4×20 秒快步跑（不冲强度）" : null;
      sessions.push(runSession(date, km, `E 有氧跑 ${km} 公里（${E_PACE_CUE}）`, stridesNote));
    }
  }

  // 力量保留：优先落在无跑日（升序取），不够时叠到跑日（session_index 递增）。
  const runDates = new Set(sessions.map((session) => session.date));
  const freeDays: string[] = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const date = addDays(weekStart, offset);
    if (!runDates.has(date)) freeDays.push(date);
  }
  const strengthPlan = Array.from({ length: strengthDays }, (_, i) =>
    i < freeDays.length ? { date: freeDays[i]!, index: 0 } : { date: [...runDates][i - freeDays.length]!, index: 1 },
  );
  for (const slot of strengthPlan) sessions.push(strengthSession(slot.date, slot.index));

  // rest 补齐（周计划表达「这天不跑」而不是缺行）。
  const busyDays = new Map(sessions.map((session) => [session.date, true]));
  for (let offset = 0; offset < 7; offset += 1) {
    const date = addDays(weekStart, offset);
    if (!busyDays.has(date)) sessions.push(restSession(date));
  }
  sessions.sort((a, b) => a.date.localeCompare(b.date) || a.session_index - b.session_index);

  const coachNotes = [`${MAINTENANCE_COACH_NOTE_PREFIX}（E 有氧为主，去质量课；恢复跟踪中，量随恢复回抬）`, phaseGoalNote]
    .filter((text) => text != null && text.length > 0)
    .join("；");

  return WeeklyPlanSchema.parse({
    schema: "weekly-plan/v1",
    week_name: weekFolder(weekStart),
    sessions,
    nutrition: emptyNutrition(weekStart),
    notes_md: null,
    coach_notes: coachNotes,
    week_index: weekIndex,
    phase_name: "maintenance",
    target_weekly_km_low: r1(maintenanceKm),
    target_weekly_km_high: r1(maintenanceKm),
    key_sessions: [],
  });
}

function mondayMismatch(day: string): boolean {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return Number.isNaN(weekday) || weekday !== 1;
}
