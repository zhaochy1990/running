import { z } from "zod/v4";
import { isRunningActivity, normalizeSessionClass } from "../../../data/activityClassification.js";
import type { ContextSnapshot } from "../context.js";

/**
 * 阶段划分证据层（devops#782，daniels.md §2.1）：纯函数、无存储。
 *
 * 输入=ContextSnapshot（master plan 现有快照，走 DataProvider）+ 活动行
 * （session_class 消费 #745 双值归一）+ as_of；输出=判断层 payload 的 evidence
 * 段。不输入：单课明细/laps、PMC 仿真、聊天上下文（daniels.md §2.1 明确排除）。
 */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const MonthlyFocusSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  km: z.number().nonnegative(),
  /** 月均周量化（按实际跑步天数折算，非整月摊平）。 */
  weekly_km: z.number().nonnegative(),
  run_days: z.number().int().nonnegative(),
  e_share_pct: z.number().min(0).max(100),
  quality_sessions: z.number().int().nonnegative(),
  long_quality_sessions: z.number().int().nonnegative(),
  strides_sessions: z.number().int().nonnegative(),
  longest_run_km: z.number().nonnegative(),
  race_like: z.array(z.object({ date: day, name: z.string(), km: z.number().nonnegative() })),
});
export type MonthlyFocus = z.infer<typeof MonthlyFocusSchema>;

export const PhaseEvidenceSchema = z.object({
  as_of: day,
  target: z.object({ race: z.string(), target_time: z.string(), goal_pace: z.string() }),
  personal_bests: z.record(z.string(), z.string()),
  fitness: z.object({ ctl: z.number(), atl: z.number(), form: z.number() }),
  availability: z.object({ weekly_run_days_max: z.number().int().min(1).max(7) }),
  recent_volume: z.object({
    avg_8wk_km: z.number().nonnegative(),
    avg_4wk_km: z.number().nonnegative(),
    recent_peak_week_km: z.number().nonnegative(),
    longest_run_8wk_km: z.number().nonnegative(),
    gap_weeks_last16: z.number().int().nonnegative(),
  }),
  monthly_focus: z.array(MonthlyFocusSchema),
  phase_credit: z.object({
    sustained_volume_months_ge40wk: z.number().int().nonnegative(),
    e_share_months_ge85: z.number().int().nonnegative(),
    months_with_long_run_ge25: z.number().int().nonnegative(),
    months_with_ge4_quality: z.number().int().nonnegative(),
    /** 窗口起点 = as_of 往前 6 个整月（2026-10 → 2026-04；字段名保留 spike/prompt 既有引用）。 */
    marathons_since_april: z.number().int().nonnegative(),
  }),
  last_race: z.object({ date: day, distance_km: z.number(), days_ago: z.number().int() }).nullable(),
  injuries: z.array(z.object({ body_area: z.string(), status: z.string(), note: z.string().optional() })),
  /** 从 injuries + 断练期推导；null = 无在册伤退。 */
  injury_return: z.object({ pre_injury_peak_week_km: z.number().positive(), weeks_out: z.number().int().min(1) }).nullable(),
  evidence_note: z.string(),
});
export type PhaseEvidence = z.infer<typeof PhaseEvidenceSchema>;

export interface PhasingGoalInput {
  raceName: string;
  /** 判断层教义目前只验证过 FM（daniels.md/spike 全量 FM）；HM 需连同教义一起另立。 */
  distance: "FM";
  targetTime: string;
  weeklyRunDaysMax: number;
}

/** 证据层消费的活动投影：DataProvider.Activity 的结构子集（测试 fixture 直接满足）。 */
export interface PhasingActivityInput {
  date: Date | string;
  name: string | null;
  sport?: string | null;
  sportName?: string | null;
  distanceM: number | null;
  strideSessionClass: string | null;
}

const RACE_DISTANCE_KM = 42.195;

const parseHms = (s: string) => {
  const [h = 0, m = 0, sec = 0] = s.split(":").map(Number);
  return h * 3600 + m * 60 + sec;
};
const fmtPace = (sPerKm: number) => `${Math.floor(sPerKm / 60)}:${String(Math.floor(sPerKm % 60)).padStart(2, "0")}`;
const r1 = (x: number) => Math.round(x * 10) / 10;

