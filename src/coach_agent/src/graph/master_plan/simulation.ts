import {
  type MasterPlan,
  type MasterPlanGraphRequest,
  mondayOnOrBefore as monday,
  type SimulationReport,
  SimulationReportSchema,
  type SimulationWeek,
  SimulationWeekSchema,
} from "@stride/contract";
import type { ContextSnapshot } from "./context.js";
import { estimateMasterPlanWeekLoad } from "./loadEstimator.js";

export type { SimulationReport } from "@stride/contract";
export {
  SimulationReportSchema,
  SimulationWeekSchema,
} from "@stride/contract";
export interface PmcDay {
  dose: number;
  atl: number;
  ctl: number;
  form: number;
  ratio: number | null;
}

const ACUTE_K = 1 - Math.exp(-1 / 7);
const CHRONIC_K = 1 - Math.exp(-1 / 42);
const DISTRIBUTION: readonly number[] = [0.1, 0.18, 0.12, 0.18, 0.1, 0.27, 0.05];

const round = (value: number): number => Number(value.toFixed(4));

export function simulatePmcDays(doses: readonly number[], initial: { atl: number; ctl: number }): PmcDay[] {
  let atl = initial.atl;
  let ctl = initial.ctl;
  return doses.map((dose) => {
    atl += ACUTE_K * (dose - atl);
    ctl += CHRONIC_K * (dose - ctl);
    return {
      dose: round(dose),
      atl: round(atl),
      ctl: round(ctl),
      form: round(ctl - atl),
      ratio: ctl > 0 ? round(atl / ctl) : null,
    };
  });
}

