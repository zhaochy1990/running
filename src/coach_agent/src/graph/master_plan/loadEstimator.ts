import type { MasterPlan } from "@stride/contract";
import { estimatePlannedRunLoad } from "../training_load/plannedRunLoad.js";

type Week = MasterPlan["weeks"][number];
type KeySession = Week["key_sessions"][number];
type Goal = MasterPlan["goal"];
type PaceZoneName = "recovery" | "easy" | "marathon" | "threshold" | "interval";
type RequiredPaceZoneName = Exclude<PaceZoneName, "recovery">;
type PaceZoneInput = {
  name?: unknown;
  minPaceSPerKm?: unknown;
  maxPaceSPerKm?: unknown;
  min_pace_s_per_km?: unknown;
  max_pace_s_per_km?: unknown;
};
type IntensityRange = {
  low: number;
  high: number;
  assumptions: string[];
};
type SessionEstimate = {
  expectedDose: number;
  lowDose: number;
  highDose: number;
  estimatedDistanceKm: number;
  estimatedDurationMin?: number;
  assumptions?: string[];
  unestimatedSteps?: number;
};

export interface MasterPlanWeekLoadEstimate {
  expectedDose: number | null;
  lowDose: number | null;
  highDose: number | null;
  keySessionKm: number;
  remainingEasyKmLow: number;
  remainingEasyKm: number;
  longRunDose: number | null;
  longRunDoseShare: number | null;
  assumptions: string[];
  unavailableReason: string | null;
}

type PaceZoneRanges = Record<RequiredPaceZoneName, readonly [number, number]> & Partial<Record<"recovery", readonly [number, number]>>;

const RACE_DISTANCE_KM = { FM: 42.195, HM: 21.0975 } as const;
// The persisted recovery zone is open-ended below. Match the canonical Python
// master-plan approximation when converting that open boundary to an IF range.
const OPEN_RECOVERY_ZONE_IF_FLOOR = 0.5;

/**
 * Estimate one strategic master-plan week on the canonical Python TSS scale.
 *
 * Structured key sessions use the canonical run-workout/v1 blocks and the
 * Python planned-load algorithm: every active segment is integrated with the
 * sixth-power normalized IF, repeated blocks are expanded, active recovery is
 * included, and passive rest is excluded. Legacy key sessions retain the
 * earlier pace-zone approximation and expose that fallback as an assumption.
 */
