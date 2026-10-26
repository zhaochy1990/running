import { z } from "zod/v4";
import { isRunLikeActivity, normalizeSessionClass } from "../../../data/activityClassification.js";
import type { ContextSnapshot } from "../context.js";
import { buildWeeklySeries, type HabitualBaseline, HabitualSchema, habitualBaseline } from "./load/baseline.js";
import { equivalentsFromVdot, type RaceDistanceKey, vdotFromRace, vdotFromThresholdPace } from "./vdot.js";

/**
 * 阶段划分证据层（devops#782，daniels.md §2.1）：纯函数、无存储。
 *
 * 输入=ContextSnapshot（master plan 现有快照，走 DataProvider）+ 活动行
 * （session_class 消费 #745 双值归一）+ as_of；输出=判断层 payload 的 evidence
 * 段。不输入：单课明细/laps、PMC 仿真、聊天上下文（daniels.md §2.1 明确排除）。
 */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const paceBound = z.number().nullable();
const PaceZoneSchema = z.tuple([paceBound, paceBound]);
/** 当前配速带（校准快照直读、取整秒，s/km；开放端为 null，如 r 的 lo / easy 的恢复侧不含）。 */
const PaceZonesSchema = z.object({
  easy: PaceZoneSchema.nullable(),
  m: PaceZoneSchema.nullable(),
  t: PaceZoneSchema.nullable(),
  i: PaceZoneSchema.nullable(),
  r: PaceZoneSchema.nullable(),
});
const EquivalentsSchema = z.object({ "5K": z.number(), "10K": z.number(), HM: z.number(), FM: z.number() });

/** 当前训练水平（devops#789）：VDOT 换算阶梯推导，锚定「当前能力」而非历史 PB。 */
const CurrentCapabilitySchema = z.object({
  /** 能力标量（换算阶梯的 VDOT 直读，距离无关）。 */
  vdot: z.number().nullable(),
  /** 同一 VDOT 四换算（秒）；短距离源对比源更长的距离已含 ×1.03 保守折扣。 */
  equivalents: EquivalentsSchema.nullable(),
  source: z.enum(["recent_race_hm_fm", "recent_race_short", "calibration", "none"]),
  /** 换算源日期（比赛日 / 校准 as_of）。 */
  source_date: day.nullable(),
  /** hm_fm=high；短距离折扣=medium；校准=medium；none=low。 */
  confidence: z.enum(["high", "medium", "low"]),
  pace_zones: PaceZonesSchema.nullable(),
});

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
  target: z.object({
    race: z.string(),
    target_time: z.string(),
    goal_pace: z.string(),
    /** 相对当前等效水平（current_capability）的提升幅度（%，1 位小数）：正值=目标快于当前水平、负值=慢于、null=无法估计。锚按目标距离取。 */
    improvement_pct: z.number().nullable(),
  }),
  personal_bests: z.record(z.string(), z.string()),
  /** FM 历史 PB（辅助字段：追平/超越峰值叙事与多周期参考，不作可行性锚）。 */
  peak_fm_pb: z.object({ time_sec: z.number().positive(), achieved_at: day.nullable() }).nullable(),
  current_capability: CurrentCapabilitySchema,
  fitness: z.object({ ctl: z.number(), atl: z.number(), form: z.number() }),
  availability: z.object({ weekly_run_days_max: z.number().int().min(1).max(7) }),
  habitual: HabitualSchema,
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

/** 跑步行判定（周画像口径，与 habitual 周序列共用 isRunLikeActivity：骑行等不入画像）。 */
const isRun = (a: PhasingActivityInput) => isRunLikeActivity(a);
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

/** race_history 距离（km）→ 标准距离桶；桶外（<4.5km 小课 / >45km 超马）不参与取锚。 */
const DISTANCE_BUCKETS: ReadonlyArray<{ key: RaceDistanceKey; minKm: number; maxKm: number }> = [
  { key: "5K", minKm: 4.5, maxKm: 7.5 },
  { key: "10K", minKm: 7.5, maxKm: 15.5 },
  { key: "HM", minKm: 15.5, maxKm: 32 },
  { key: "FM", minKm: 32, maxKm: 45.1 },
];

/** 短距离源（5K/10K）对更长距离等效成绩的保守折扣（短距离只高估长距离兑现）。 */
const SHORT_SOURCE_DISCOUNT = 1.03;
/** 近期比赛窗口（天）：12 个月。 */
const RACE_WINDOW_DAYS = 365;
/** VDOT 合理区间（丹尼尔斯表覆盖 30-85，两端留余量）：区间外视为脏数据行（如 duration_min 单位错误），跳过而非炸毁整份 evidence。 */
const VDOT_PLAUSIBLE_MIN = 10;
const VDOT_PLAUSIBLE_MAX = 90;

