import {
  addDays,
  DailySimulationSchema,
  SessionSimulationSchema,
  type WeeklyPlan,
  type WeeklyPlanSimulationReport,
  WeeklyPlanSimulationReportSchema,
} from "@stride/contract";
import { z } from "zod/v4";

export type { WeeklyPlanSimulationReport } from "@stride/contract";
import type { WeeklyPlanContext } from "../../persistence/weeklyPlanContextProvider.js";
import { simulatePmcDays } from "../master_plan/simulation.js";
import { estimatePlannedRunLoad } from "../training_load/plannedRunLoad.js";

/** Simulate a concrete Monday-Sunday WeeklyPlan using its actual session dates. */
export function simulateWeeklyPlanLoad(plan: WeeklyPlan, context: WeeklyPlanContext): WeeklyPlanSimulationReport {
  const thresholdSpeed = context.user_profile.threshold_speed_mps;
  const thresholdHr = context.user_profile.lactate_threshold_hr;
  const rhr = context.user_profile.rhr_baseline;
  const weekStart = context.plan_start;
  const sessionReports: z.input<typeof SessionSimulationSchema>[] = [];
  const missingReasons: string[] = [];
  const assumptions: string[] = [];

  if (thresholdSpeed === null) missingReasons.push("threshold_speed_calibration_missing");
  for (const session of plan.sessions) {
    if (session.kind !== "run") continue;
    const declaredDistance = session.total_distance_m === null ? null : session.total_distance_m / 1000;
    const estimate = thresholdSpeed !== null && session.spec !== null ? estimatePlannedRunLoad(session.spec, thresholdSpeed, thresholdHr, rhr) : null;
    let missingReason: string | null = null;
    if (session.spec === null) missingReason = "run_workout_structure_missing";
    else if (thresholdSpeed === null) missingReason = "threshold_speed_calibration_missing";
    else if (estimate === null || estimate.unestimatedSteps > 0) missingReason = "planned_session_uncomputable";

    const sessionAssumptions = estimate?.assumptions ?? [];
    if (estimate && declaredDistance !== null && materiallyDifferent(declaredDistance, estimate.estimatedDistanceKm)) {
      missingReason = "structured_distance_differs_from_session_total";
      sessionAssumptions.push("structured_distance_differs_from_session_total");
    }
    if (missingReason) missingReasons.push(missingReason);
    assumptions.push(...sessionAssumptions);
    sessionReports.push({
      date: session.date,
      session_index: session.session_index,
      summary: session.summary,
      estimated_dose: missingReason ? null : round(estimate?.expectedDose ?? 0),
      estimated_dose_low: missingReason ? null : round(estimate?.lowDose ?? 0),
      estimated_dose_high: missingReason ? null : round(estimate?.highDose ?? 0),
      declared_distance_km: declaredDistance,
      estimated_structured_distance_km: estimate === null ? null : round(estimate.estimatedDistanceKm),
      load_assumptions: unique(sessionAssumptions),
      missing_dose_reason: missingReason,
    });
  }

  const available = missingReasons.length === 0;
  const dailyExpected = dailyDoses(sessionReports, weekStart, "estimated_dose");
  const dailyLow = dailyDoses(sessionReports, weekStart, "estimated_dose_low");
  const dailyHigh = dailyDoses(sessionReports, weekStart, "estimated_dose_high");
  const totalDose = available ? sum(dailyExpected) : null;
  const totalDoseLow = available ? sum(dailyLow) : null;
  const totalDoseHigh = available ? sum(dailyHigh) : null;
  const fitness = record(context.fitness_state);
  const strideLoad = record(fitness?.stride_training_load);
  const initialAtl = number(strideLoad?.acute_load);
  const initialCtl = number(strideLoad?.chronic_load);
  const initialPmcDate = string(fitness?.as_of_date) ?? context.as_of;
  const pmcPath =
    available && initialAtl !== null && initialCtl !== null
      ? projectPmc(initialPmcDate, weekStart, dailyExpected, {
          atl: initialAtl,
          ctl: initialCtl,
        })
      : [];
  const zeroLoadPmcPath =
    available && initialAtl !== null && initialCtl !== null
      ? projectPmc(
          initialPmcDate,
          weekStart,
          Array.from({ length: 7 }, () => 0),
          {
            atl: initialAtl,
            ctl: initialCtl,
          },
        )
      : [];
  if (initialAtl === null || initialCtl === null) assumptions.push("initial_pmc_state_missing");
  if (maximumConsecutiveOverreach(zeroLoadPmcPath) >= 3) assumptions.push("preexisting_overreach_persists_without_planned_load");

  const days = dailyExpected.map((dose, index) => {
    const pmc = pmcPath[index];
    return {
      date: addDays(weekStart, index),
      estimated_dose: available ? round(dose) : null,
      estimated_dose_low: available ? round(dailyLow[index] ?? 0) : null,
      estimated_dose_high: available ? round(dailyHigh[index] ?? 0) : null,
      end_ctl: pmc?.ctl ?? null,
      end_atl: pmc?.atl ?? null,
      end_form: pmc?.form ?? null,
      load_ratio: pmc?.ratio ?? null,
    };
  });
  const maxSessionDose = available ? Math.max(0, ...sessionReports.map((session) => session.estimated_dose ?? 0)) : null;
  const safetyIssues = pmcSafetyIssues(days, zeroLoadPmcPath);

  return WeeklyPlanSimulationReportSchema.parse({
    algorithm_version: "weekly-plan-load-v1",
    estimated: true,
    provenance: "deterministic run-workout/v1 segment integration; actual session dates drive 7/42-day PMC projection",
    available,
    week_start: weekStart,
    initial_pmc_date: initialPmcDate,
    total_dose: totalDose === null ? null : round(totalDose),
    total_dose_low: totalDoseLow === null ? null : round(totalDoseLow),
    total_dose_high: totalDoseHigh === null ? null : round(totalDoseHigh),
    maximum_session_dose_share: totalDose && maxSessionDose !== null ? round(maxSessionDose / totalDose) : null,
    sessions: sessionReports,
    days,
    load_assumptions: unique(assumptions),
    missing_dose_reasons: unique(missingReasons),
    safety_issues: safetyIssues,
  });
}

