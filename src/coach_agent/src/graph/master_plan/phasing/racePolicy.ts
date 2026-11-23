import { RACE_DISTANCES_M } from "@stride/contract";
import { raceTimeSecFromVdot } from "./vdot.js";

export const HM_LONG_RUN_MAX_KM = 24;
export const HM_TAPER_LONG_RUN_MAX_KM = 15;
export const HM_SPECIFIC_MAX_KM = 10;

/** HM race weeks include Monday itself. Legacy FM calendar behavior is retained. */
export function runwayWeeks(monday: string, raceDate: string, distance: "FM" | "HM"): number {
  const days = (Date.parse(`${raceDate}T00:00:00Z`) - Date.parse(`${monday}T00:00:00Z`)) / 86400000;
  return distance === "HM" ? Math.floor(days / 7) + 1 : Math.ceil(days / 7);
}

export function halfMarathonTrainingPace(vdot: number, goalPace: number): number {
  return Math.max(goalPace, raceTimeSecFromVdot(RACE_DISTANCES_M.HM, vdot) / (RACE_DISTANCES_M.HM / 1000));
}

/** Race-day mileage is additional to the reduced pre-race training budget. */
export function halfMarathonDailyKm(weeklyKm: number, raceDate: string, daysMax = 7): number {
  const weekday = (new Date(`${raceDate}T00:00:00Z`).getUTCDay() + 6) % 7;
  const days = Math.min(weekday, Math.max(0, daysMax - 1));
  return weekday < 2 ? 0 : Math.min(weeklyKm * 0.25, days * 5);
}

/** Fallback quality work follows the phase's primary training stimulus. */
export function halfMarathonQualityType(phase: string, week: number, index = 0): "R" | "I" | "T" | "M" {
  if (phase === "early_quality") return "R";
  if (phase === "transition_quality") return week % 2 === 0 ? "I" : "T";
  return (week + index) % 2 === 0 ? "T" : "M";
}
