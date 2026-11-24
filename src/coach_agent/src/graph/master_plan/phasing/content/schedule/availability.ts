import { AVAILABILITY_WEEKDAY, type AvailabilityDetail } from "@stride/contract";

/**
 * 排课可用度（devops#1043）：调度器消费的归一形态。请求契约、落库 availability、
 * 存量读取三处都经 `schedulingAvailabilityOf` 归一；明细缺省=未声明，沿用既有
 * 行为（七天皆可、E 时长带不受限、双练按周量 >110km 准入）。
 */
export interface AvailabilityConstraints {
  /** 可跑日（周内位 0=周一…6=周日，升序）；null=具体日期未知（存量只有天数上限）。 */
  availableWeekdays: number[] | null;
  /**
   * 日内可训练时段（devops#1054）：每个周内位最长的一段连续可用分钟（单课须装得进
   * 连续的一段）；没有时窗的日子=0；null=未指定日内时段（单课时长不受时窗限制）。
   */
  windowMinutes: number[] | null;
  /** 单课时长上限（分钟）；null=未声明。 */
  maxSessionDurationMin: number | null;
  /** 双练许可；null=未声明（既有周量准入独立生效）。 */
  allowsDoubleSessions: boolean | null;
}

const WEEKDAY_INDEX = new Map<string, number>(AVAILABILITY_WEEKDAY.options.map((day, index) => [day, index]));

const minutesOf = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

/**
 * 同一天多个时窗里最长的一段连续可用分钟：相交/相接的时窗取并集，不重复计时
 * （06:00–08:00 与 07:00–09:30 是一段 210min，不是 270）；结束早于开始=跨午夜；
 * 没有时窗=0。
 */
function longestWindowMinutes(windows: NonNullable<AvailabilityDetail["available_training_windows"]>): number {
  const spans: Array<[number, number]> = windows
    .map((window): [number, number] => {
      const start = minutesOf(window.start_time);
      const end = minutesOf(window.end_time);
      return [start, end < start ? end + 1440 : end];
    })
    .sort((a, b) => a[0]! - b[0]!);
  let longest = 0;
  let merged: [number, number] | null = null;
  for (const span of spans) {
    if (merged != null && span[0]! <= merged[1]) merged[1] = Math.max(merged[1], span[1]!);
    else merged = [span[0]!, span[1]!];
    longest = Math.max(longest, merged[1] - merged[0]);
  }
  return longest;
}

/**
 * 明细（可缺）→ 归一可用度。有明确可用窗口时候选日同时满足窗口与禁跑日；窗口
 * 为空数组=未指定日内时段，候选日=一周七天扣除禁跑日；明细整体缺失=具体日期
 * 未知（availableWeekdays=null，七天皆可）。
 */
export function schedulingAvailabilityOf(detail?: AvailabilityDetail): AvailabilityConstraints {
  if (detail == null) return { availableWeekdays: null, windowMinutes: null, maxSessionDurationMin: null, allowsDoubleSessions: null };
  const unavailable = new Set((detail.unavailable_days ?? []).map((day) => WEEKDAY_INDEX.get(day)));
  const windows = detail.available_training_windows ?? [];
  const windowMinutes =
    windows.length > 0
      ? Array.from({ length: 7 }, (_, weekday) => longestWindowMinutes(windows.filter((window) => WEEKDAY_INDEX.get(window.day) === weekday)))
      : null;
  return {
    availableWeekdays: Array.from({ length: 7 }, (_, weekday) => weekday).filter(
      (weekday) => !unavailable.has(weekday) && (windowMinutes == null || windowMinutes[weekday]! > 0),
    ),
    windowMinutes,
    maxSessionDurationMin: detail.max_session_duration_min ?? null,
    allowsDoubleSessions: detail.allows_double_sessions ?? null,
  };
}

/** 某个周内位是否可跑（可跑日未知=七天皆可）。 */
export const isAvailableDay = (availableWeekdays: readonly number[] | null, weekday: number): boolean =>
  availableWeekdays == null || availableWeekdays.includes(weekday);

/** 有效每周跑步日上限：声明上限与可跑日数取小（可跑日未知=不受限）。 */
export const effectiveDaysMaxOf = (weeklyRunDaysMax: number, availability?: AvailabilityConstraints): number =>
  Math.min(weeklyRunDaysMax, availability?.availableWeekdays?.length ?? 7);

/** 某个周内位单课可用的最长分钟数：单课上限与最长的一段时窗取小；都不限=null。 */
export function sessionLimitOf(availability: AvailabilityConstraints | undefined, weekday: number): number | null {
  const limits = [availability?.maxSessionDurationMin, availability?.windowMinutes?.[weekday]].filter((limit): limit is number => limit != null);
  return limits.length === 0 ? null : Math.min(...limits);
}

/** 单课可用上限的说明（冲突文案用），如「单课上限 70min、时窗 30min」；不限=空串。 */
export function sessionLimitLabelOf(availability: AvailabilityConstraints | undefined, weekday: number): string {
  const window = availability?.windowMinutes?.[weekday] ?? 0;
  return [availability?.maxSessionDurationMin != null ? `单课上限 ${availability.maxSessionDurationMin}min` : null, window > 0 ? `时窗 ${window}min` : null]
    .filter((part): part is string => part != null)
    .join("、");
}

/** 双练准入 = 既有周量门槛 ∧ 用户许可（未声明=不额外限制）。 */
export function doubleSessionAllowed(weeklyKm: number, admissionKm: number, availability: AvailabilityConstraints | undefined): boolean {
  return weeklyKm > admissionKm && availability?.allowsDoubleSessions !== false;
}