const isPlausibleVdot = (vdot: number) => Number.isFinite(vdot) && vdot >= VDOT_PLAUSIBLE_MIN && vdot <= VDOT_PLAUSIBLE_MAX;

interface RaceAnchor {
  source: "recent_race_hm_fm" | "recent_race_short";
  /** 取胜出比赛的桶键（等效折扣用）；VDOT 换算用实际距离与实际完赛时间。 */
  key: RaceDistanceKey;
  date: string;
  vdot: number;
}

/**
 * 换算阶梯第 1/2 档（devops#789）：近 12 个月 HM+ 全力最佳 → 主锚；
 * 无 HM+ 则 10K/5K 最佳 → 短距离源。全力识别：均配慢于校准阈值配速 ×1.15
 * 视为训练性比赛（污染源=周末长距离混入 race_history）；无校准阈值时无法
 * 识别、全部放行。取最佳（max VDOT）而非最近——「能代表当前能力的最佳近期
 * 表现」。完赛时间用 duration_min（race_history 无独立移动时长字段）。
 */
function deriveRaceAnchor(snapshot: ContextSnapshot, asOfMs: number, thresholdPaceSecPerKm: number | null): RaceAnchor | null {
  const candidates: RaceAnchor[] = [];
  for (const r of snapshot.race_history) {
    const km = r.distance_km;
    if (!km || !r.duration_min || r.duration_min <= 0) continue;
    const daysAgo = Math.round((asOfMs - new Date(r.date).getTime()) / 86400_000);
    if (daysAgo < 0 || daysAgo > RACE_WINDOW_DAYS) continue;
    const bucket = DISTANCE_BUCKETS.find((b) => km >= b.minKm && km < b.maxKm);
    if (!bucket) continue;
    const timeSec = r.duration_min * 60;
    const paceSecPerKm = r.avg_pace_s_km ?? timeSec / km;
    if (thresholdPaceSecPerKm != null && paceSecPerKm > thresholdPaceSecPerKm * 1.15) continue;
    const vdot = vdotFromRace(km * 1000, timeSec);
    if (!isPlausibleVdot(vdot)) continue;
    candidates.push({ source: bucket.key === "HM" || bucket.key === "FM" ? "recent_race_hm_fm" : "recent_race_short", key: bucket.key, date: r.date, vdot });
  }
  const hmPlus = candidates.filter((c) => c.source === "recent_race_hm_fm");
  const pool = hmPlus.length > 0 ? hmPlus : candidates;
  if (pool.length === 0) return null;
  return pool.reduce((best, c) => (c.vdot > best.vdot ? c : best));
}

/** 校准快照 pace_zones（[{name,minPaceSPerKm,maxPaceSPerKm}]）→ 丹尼尔斯五带；不可解析返回 null。 */
function calibrationPaceZones(snapshot: ContextSnapshot): z.infer<typeof PaceZonesSchema> | null {
  const zones = snapshot.running_calibration?.pace_zones;
  if (!Array.isArray(zones)) return null;
  const byName = new Map<string, { minPaceSPerKm?: number | null; maxPaceSPerKm?: number | null }>();
  for (const zone of zones) {
    if (zone != null && typeof zone === "object" && typeof (zone as { name?: unknown }).name === "string") {
      byName.set((zone as { name: string }).name, zone as { minPaceSPerKm?: number | null; maxPaceSPerKm?: number | null });
    }
  }
  const pick = (name: string): [number | null, number | null] | null => {
    const zone = byName.get(name);
    if (!zone) return null;
    const lo = typeof zone.minPaceSPerKm === "number" ? Math.round(zone.minPaceSPerKm) : null;
    const hi = typeof zone.maxPaceSPerKm === "number" ? Math.round(zone.maxPaceSPerKm) : null;
    return [lo, hi];
  };
  const mapped = { easy: pick("easy"), m: pick("marathon"), t: pick("threshold"), i: pick("interval"), r: pick("repetition") };
  return Object.values(mapped).some((zone) => zone !== null) ? mapped : null;
}

/**
 * VDOT 取锚阶梯 + improvement 推导（devops#789）：
 * 1. 近 12 个月 HM+ 全力最佳 → recent_race_hm_fm（high）
 * 2. 无则 10K/5K 最佳 → recent_race_short（medium；更长距离等效 ×1.03）
 * 3. 无比赛 → 校准阈值配速（60 分钟可持续速度）→ calibration（medium）
 * 4. improvement_pct 的锚 = 主锚与校准档同时可得时的保守者（VDOT 低者）
 *    ——比赛代表最高已证实水平、校准代表日常状态。
 */
