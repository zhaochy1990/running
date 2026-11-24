/**
 * 单课上限（devops#1054，2026-11-24 用户拍板）：由能力派生，不让用户选。分两个——
 * 长距离上限（长跑）与日常有氧上限（非长跑日的轻松课）。L3 定长跑里程与 L4b 排位
 * 硬校验（P9）共用这一份：L3 按它封顶，排课阶段用同一公式再核一遍。
 */

/** 长距离上限之一：时长封顶（分钟）。 */
export const LONG_RUN_MAX_MIN = 180;
/** 长距离上限之二：距离封顶（km）。 */
export const LONG_RUN_MAX_KM = 40;

/**
 * 长跑的公里上限：在该跑者 E 配速（s/km，取带中点）下 180 分钟能跑完的距离，再受
 * 40km 封顶——能力通过配速起作用，同样的时长，跑得慢的人封在更短的公里数。
 * 向下取整到 0.1km，保证按该配速折算的时长不超 180 分钟。
 */
export function longRunMaxKm(easyPaceSPerKm: number): number {
  return Math.min(LONG_RUN_MAX_KM, Math.floor(((LONG_RUN_MAX_MIN * 60) / easyPaceSPerKm) * 10) / 10);
}

/**
 * 由能力投影第 1 周的 E 带算长跑公里上限（取带中点配速）。第 1 周=计划的起点能力
 * （VDOT=min(当前, 目标−2)）：通常就是当前能力，目标只略高于当前时略低、偏保守。
 * 投影逐周 VDOT 只增不减，所以按第 1 周封住的长跑到任何一周都不会被 P9 的当周
 * 上限拦下。E 带缺失=只受距离封顶。
 */
export function longRunMaxKmOfZone(easyBand: readonly [number | null, number | null] | null | undefined): number {
  return easyBand?.[0] == null || easyBand[1] == null ? LONG_RUN_MAX_KM : longRunMaxKm((easyBand[0] + easyBand[1]) / 2);
}