export function estimateMasterPlanWeekLoad(
  week: Week,
  goal: Goal,
  thresholdSpeedMps: number | null | undefined,
  paceZones: readonly unknown[] = [],
  thresholdHr?: number | null,
  rhr?: number | null,
): MasterPlanWeekLoadEstimate {
  if (!thresholdSpeedMps || thresholdSpeedMps <= 0)
    return {
      expectedDose: null,
      lowDose: null,
      highDose: null,
      keySessionKm: 0,
      remainingEasyKmLow: 0,
      remainingEasyKm: 0,
      longRunDose: null,
      longRunDoseShare: null,
      assumptions: [],
      unavailableReason: "threshold_speed_calibration_missing",
    };

  const zoneRanges = resolvePaceZoneRanges(paceZones, thresholdSpeedMps);
  if (!zoneRanges)
    return {
      expectedDose: null,
      lowDose: null,
      highDose: null,
      keySessionKm: 0,
      remainingEasyKmLow: 0,
      remainingEasyKm: 0,
      longRunDose: null,
      longRunDoseShare: null,
      assumptions: [],
      unavailableReason: "pace_zone_calibration_missing",
    };
  const goalRaceIf = raceIntensityFactor(goal, thresholdSpeedMps);
  let keySessionKm = 0;
  let expectedKeyDose = 0;
  let lowKeyDose = 0;
  let highKeyDose = 0;
  let longRunDose = 0;
  let computable = true;
  const assumptions: string[] = [];
  const embedded: Array<{ session: KeySession; intensity: IntensityRange }> = [];

  for (const session of week.key_sessions) {
    if (session.type === "strength_key") continue;
    if (session.workout_structure) {
      const estimate = estimatePlannedRunLoad(session.workout_structure, thresholdSpeedMps, thresholdHr, rhr);
      if (!estimate) {
        computable = false;
        continue;
      }

      assumptions.push("structured_workout_segments_integrated", ...(estimate.assumptions ?? []));
      if ((estimate.unestimatedSteps ?? 0) > 0) assumptions.push("structured_workout_partial_coverage");
      if (session.distance_km && differsMaterially(session.distance_km, estimate.estimatedDistanceKm))
        assumptions.push("structured_distance_differs_from_declared_total");
      if (session.duration_min && estimate.estimatedDurationMin && differsMaterially(session.duration_min, estimate.estimatedDurationMin))
        assumptions.push("structured_duration_differs_from_declared_total");
      expectedKeyDose += estimate.expectedDose;
      lowKeyDose += estimate.lowDose;
      highKeyDose += estimate.highDose;
      keySessionKm += Math.max(0, estimate.estimatedDistanceKm);
      if (session.type === "long_run") longRunDose = Math.max(longRunDose, estimate.expectedDose);
      continue;
    }

    assumptions.push("legacy_unstructured_session_approximation");
    if (["race_pace", "threshold", "tempo"].includes(session.type) && isEmbeddedSession(session)) {
      const intensity = sessionIntensityRange(session, goal, goalRaceIf, zoneRanges);
      if (intensity) embedded.push({ session, intensity });
      assumptions.push(`${session.type}_embedded_in_parent_not_double_counted`);
      continue;
    }

    const intensity = sessionIntensityRange(session, goal, goalRaceIf, zoneRanges);
    const estimate = intensity && hasPositiveExtent(session) ? estimateSession(session, intensity, thresholdSpeedMps) : null;
    if (!intensity || !estimate) {
      computable = false;
      continue;
    }

    assumptions.push(...intensity.assumptions);
    expectedKeyDose += estimate.expectedDose;
    lowKeyDose += estimate.lowDose;
    highKeyDose += estimate.highDose;
    keySessionKm += Math.max(0, session.distance_km ?? estimate.estimatedDistanceKm);
    if (session.type === "long_run") longRunDose = Math.max(longRunDose, estimate.expectedDose);
  }

  if (embedded.length > 0 && computable) {
    const parent = week.key_sessions.find((session) => session.type === "long_run" && hasPositiveExtent(session));
    if (parent) {
      const parentIntensity = sessionIntensityRange(parent, goal, goalRaceIf, zoneRanges);
      if (parentIntensity) {
        const replacement = estimateEmbeddedParent(parent, parentIntensity, embedded, thresholdSpeedMps);
        if (replacement) {
          expectedKeyDose += replacement.estimate.expectedDose - replacement.original.expectedDose;
          lowKeyDose += replacement.estimate.lowDose - replacement.original.lowDose;
          highKeyDose += replacement.estimate.highDose - replacement.original.highDose;
          longRunDose = Math.max(longRunDose, replacement.estimate.expectedDose);
          assumptions.push(replacement.assumption);
        }
      }
    }
  }

  const remainingEasyKmLow = Math.max(0, week.target_weekly_km_low - keySessionKm);
  const remainingEasyKm = Math.max(0, week.target_weekly_km_high - keySessionKm);
  let lowEasyLower = 0;
  let highEasyExpected = 0;
  let highEasyUpper = 0;
  if (computable && (remainingEasyKmLow > 0 || remainingEasyKm > 0)) {
    const easy = intensityRange(zoneRanges, "easy", ["remaining_weekly_distance_in_easy_zone"]);
    if (remainingEasyKmLow > 0) {
      const estimate = estimateDistance(remainingEasyKmLow, easy, thresholdSpeedMps);
      lowEasyLower = estimate.lowDose;
    }
    if (remainingEasyKm > 0) {
      const estimate = estimateDistance(remainingEasyKm, easy, thresholdSpeedMps);
      highEasyExpected = estimate.expectedDose;
      highEasyUpper = estimate.highDose;
    }
    assumptions.push(...easy.assumptions);
  }

  if (!computable)
    return {
      expectedDose: null,
      lowDose: null,
      highDose: null,
      keySessionKm: round(keySessionKm, 1),
      remainingEasyKmLow: round(remainingEasyKmLow, 1),
      remainingEasyKm: round(remainingEasyKm, 1),
      longRunDose: null,
      longRunDoseShare: null,
      assumptions: unique(assumptions),
      unavailableReason: "planned_session_uncomputable",
    };

  const expectedDose = expectedKeyDose + highEasyExpected;
  const lowDose = lowKeyDose + lowEasyLower;
  const highDose = highKeyDose + highEasyUpper;
  return {
    expectedDose: round(expectedDose, 1),
    lowDose: round(lowDose, 1),
    highDose: round(highDose, 1),
    keySessionKm: round(keySessionKm, 1),
    remainingEasyKmLow: round(remainingEasyKmLow, 1),
    remainingEasyKm: round(remainingEasyKm, 1),
    longRunDose: round(longRunDose, 1),
    longRunDoseShare: expectedDose > 0 ? round(longRunDose / expectedDose, 4) : null,
    assumptions: unique(assumptions),
    unavailableReason: null,
  };
}

