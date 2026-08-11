import type { ContextSnapshot } from "./context.js";
import type { MasterPlan } from "./schemas.js";
import { z } from "zod/v4";

const ACUTE_K = 1 - Math.exp(-1 / 7);
const CHRONIC_K = 1 - Math.exp(-1 / 42);
const DISTRIBUTION = [0.1, 0.18, 0.12, 0.18, 0.1, 0.27, 0.05] as const;
const IF_BY_TYPE: Record<MasterPlan["weeks"][number]["key_sessions"][number]["type"], number> = {
  long_run: 0.78, threshold: 0.98, tempo: 0.9, interval: 1.05, vo2max: 1.1,
  hill: 1, race_pace: 0.95, time_trial: 1.05, tune_up_race: 1, race: 1,
  strength_key: 0,
};

export const SimulationWeekSchema = z.object({ week_index: z.int().positive(), week_start: z.string(), estimated: z.literal(true), provenance: z.enum(["weekly_midpoint+key_sessions+remaining_easy_volume", "partial_current_week+weekly_midpoint+key_sessions+remaining_easy_volume"]), confidence: z.enum(["high", "medium", "low"]), estimated_dose: z.number().nullable(), missing_dose_reason: z.string().nullable(), end_ctl: z.number().nullable(), end_atl: z.number().nullable(), end_form: z.number().nullable(), ratio: z.number().nullable(), long_run_dose_share: z.number().nullable() }).strict();
export const SimulationReportSchema = z.object({ algorithm_version: z.literal("master-plan-load-v1"), estimated: z.literal(true), provenance: z.string(), daily_distribution: z.array(z.number()), weeks: z.array(SimulationWeekSchema) }).strict();
export type SimulationReport = z.infer<typeof SimulationReportSchema>;
export interface PmcDay { dose: number; atl: number; ctl: number; form: number; ratio: number | null }

const round = (value: number): number => Number(value.toFixed(4));

export function simulatePmcDays(doses: readonly number[], initial: { atl: number; ctl: number }): PmcDay[] {
  let atl = initial.atl; let ctl = initial.ctl;
  return doses.map((dose) => {
    atl += ACUTE_K * (dose - atl); ctl += CHRONIC_K * (dose - ctl);
    return { dose: round(dose), atl: round(atl), ctl: round(ctl), form: round(ctl - atl), ratio: ctl > 0 ? round(atl / ctl) : null };
  });
}

/** Strategic estimate only: key sessions use duration × IF²; unlisted volume is easy IF=.75. */
export function simulateMasterPlanLoad(plan: MasterPlan, snapshot: ContextSnapshot): SimulationReport {
  const threshold = snapshot.running_calibration?.threshold_speed_mps;
  const initialPmcAvailable = snapshot.fitness_state.atl !== null && snapshot.fitness_state.ctl !== null;
  let state = { atl: snapshot.fitness_state.atl ?? 0, ctl: snapshot.fitness_state.ctl ?? 0 };
  const gapDays = dayDiff(snapshot.fitness_state.as_of_date, plan.start_date);
  const currentWeek = monday(snapshot.fitness_state.as_of_date);
  const partialCurrentWeek = gapDays < 0 && plan.start_date === currentWeek;
  if (gapDays < 0 && !partialCurrentWeek) throw new Error("plan starts before the fitness-state snapshot week");
  if (gapDays > 1) { const decayed = simulatePmcDays(Array.from({ length: gapDays - 1 }, () => 0), state).at(-1)!; state = { atl: decayed.atl, ctl: decayed.ctl }; }
  let pmcAvailable = initialPmcAvailable;
  const weeks = plan.weeks.map((week) => {
    const weeklyKm = (week.target_weekly_km_low + week.target_weekly_km_high) / 2;
    let keyDistance = 0; let keyDose = 0; let longRunDose = 0; let uncertain = false;
    for (const session of week.key_sessions) {
      if (session.type === "strength_key") continue;
      let intensity = IF_BY_TYPE[session.type];
      let duration = session.duration_min;
      if (duration === null && session.distance_km !== null && threshold && threshold > 0) duration = session.distance_km / (threshold * 3.6 * intensity) * 60;
      if (duration === null) { uncertain = true; continue; }
      if (session.distance_km !== null && threshold && threshold > 0 && duration > 0) intensity = Math.max(0.5, Math.min(1.2, (session.distance_km * 1000 / (duration * 60)) / threshold));
      const dose = duration / 60 * intensity ** 2 * 100;
      keyDose += dose;
      if (session.distance_km !== null) keyDistance += session.distance_km;
      else if (threshold && threshold > 0) keyDistance += duration / 60 * threshold * 3.6 * intensity;
      else uncertain = true;
      if (session.type === "long_run") longRunDose += dose;
    }
    const easyDistance = Math.max(0, weeklyKm - keyDistance);
    if (!threshold || threshold <= 0) uncertain = true;
    const easyDose = threshold && threshold > 0 ? easyDistance / (threshold * 3.6 * 0.75) * 0.75 ** 2 * 100 : 0;
    const estimatedDose = threshold && threshold > 0 ? keyDose + easyDose : null;
    if (estimatedDose === null) pmcAvailable = false;
    const remainingShares = week.week_index === 1 && partialCurrentWeek ? DISTRIBUTION.slice(Math.min(7, dayDiff(week.week_start, snapshot.fitness_state.as_of_date) + 1)) : DISTRIBUTION;
    const doses = estimatedDose === null ? [] : remainingShares.map((share) => estimatedDose * share);
    const days = pmcAvailable ? simulatePmcDays(doses, state) : [];
    const end = days.at(-1); if (end) state = { atl: end.atl, ctl: end.ctl };
    return { week_index: week.week_index, week_start: week.week_start, estimated: true as const, provenance: week.week_index === 1 && partialCurrentWeek ? "partial_current_week+weekly_midpoint+key_sessions+remaining_easy_volume" as const : "weekly_midpoint+key_sessions+remaining_easy_volume" as const, confidence: estimatedDose === null ? "low" as const : !initialPmcAvailable || uncertain || week.week_index === 1 && partialCurrentWeek ? "medium" as const : "high" as const, estimated_dose: estimatedDose === null ? null : round(estimatedDose), missing_dose_reason: estimatedDose === null ? "threshold_speed_calibration_missing" : !initialPmcAvailable ? "initial_pmc_state_missing" : null, end_ctl: end?.ctl ?? null, end_atl: end?.atl ?? null, end_form: end?.form ?? null, ratio: end?.ratio ?? null, long_run_dose_share: estimatedDose && estimatedDose > 0 ? round(longRunDose / estimatedDose) : null };
  });
  return SimulationReportSchema.parse({ algorithm_version: "master-plan-load-v1", estimated: true, provenance: "deterministic strategic estimate; threshold-speed calibrated TSS scale; fixed Mon-Sun shares", daily_distribution: [...DISTRIBUTION], weeks });
}
function dayDiff(from: string, to: string): number { return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000); }
function monday(day: string): string { const date = new Date(`${day}T00:00:00Z`); date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7)); return date.toISOString().slice(0, 10); }