function dailyDoses(
  sessions: z.input<typeof SessionSimulationSchema>[],
  weekStart: string,
  field: "estimated_dose" | "estimated_dose_low" | "estimated_dose_high",
): number[] {
  return Array.from({ length: 7 }, (_, index) => {
    const date = addDays(weekStart, index);
    return sessions.filter((session) => session.date === date).reduce((total, session) => total + (session[field] ?? 0), 0);
  });
}

function projectPmc(initialDate: string, weekStart: string, doses: number[], initial: { atl: number; ctl: number }) {
  const gapDays = dayDiff(initialDate, weekStart);
  if (gapDays < 0) throw new Error("weekly plan starts before the fitness-state snapshot");
  const beforePlan =
    gapDays > 1
      ? simulatePmcDays(
          Array.from({ length: gapDays - 1 }, () => 0),
          initial,
        ).at(-1)
      : null;
  return simulatePmcDays(doses, beforePlan ? { atl: beforePlan.atl, ctl: beforePlan.ctl } : initial);
}

function pmcSafetyIssues(days: z.input<typeof DailySimulationSchema>[], zeroLoadDays: Array<{ ratio: number | null }>): string[] {
  const candidateConsecutive = maximumConsecutiveOverreach(days);
  const zeroLoadConsecutive = maximumConsecutiveOverreach(zeroLoadDays);
  return candidateConsecutive >= 3 && candidateConsecutive > zeroLoadConsecutive ? ["planned_load_extends_overreach_more_than_1_25_to_3_consecutive_days"] : [];
}

function maximumConsecutiveOverreach(days: Array<{ load_ratio?: number | null; ratio?: number | null }>): number {
  let consecutiveOverreach = 0;
  let maximumConsecutive = 0;
  for (const day of days) {
    const ratio = day.load_ratio ?? day.ratio ?? null;
    if (ratio !== null && ratio > 1.25) {
      consecutiveOverreach += 1;
      maximumConsecutive = Math.max(maximumConsecutive, consecutiveOverreach);
    } else {
      consecutiveOverreach = 0;
    }
  }
  return maximumConsecutive;
}

function materiallyDifferent(declared: number, estimated: number): boolean {
  return Math.abs(declared - estimated) > Math.max(0.5, declared * 0.05);
}

function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function round(value: number): number {
  return Number(value.toFixed(4));
}