function differsMaterially(declared: number, estimated: number): boolean {
  return Math.abs(declared - estimated) > Math.max(0.5, declared * 0.05);
}

function sessionIntensityRange(session: KeySession, goal: Goal, goalRaceIf: number | null, zoneRanges: PaceZoneRanges): IntensityRange | null {
  const text = `${session.intensity ?? ""} ${session.purpose ?? ""}`.toLowerCase();
  for (const [token, zone] of [
    ["z1", "recovery"],
    ["z2", "easy"],
    ["z3", "marathon"],
    ["z4", "threshold"],
    ["z5", "interval"],
  ] as const)
    if (text.includes(token)) {
      const range = zoneRanges[zone];
      return range
        ? {
            low: range[0],
            high: range[1],
            assumptions: [`${token}_pace_zone_range`],
          }
        : null;
    }

  switch (session.type) {
    case "strength_key":
      return null;
    case "threshold":
      return intensityRange(zoneRanges, "threshold", ["threshold_zone_range"]);
    case "interval":
    case "vo2max":
    case "time_trial":
      return intensityRange(zoneRanges, "interval", [`${session.type}_zone_range`]);
    case "tempo":
      return {
        low: zoneRanges.marathon[0],
        high: zoneRanges.threshold[1],
        assumptions: ["tempo_marathon_to_threshold_range"],
      };
    case "hill":
      return intensityRange(zoneRanges, "threshold", ["hill_effort_flat_equivalent_range"]);
    case "race":
    case "race_pace": {
      if (goalRaceIf !== null)
        return {
          low: goalRaceIf,
          high: goalRaceIf,
          assumptions: ["goal_time_race_pace"],
        };
      return distanceOnlyRaceRange(RACE_DISTANCE_KM[goal.distance] ?? session.distance_km, "goal_race", zoneRanges);
    }
    case "tune_up_race": {
      if (!session.distance_km || session.distance_km <= 0) return null;
      if (session.duration_min && session.duration_min > 0)
        return {
          low: 0,
          high: 0,
          assumptions: ["tune_up_uses_own_distance_and_duration"],
        };
      return distanceOnlyRaceRange(session.distance_km, "tune_up", zoneRanges);
    }
    case "long_run": {
      if (hasRacePaceMarker(text)) {
        const distanceOnly = distanceOnlyRaceRange(RACE_DISTANCE_KM[goal.distance], "goal_race", zoneRanges);
        const raceLow = goalRaceIf ?? distanceOnly?.low;
        const raceHigh = goalRaceIf ?? distanceOnly?.high;
        if (raceLow === undefined || raceHigh === undefined) return null;
        return {
          low: Math.min(zoneRanges.easy[0], raceLow),
          high: Math.max(zoneRanges.easy[0], raceHigh),
          assumptions: [
            goalRaceIf === null ? "mp_fraction_unspecified_range_easy_to_distance_only_goal_pace" : "mp_fraction_unspecified_range_easy_to_goal_pace",
          ],
        };
      }
      return intensityRange(zoneRanges, "easy", ["long_run_easy_zone_range"]);
    }
  }
}

function estimateSession(session: KeySession, intensity: IntensityRange, thresholdSpeedMps: number): SessionEstimate | null {
  let resolved = intensity;
  if (intensity.low === 0 && intensity.high === 0 && session.distance_km && session.duration_min) {
    const ownIf = clamp((session.distance_km * 1000) / (session.duration_min * 60) / thresholdSpeedMps, 0, 2);
    resolved = { ...intensity, low: ownIf, high: ownIf };
  }
  if (session.distance_km && session.distance_km > 0) return estimateDistance(session.distance_km, resolved, thresholdSpeedMps);
  if (session.duration_min && session.duration_min > 0) return estimateDuration(session.duration_min, resolved, thresholdSpeedMps);
  return null;
}