function deriveCapability(
  snapshot: ContextSnapshot,
  asOfDay: string,
  targetSec: number,
  goalDistance: RaceDistanceKey,
): { improvement_pct: PhaseEvidence["target"]["improvement_pct"]; current_capability: PhaseEvidence["current_capability"] } {
  const calib = snapshot.running_calibration;
  const thresholdPaceSecPerKm = calib?.threshold_speed_mps && calib.threshold_speed_mps > 0 ? 1000 / calib.threshold_speed_mps : null;
  const calibVdot = thresholdPaceSecPerKm != null ? vdotFromThresholdPace(thresholdPaceSecPerKm) : Number.NaN;
  const calibUsable = isPlausibleVdot(calibVdot);

  const race = deriveRaceAnchor(snapshot, new Date(asOfDay).getTime(), thresholdPaceSecPerKm);

  const anchor: {
    vdot: number;
    source: "recent_race_hm_fm" | "recent_race_short" | "calibration";
    source_date: string | null;
    confidence: "high" | "medium";
  } | null =
    race != null
      ? {
          vdot: race.vdot,
          source: race.source,
          source_date: race.date,
          confidence: race.source === "recent_race_hm_fm" ? "high" : "medium",
        }
      : calibUsable
        ? { vdot: calibVdot, source: "calibration", source_date: calib?.as_of_date ?? null, confidence: "medium" }
        : null;

  const shortDiscount = race?.source === "recent_race_short" ? { sourceKey: race.key, discountLonger: SHORT_SOURCE_DISCOUNT } : {};
  const capabilityDiscounted = shortDiscount.discountLonger !== undefined;
  const equivalents = anchor != null ? equivalentsFromVdot(anchor.vdot, shortDiscount) : null;

  // improvement 锚（规则 4）：主锚与校准档取保守；短距离折扣只在短距离主锚胜出时生效
  const effectiveVdot = race != null && calibUsable ? Math.min(race.vdot, calibVdot) : (race?.vdot ?? (calibUsable ? calibVdot : Number.NaN));
  const effectiveUsesDiscount = race?.source === "recent_race_short" && (!calibUsable || race.vdot <= calibVdot);
  const improvementPct = (() => {
    if (!Number.isFinite(effectiveVdot) || targetSec <= 0) return null;
    // 主路径（无校准，或比赛锚即保守者且折扣一致）下 improvement 锚与 current_capability 等效表同源，直接复用
    const reusesCapability = equivalents != null && effectiveVdot === anchor?.vdot && effectiveUsesDiscount === capabilityDiscounted;
    const anchorSec = reusesCapability
      ? equivalents[goalDistance]
      : equivalentsFromVdot(effectiveVdot, effectiveUsesDiscount ? shortDiscount : {})[goalDistance];
    if (!Number.isFinite(anchorSec) || anchorSec <= 0) return null;
    return r1(((anchorSec - targetSec) / anchorSec) * 100);
  })();

  return {
    improvement_pct: improvementPct,
    current_capability: {
      vdot: anchor != null ? r1(anchor.vdot) : null,
      equivalents,
      source: anchor?.source ?? "none",
      source_date: anchor?.source_date ?? null,
      confidence: anchor?.confidence ?? "low",
      pace_zones: calibrationPaceZones(snapshot),
    },
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

  // I3 赛后恢复门输入（devops#790）：5K 比赛不该触发「首阶段 recovery」，只认 ≥10km 的比赛行
  const lastRace = snapshot.race_history.find((r) => (r.distance_km ?? 0) >= 10) ?? null;
  const pbs: Record<string, string> = {};
  for (const pb of snapshot.personal_bests) pbs[pb.distance] = `${Math.floor(pb.time_sec / 60)}:${String(Math.round(pb.time_sec % 60)).padStart(2, "0")}`;
  const targetSec = parseHms(goal.targetTime);
  const goalPaceSPerKm = targetSec / RACE_DISTANCE_KM;
  const capability = deriveCapability(snapshot, asOfDay, targetSec, goal.distance);
  const fmPb = snapshot.personal_bests.find((pb) => pb.distance === "FM") ?? null;
  const habitual: HabitualBaseline = habitualBaseline(buildWeeklySeries(activities, asOfDay));

  return PhaseEvidenceSchema.parse({
    as_of: asOfDay,
    target: {
      race: `全程马拉松 ${goal.raceName}`,
      target_time: goal.targetTime,
      goal_pace: `${fmtPace(goalPaceSPerKm)}/km`,
      improvement_pct: capability.improvement_pct,
    },
    personal_bests: pbs,
    peak_fm_pb: fmPb != null ? { time_sec: fmPb.time_sec, achieved_at: fmPb.achieved_at } : null,
    current_capability: capability.current_capability,
    fitness: {
      ctl: Math.round(snapshot.fitness_state.ctl ?? 0),
      atl: Math.round(snapshot.fitness_state.atl ?? 0),
      form: Math.round(snapshot.fitness_state.form ?? 0),
    },
    availability: { weekly_run_days_max: goal.weeklyRunDaysMax },
    habitual,
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
