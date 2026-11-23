import { AVAILABILITY_WEEKDAY, type AvailabilityDetail } from "@stride/contract";

/**
 * 排课可用度（devops#1043）：调度器消费的归一形态。请求契约、落库 availability、
 * 存量读取三处都经 `schedulingAvailabilityOf` 归一；明细缺省=未声明，沿用既有
 * 行为（七天皆可、E 时长带不受限、双练按周量 >110km 准入）。
 */
export interface AvailabilityConstraints {
  /** 可跑日（周内位 0=周一…6=周日，升序）；null=具体日期未知（存量只有天数上限）。 */
  availableWeekdays: number[] | null;
  /** 单课时长上限（分钟）；null=未声明。 */
  maxSessionDurationMin: number | null;
  /** 双练许可；null=未声明（既有周量准入独立生效）。 */
  allowsDoubleSessions: boolean | null;
}

const WEEKDAY_INDEX = new Map<string, number>(AVAILABILITY_WEEKDAY.options.map((day, index) => [day, index]));

/**
 * 明细（可缺）→ 归一可用度。有明确可用窗口时候选日同时满足窗口与禁跑日；窗口
 * 为空数组=未指定日内时段，候选日=一周七天扣除禁跑日；明细整体缺失=具体日期
 * 未知（availableWeekdays=null，七天皆可）。
 */
export function schedulingAvailabilityOf(detail?: AvailabilityDetail): AvailabilityConstraints {
  if (detail == null) return { availableWeekdays: null, maxSessionDurationMin: null, allowsDoubleSessions: null };
  const unavailable = new Set((detail.unavailable_days ?? []).map((day) => WEEKDAY_INDEX.get(day)));
  const windowed =
    detail.available_training_windows != null && detail.available_training_windows.length > 0
      ? new Set(detail.available_training_windows.map((window) => WEEKDAY_INDEX.get(window.day)))
      : null;
  return {
    availableWeekdays: Array.from({ length: 7 }, (_, weekday) => weekday).filter(
      (weekday) => !unavailable.has(weekday) && (windowed == null || windowed.has(weekday)),
    ),
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

/** 双练准入 = 既有周量门槛 ∧ 用户许可（未声明=不额外限制）。 */
export function doubleSessionAllowed(weeklyKm: number, admissionKm: number, availability: AvailabilityConstraints | undefined): boolean {
  return weeklyKm > admissionKm && availability?.allowsDoubleSessions !== false;
}