/** as_of 当月往前 count 个整月，返回 YYYY-MM（窗口起点含该月）。 */
function monthsBack(asOf: string, count: number): string {
  const [yRaw, mRaw] = asOf.split("-");
  const total = (Number(yRaw) || 0) * 12 + ((Number(mRaw) || 1) - 1) - count;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

/** 训练日归属用 UTC+8（与 masterPlanContextProvider 的 activityDay 同口径，中国跑者时区）。 */
const dayOf = (date: Date | string) => new Date(new Date(date).getTime() + 8 * 3600_000).toISOString().slice(0, 10);

/** 跑步行判定：有厂商 sport 信息走 isRunningActivity（骑行等不入画像），无则退回 >2km 距离阈值。 */
const isRun = (a: PhasingActivityInput) =>
  a.sport != null || a.sportName != null
    ? isRunningActivity({ name: a.name, sport: a.sport ?? null, sportName: a.sportName ?? null, sportNote: null, strideSessionClass: a.strideSessionClass })
    : (a.distanceM ?? 0) > 2000;
/** session_class 口径：easy/long_easy=E 类有氧（归一后），quality/long_quality=质量课。 */
const isE = (cls: string | null) => cls === "easy" || cls === "long_easy";
const isQ = (cls: string | null) => cls === "quality" || cls === "long_quality";

/**
 * 推导伤退回归（I8 伤后带、T 兜底伤退调整的输入）：
 * 在册 injury 状态以 active 开头（生产拼接串形如 "active; restriction=..."，
 * "recovered; ..." 是已痊愈的历史伤、不触发），或近 12 周内结束的 ≥21 天断练期 →
 * 伤停前 8 周峰值周量为 pre_injury_peak_week_km（休假级短断练不算伤退）。
 */
function deriveInjuryReturn(snapshot: ContextSnapshot, asOf: string): PhaseEvidence["injury_return"] {
  const weeks = snapshot.recent_history.weeks.filter((w) => w.week_start < asOf);
  const activeInjury = snapshot.injuries.some((i) => /^active/i.test(i.status));
  const recentGap = snapshot.macro_history.gap_periods
    .filter((g) => g.days >= 21)
    .sort((a, b) => b.end_date.localeCompare(a.end_date))
    .find((g) => {
      const daysSince = Math.round((new Date(asOf).getTime() - new Date(g.end_date).getTime()) / 86400_000);
      return daysSince >= 0 && daysSince <= 84;
    });
  if (!activeInjury && !recentGap) return null;
  const gapStart = recentGap?.start_date ?? null;
  const preWeeks = gapStart ? weeks.filter((w) => w.week_start < gapStart).slice(-8) : weeks.slice(0, Math.max(1, Math.floor(weeks.length / 2)));
  const prePeak = Math.max(0, ...preWeeks.map((w) => w.distance_km));
  if (prePeak <= 0) return null;
  return {
    pre_injury_peak_week_km: Math.round(prePeak),
    weeks_out: recentGap ? Math.max(1, Math.round(recentGap.days / 7)) : 1,
  };
}

/** 证据层生成入口（纯函数）：snapshot + 活动行 + 目标 → 判断层 evidence。 */
export function buildPhaseEvidence(snapshot: ContextSnapshot, activities: PhasingActivityInput[], goal: PhasingGoalInput, asOf: string): PhaseEvidence {
  const asOfDay = asOf.slice(0, 10);
  const weeks = snapshot.recent_history.weeks.filter((w) => w.week_start < asOfDay);
  const last8 = weeks.slice(-8);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  const windowStart = monthsBack(asOfDay, 6);
  const byMonth = new Map<string, PhasingActivityInput[]>();
  for (const a of activities.filter(isRun)) {
    const month = dayOf(a.date).slice(0, 7);
    if (month < windowStart || month > asOfDay.slice(0, 7)) continue;
    byMonth.set(month, [...(byMonth.get(month) ?? []), a]);
  }
  const monthly_focus = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, list]) => {
      const km = list.reduce((s, a) => s + (a.distanceM ?? 0), 0) / 1000;
      const days = new Set(list.map((a) => dayOf(a.date)));
      const cls = (a: PhasingActivityInput) => normalizeSessionClass(a.strideSessionClass);
      const eKm = list.filter((a) => isE(cls(a))).reduce((s, a) => s + (a.distanceM ?? 0), 0) / 1000;
      const qS = list.filter((a) => isQ(cls(a)));
      const longs = list.filter((a) => cls(a) === "long_easy" || cls(a) === "long_quality");
      const races = list.filter((a) => cls(a) === "race" && (a.distanceM ?? 0) >= 10000);
      return {
        month,
        km: Math.round(km),
        weekly_km: Math.round((km / (days.size || 1)) * 7),
        run_days: days.size,
        e_share_pct: km > 0 ? Math.round((eKm / km) * 100) : 0,
        quality_sessions: qS.length,
        long_quality_sessions: list.filter((a) => cls(a) === "long_quality").length,
        strides_sessions: list.filter((a) => cls(a) === "strides").length,
        longest_run_km: longs.length ? r1(Math.max(...longs.map((a) => (a.distanceM ?? 0) / 1000))) : 0,
        race_like: races.map((a) => ({
          date: dayOf(a.date),
          name: (a.name ?? "").slice(0, 30),
          km: Math.round((a.distanceM ?? 0) / 1000),
        })),
      };
    });

  const lastRace = snapshot.race_history[0] ?? null;
  const pbs: Record<string, string> = {};
  for (const pb of snapshot.personal_bests) pbs[pb.distance] = `${Math.floor(pb.time_sec / 60)}:${String(Math.round(pb.time_sec % 60)).padStart(2, "0")}`;
  const goalPaceSPerKm = parseHms(goal.targetTime) / RACE_DISTANCE_KM;

  return PhaseEvidenceSchema.parse({
    as_of: asOfDay,
    target: {
      race: `全程马拉松 ${goal.raceName}`,
      target_time: goal.targetTime,
      goal_pace: `${fmtPace(goalPaceSPerKm)}/km`,
    },
    personal_bests: pbs,
    fitness: {
      ctl: Math.round(snapshot.fitness_state.ctl ?? 0),
      atl: Math.round(snapshot.fitness_state.atl ?? 0),
      form: Math.round(snapshot.fitness_state.form ?? 0),
    },
    availability: { weekly_run_days_max: goal.weeklyRunDaysMax },
    recent_volume: {
      avg_8wk_km: r1(avg(last8.map((w) => w.distance_km))),
      avg_4wk_km: r1(avg(last8.slice(-4).map((w) => w.distance_km))),
      recent_peak_week_km: Math.round(Math.max(0, ...last8.map((w) => w.distance_km))),
      longest_run_8wk_km: r1(Math.max(0, ...last8.map((w) => w.long_run_km ?? 0))),
      gap_weeks_last16: weeks.slice(-16).filter((w) => w.distance_km < 5).length,
    },
    monthly_focus,
    phase_credit: {
      sustained_volume_months_ge40wk: monthly_focus.filter((m) => m.weekly_km >= 40).length,
      e_share_months_ge85: monthly_focus.filter((m) => m.e_share_pct >= 85).length,
      months_with_long_run_ge25: monthly_focus.filter((m) => m.longest_run_km >= 25).length,
      months_with_ge4_quality: monthly_focus.filter((m) => m.quality_sessions >= 4).length,
      marathons_since_april: monthly_focus.flatMap((m) => m.race_like.filter((r) => r.km >= 40)).length,
    },
    last_race: lastRace
      ? {
          date: lastRace.date,
          distance_km: lastRace.distance_km ?? 0,
          days_ago: Math.round((new Date(asOfDay).getTime() - new Date(lastRace.date).getTime()) / 86400_000),
        }
      : null,
    injuries: snapshot.injuries.map((i) => ({ body_area: i.body_area, status: i.status })),
    injury_return: deriveInjuryReturn(snapshot, asOfDay),
    evidence_note:
      "分类来自生产 session_class（手表证据分类器）：easy/long_easy=E 类有氧，quality/long_quality=质量课，race=比赛，strides=加速跑。直接采信，不要重新数数或质疑分类。",
  });
}