/** Strategic estimate with canonical pace-zone ranges and easy-volume completion. */
export function simulateMasterPlanLoad(plan: MasterPlan, snapshot: ContextSnapshot, request?: MasterPlanGraphRequest): SimulationReport {
  const threshold = snapshot.running_calibration?.threshold_speed_mps;
  const initialPmcAvailable = snapshot.fitness_state.atl !== null && snapshot.fitness_state.ctl !== null;
  let state = {
    atl: snapshot.fitness_state.atl ?? 0,
    ctl: snapshot.fitness_state.ctl ?? 0,
  };
  const gapDays = dayDiff(snapshot.fitness_state.as_of_date, plan.start_date);
  const currentWeek = monday(snapshot.fitness_state.as_of_date);
  const partialCurrentWeek = gapDays < 0 && plan.start_date === currentWeek;
  if (gapDays < 0 && !partialCurrentWeek) throw new Error("plan starts before the fitness-state snapshot week");
  if (gapDays > 1) {
    const decayed = simulatePmcDays(
      Array.from({ length: gapDays - 1 }, () => 0),
      state,
    ).at(-1);
    if (!decayed) throw new Error("failed to decay PMC state before plan");
    state = { atl: decayed.atl, ctl: decayed.ctl };
  }
  let pmcAvailable = initialPmcAvailable;
  const weeks = plan.weeks.map((week) => {
    const estimate = estimateMasterPlanWeekLoad(
      week,
      plan.goal,
      threshold,
      snapshot.running_calibration?.pace_zones,
      snapshot.running_calibration?.threshold_hr,
      snapshot.running_calibration?.rhr_baseline,
    );
    const estimatedDose = estimate.expectedDose;
    if (estimatedDose === null) pmcAvailable = false;
    const weekDistribution = distributionForWeek(week, plan, request);
    const elapsed = week.week_index === 1 && partialCurrentWeek ? Math.min(7, dayDiff(week.week_start, snapshot.fitness_state.as_of_date) + 1) : 0;
    const remainingShares = weekDistribution.slice(elapsed);
    const doses = estimatedDose === null ? [] : remainingShares.map((share) => estimatedDose * share);
    const days = pmcAvailable ? simulatePmcDays(doses, state) : [];
    const end = days.at(-1);
    if (end) state = { atl: end.atl, ctl: end.ctl };
    return {
      week_index: week.week_index,
      week_start: week.week_start,
      estimated: true as const,
      provenance:
        week.week_index === 1 && partialCurrentWeek
          ? ("partial_current_week+weekly_high_target+key_sessions+remaining_easy_volume" as const)
          : ("weekly_high_target+key_sessions+remaining_easy_volume" as const),
      confidence:
        estimatedDose === null
          ? ("low" as const)
          : estimate.assumptions.includes("structured_workout_partial_coverage")
            ? ("low" as const)
            : !initialPmcAvailable ||
                snapshot.running_calibration?.threshold_speed_confidence !== "high" ||
                estimate.lowDose !== estimate.highDose ||
                estimate.assumptions.some((assumption) =>
                  /(?:unspecified|unknown|distance_only|legacy_unstructured|^open_|heart_rate_target|differs_from_declared)/.test(assumption),
                ) ||
                (week.week_index === 1 && partialCurrentWeek)
              ? ("medium" as const)
              : ("high" as const),
      daily_distribution: weekDistribution,
      estimated_dose: estimatedDose === null ? null : round(estimatedDose),
      estimated_dose_low: estimate.lowDose === null ? null : round(estimate.lowDose),
      estimated_dose_high: estimate.highDose === null ? null : round(estimate.highDose),
      load_assumptions: estimate.assumptions,
      missing_dose_reason: estimatedDose === null ? estimate.unavailableReason : !initialPmcAvailable ? "initial_pmc_state_missing" : null,
      end_ctl: end?.ctl ?? null,
      end_atl: end?.atl ?? null,
      end_form: end?.form ?? null,
      ratio: end?.ratio ?? null,
      long_run_dose_share: estimate.longRunDoseShare,
    };
  });
  return SimulationReportSchema.parse({
    algorithm_version: "master-plan-load-v3",
    estimated: true,
    provenance:
      "deterministic strategic estimate; canonical run-workout/v1 segment integration with explicit legacy fallback; expected dose drives availability-adjusted Mon-Sun PMC shares",
    weeks,
  });
}
function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
function distributionForWeek(week: MasterPlan["weeks"][number], plan: MasterPlan, request?: MasterPlanGraphRequest): number[] {
  if (!request) return [...DISTRIBUTION];
  const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
  const unavailable = new Set(request.availability.unavailable_days);
  const windowDays = new Set(request.availability.available_training_windows.map((window) => window.day));
  const eligible = weekdays.map((day) => !unavailable.has(day) && (windowDays.size === 0 || windowDays.has(day)));
  const raceDay = week.key_sessions.some((session) => session.type === "race") ? (new Date(`${plan.goal.race_date}T00:00:00Z`).getUTCDay() + 6) % 7 : null;
  const routineDayLimit = Math.max(0, request.availability.weekly_run_days_max - (raceDay !== null ? 1 : 0));
  const retainedDays = eligible
    .map((allowed, index) => ({
      allowed,
      index,
      share: DISTRIBUTION[index] ?? 0,
    }))
    .filter((item) => item.allowed && item.index !== raceDay)
    .sort((a, b) => b.share - a.share || a.index - b.index)
    .slice(0, routineDayLimit);
  const retainedIndexes = new Set(retainedDays.map((item) => item.index));
  const availableShares = DISTRIBUTION.map((share, index) => (retainedIndexes.has(index) ? share : 0));
  if (raceDay !== null) {
    const nonRaceTotal = availableShares.reduce((sum, share, index) => sum + (index === raceDay ? 0 : share), 0);
    const raceShare = nonRaceTotal > 0 ? 0.85 : 1;
    return availableShares.map((share, index) => (index === raceDay ? raceShare : nonRaceTotal > 0 ? (share / nonRaceTotal) * (1 - raceShare) : 0));
  }
  const total = availableShares.reduce((sum, share) => sum + share, 0);
  if (total === 0) throw new Error("no available training day for simulated week");
  return availableShares.map((share) => share / total);
}