function estimateDistance(distanceKm: number, intensity: IntensityRange, thresholdSpeedMps: number): SessionEstimate {
  const expectedIf = (intensity.low + intensity.high) / 2;
  return {
    expectedDose: round(distanceDose(distanceKm, expectedIf, thresholdSpeedMps), 4),
    lowDose: round(distanceDose(distanceKm, intensity.low, thresholdSpeedMps), 4),
    highDose: round(distanceDose(distanceKm, intensity.high, thresholdSpeedMps), 4),
    estimatedDistanceKm: round(distanceKm, 4),
  };
}

function estimateDuration(durationMin: number, intensity: IntensityRange, thresholdSpeedMps: number): SessionEstimate {
  const expectedIf = (intensity.low + intensity.high) / 2;
  return {
    expectedDose: round((durationMin / 60) * expectedIf ** 2 * 100, 4),
    lowDose: round((durationMin / 60) * intensity.low ** 2 * 100, 4),
    highDose: round((durationMin / 60) * intensity.high ** 2 * 100, 4),
    estimatedDistanceKm: round((durationMin * 60 * thresholdSpeedMps * expectedIf) / 1000, 4),
  };
}

function estimateEmbeddedParent(
  parent: KeySession,
  parentIntensity: IntensityRange,
  embedded: Array<{ session: KeySession; intensity: IntensityRange }>,
  thresholdSpeedMps: number,
): {
  estimate: SessionEstimate;
  original: SessionEstimate;
  assumption: string;
} | null {
  const original = estimateSession(parent, parentIntensity, thresholdSpeedMps);
  if (!original) return null;
  const exactByDistance = Boolean(parent.distance_km) && embedded.every(({ session }) => session.distance_km !== null);
  const exactByDuration = Boolean(parent.duration_min) && embedded.every(({ session }) => session.duration_min !== null);
  if (exactByDistance || exactByDuration) {
    const useDistance = exactByDistance;
    const parentAmount = useDistance ? (parent.distance_km ?? 0) : (parent.duration_min ?? 0);
    const embeddedAmount = embedded.reduce((sum, { session }) => sum + (useDistance ? (session.distance_km ?? 0) : (session.duration_min ?? 0)), 0);
    if (embeddedAmount > 0 && embeddedAmount <= parentAmount) {
      const pieces: SessionEstimate[] = [];
      const remainder = parentAmount - embeddedAmount;
      if (remainder > 0)
        pieces.push(
          useDistance ? estimateDistance(remainder, parentIntensity, thresholdSpeedMps) : estimateDuration(remainder, parentIntensity, thresholdSpeedMps),
        );
      for (const item of embedded)
        pieces.push(
          useDistance
            ? estimateDistance(item.session.distance_km ?? 0, item.intensity, thresholdSpeedMps)
            : estimateDuration(item.session.duration_min ?? 0, item.intensity, thresholdSpeedMps),
        );
      return {
        estimate: sumEstimates(pieces),
        original,
        assumption: `embedded_segments_integrated_by_${useDistance ? "distance" : "duration"}`,
      };
    }
  }

  const ranged = estimateSession(
    parent,
    {
      low: Math.min(parentIntensity.low, ...embedded.map(({ intensity }) => intensity.low)),
      high: Math.max(parentIntensity.high, ...embedded.map(({ intensity }) => intensity.high)),
      assumptions: [],
    },
    thresholdSpeedMps,
  );
  if (!ranged) return null;
  return {
    estimate: {
      expectedDose: original.expectedDose + Math.max(0, ranged.highDose - original.expectedDose) / 2,
      lowDose: ranged.lowDose,
      highDose: ranged.highDose,
      estimatedDistanceKm: original.estimatedDistanceKm,
    },
    original,
    assumption: "embedded_fraction_unknown_conservative_parent_range",
  };
}

function sumEstimates(estimates: SessionEstimate[]): SessionEstimate {
  return estimates.reduce(
    (sum, estimate) => ({
      expectedDose: sum.expectedDose + estimate.expectedDose,
      lowDose: sum.lowDose + estimate.lowDose,
      highDose: sum.highDose + estimate.highDose,
      estimatedDistanceKm: sum.estimatedDistanceKm + estimate.estimatedDistanceKm,
    }),
    { expectedDose: 0, lowDose: 0, highDose: 0, estimatedDistanceKm: 0 },
  );
}

