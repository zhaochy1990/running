import type { RunWorkout } from "./schema.js";

export interface WorkoutTotals {
  total_distance_m: number | null;
  total_duration_s: number | null;
}

const addKnown = (total: number | null, value: number | null): number | null => (total === null || value === null ? null : total + value);

/**
 * 总距离 / 总时长；休息计入时长（step.rest 字段与尾部 rest step 两种 idiom
 * 都计入，双 idiom 的 totals 相等）。出现非对应量纲的步（如求距离时混入
 * time_s 步、open 步、hr_bpm/manual 休息）时对应总量为 null——未知不猜。
 */
export function workoutTotals(workout: RunWorkout): WorkoutTotals {
  let distance: number | null = 0;
  let duration: number | null = 0;
  for (const block of workout.blocks) {
    for (let repetition = 0; repetition < block.repeat; repetition += 1) {
      for (const step of block.steps) {
        if (step.step_kind !== "rest") {
          distance = addKnown(distance, step.duration.kind === "distance_m" ? step.duration.value : null);
        }
        duration = addKnown(duration, step.duration.kind === "time_s" ? step.duration.value : null);
        if (step.rest !== undefined) {
          duration = addKnown(duration, step.rest.kind === "time_s" ? step.rest.value : null);
        }
      }
    }
  }
  return { total_distance_m: distance, total_duration_s: duration };
}

/** 无校准（或 easy 带缺失）时的估距兜底配速（s/km，=5:30/km，与端上估时兜底同口径）；仅显示用，不进剂量/守恒门。 */
export const ESTIMATE_FALLBACK_PACE_S_PER_KM = 330;

/** 校准配速带的最小投影（与 dataProvider.PaceZone 结构同形，契约包不依赖 data 层）。 */
export interface PaceBandZone {
  name: string;
  minPaceSPerKm: number | null;
  maxPaceSPerKm: number | null;
}

/** easy 带中点（s/km，量纲折算锚=契约⑨）；easy 缺失或开带返回 null。 */
export function easyMidOfPaceZones(zones: readonly PaceBandZone[] | null | undefined): number | null {
  const easy = (zones ?? []).find((zone) => zone.name === "easy");
  return easy != null && easy.minPaceSPerKm != null && easy.maxPaceSPerKm != null ? (easy.minPaceSPerKm + easy.maxPaceSPerKm) / 2 : null;
}

/**
 * 时间制课的显示估距（契约⑨落地，devops#838）：distance 步直读；time+配速处方
 * 步按处方中点折算（与 stepKmOf 同式）；其余 time 步（open/hr/power/cadence）按
 * easy 带中点折算，无校准/easy 带缺失兜底 330s/km；任一非 rest 步不可估则
 * null（未知不猜）。仅参考显示——守恒门与剂量校验继续走 stepKmOf /
 * estimatePlannedRunLoad，估算值不进任何校验门。
 */
export function estimatedTotalDistanceM(workout: RunWorkout, easyPaceSPerKm?: number | null): number | null {
  const pace = easyPaceSPerKm != null && easyPaceSPerKm > 0 ? easyPaceSPerKm : ESTIMATE_FALLBACK_PACE_S_PER_KM;
  let distance: number | null = 0;
  for (const block of workout.blocks) {
    for (let repetition = 0; repetition < block.repeat; repetition += 1) {
      for (const step of block.steps) {
        if (step.step_kind === "rest") continue;
        distance = addKnown(distance, estimatedStepDistanceM(step, pace));
      }
    }
  }
  return distance;
}

function estimatedStepDistanceM(step: RunWorkout["blocks"][number]["steps"][number], easyPaceSPerKm: number): number | null {
  if (step.duration.kind === "distance_m") return step.duration.value;
  if (step.duration.kind !== "time_s") return null;
  if (step.target.kind === "pace_s_km") return (step.duration.value / ((step.target.low + step.target.high) / 2)) * 1000;
  return (step.duration.value / easyPaceSPerKm) * 1000;
}
