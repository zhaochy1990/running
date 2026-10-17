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