function distanceDose(distanceKm: number, intensity: number, thresholdSpeedMps: number): number {
  if (intensity <= 0) return 0;
  const hours = (distanceKm * 1000) / (thresholdSpeedMps * intensity) / 3600;
  return hours * intensity ** 2 * 100;
}

function intensityRange(ranges: PaceZoneRanges, zone: RequiredPaceZoneName, assumptions: string[]): IntensityRange {
  const [low, high] = ranges[zone];
  return { low, high, assumptions };
}

function resolvePaceZoneRanges(paceZones: readonly unknown[], thresholdSpeedMps: number): PaceZoneRanges | null {
  const resolved: Partial<Record<PaceZoneName, readonly [number, number]>> = {};
  const supported: PaceZoneName[] = ["recovery", "easy", "marathon", "threshold", "interval"];
  const required: RequiredPaceZoneName[] = ["easy", "marathon", "threshold", "interval"];
  const zones = paceZones.filter(isPaceZoneInput);
  for (const name of supported) {
    const zone = zones.find((item) => item.name === name);
    if (!zone) continue;
    const minPace = positiveNumber(zone.minPaceSPerKm ?? zone.min_pace_s_per_km);
    const maxPace = positiveNumber(zone.maxPaceSPerKm ?? zone.max_pace_s_per_km);
    const low = maxPace === null ? (name === "recovery" ? OPEN_RECOVERY_ZONE_IF_FLOOR : null) : 1000 / maxPace / thresholdSpeedMps;
    const high = minPace === null ? null : 1000 / minPace / thresholdSpeedMps;
    if (low === null || high === null || low <= 0 || high < low) continue;
    resolved[name] = [low, high];
  }
  return required.every((name) => resolved[name]) ? (resolved as PaceZoneRanges) : null;
}

function isPaceZoneInput(value: unknown): value is PaceZoneInput {
  return typeof value === "object" && value !== null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function distanceOnlyRaceRange(distanceKm: number | null | undefined, prefix: "goal_race" | "tune_up", zoneRanges: PaceZoneRanges): IntensityRange | null {
  if (!distanceKm || distanceKm <= 0) return null;
  if (distanceKm <= 7.5) return intensityRange(zoneRanges, "interval", [`${prefix}_distance_only_short_race_interval_range`]);
  if (distanceKm <= 15) return intensityRange(zoneRanges, "threshold", [`${prefix}_distance_only_10k_threshold_range`]);
  if (distanceKm <= 30)
    return {
      low: zoneRanges.marathon[0],
      high: zoneRanges.threshold[1],
      assumptions: [`${prefix}_distance_only_hm_marathon_to_threshold_range`],
    };
  return intensityRange(zoneRanges, "marathon", [`${prefix}_distance_only_long_race_marathon_range`]);
}

function raceIntensityFactor(goal: Goal, thresholdSpeedMps: number): number | null {
  const seconds = parseTimeSeconds(goal.target_time);
  if (!seconds) return null;
  return clamp((RACE_DISTANCE_KM[goal.distance] * 1000) / seconds / thresholdSpeedMps, 0, 2);
}

function parseTimeSeconds(value: string): number | null {
  const parts = value.trim().split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    if (hours === undefined || minutes === undefined || seconds === undefined) return null;
    if (hours < 0 || minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60) return null;
    return hours * 3600 + minutes * 60 + seconds || null;
  }
  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    if (minutes === undefined || seconds === undefined) return null;
    if (minutes < 0 || seconds < 0 || seconds >= 60) return null;
    return minutes * 60 + seconds || null;
  }
  return null;
}

function hasRacePaceMarker(text: string): boolean {
  if (["race pace", "marathon pace", "half marathon pace", "比赛配速", "马拉松配速", "半马配速", "马配", "半马配"].some((phrase) => text.includes(phrase)))
    return true;
  return /(?<![a-z])(?:hmp|mp|rp)(?![a-z])/i.test(text);
}

function isEmbeddedSession(session: KeySession): boolean {
  const text = `${session.intensity ?? ""} ${session.purpose ?? ""}`.toLowerCase();
  return ["embedded", "within long", "inside long", "part of long", "其中", "内含", "长跑内"].some((token) => text.includes(token));
}

function hasPositiveExtent(session: KeySession): boolean {
  return Boolean((session.distance_km && session.distance_km > 0) || (session.duration_min && session.duration_min > 0));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}
