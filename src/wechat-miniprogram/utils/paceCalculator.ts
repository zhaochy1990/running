import type { PaceRaceTemplate } from '../services/pace-calculator';
import { formatDuration, formatPace, parseDuration, parsePaceSPerKm } from './raceStrategyRows';

export const MAX_SEGMENTS = 10;
export const MARATHON_KM = 42.195;
export const HALF_MARATHON_KM = 21.0975;
const STANDARD_POINTS = [1, 5, 10, 15, 20, HALF_MARATHON_KM, 25, 30, 35, 40, MARATHON_KM];

export type QuickMode = 'pace' | 'time' | 'distance';

export interface PaceSegment {
  end: string;
  pace: string;
  note?: string;
}

export type Calculation =
  | { mode: QuickMode; distance: string; time: string; pace: string }
  | { mode: 'segment'; segments: PaceSegment[] };

interface Split {
  end: number;
  label: string;
  pace: string;
  time: string;
  cumulative: string;
  note?: string;
}

export interface PaceResult {
  distance: string;
  time: string;
  pace: string;
  speed: string;
  rows: Split[];
  checkpoints: Split[];
  kilometers: Split[];
}

type Result = { result: PaceResult } | { error: string };
type Leg = { end: number; pace: number; note?: string };

export function parseDistance(value: string): number | null {
  if (!/^\d{1,3}(?:\.\d{1,6})?$/.test(value.trim())) return null;
  const km = Number(value);
  return km >= 0.001 && km <= 100 ? km : null;
}

function distanceLabel(km: number): string {
  return km >= 1 ? `${Number(km.toFixed(6))} km` : `${Number((km * 1000).toFixed(1))} m`;
}

function splitsAt(legs: Leg[], points: number[], distance: number): Split[] {
  let previousDistance = 0;
  let previousSeconds = 0;
  return points.map((end) => {
    let start = 0;
    let cumulativeSeconds = 0;
    for (const leg of legs) {
      cumulativeSeconds += Math.max(0, Math.min(end, leg.end) - start) * leg.pace;
      start = leg.end;
    }
    const legSeconds = cumulativeSeconds - previousSeconds;
    const row = {
      end,
      label: end === distance ? '终点' : end === HALF_MARATHON_KM ? '半程' : distanceLabel(end),
      pace: formatPace(Math.round(legSeconds / (end - previousDistance))),
      time: formatDuration(Math.round(cumulativeSeconds) - Math.round(previousSeconds)),
      cumulative: formatDuration(Math.round(cumulativeSeconds)),
    };
    previousDistance = end;
    previousSeconds = cumulativeSeconds;
    return row;
  });
}

function checkpointDistances(distance: number, segmented: boolean): number[] {
  let points = STANDARD_POINTS;
  if (segmented) {
    points = distance < 10
      ? Array.from({ length: Math.floor(distance) }, (_, i) => i + 1)
      : STANDARD_POINTS.filter((point) => point !== 1 && (distance >= MARATHON_KM || point !== HALF_MARATHON_KM));
  }
  return [...points.filter((point) => point < distance), distance];
}

function summarize(legs: Leg[], calculation: Calculation): PaceResult {
  const distance = legs[legs.length - 1].end;
  const segmented = calculation.mode === 'segment';
  const checkpoints = splitsAt(legs, checkpointDistances(distance, segmented), distance);
  const kilometers = segmented
    ? splitsAt(legs, [...Array.from({ length: Math.ceil(distance) - 1 }, (_, i) => i + 1), distance], distance)
    : [];
  const rows = segmented
    ? splitsAt(legs, legs.map((leg) => leg.end), distance).map((row, i) => ({
      ...row,
      label: `${i === 0 ? 0 : legs[i - 1].end}–${row.end} km`,
      note: legs[i].note || '',
    }))
    : [];
  const seconds = legs.reduce((sum, leg, i) => sum + (leg.end - (legs[i - 1]?.end ?? 0)) * leg.pace, 0);
  return {
    distance: distanceLabel(distance),
    time: formatDuration(Math.round(seconds)),
    pace: formatPace(Math.round(seconds / distance)),
    speed: `${(distance * 3600 / seconds).toFixed(2)} km/h`,
    rows,
    checkpoints,
    kilometers,
  };
}

export function calculate(calc: Calculation): Result {
  if (calc.mode === 'segment') {
    if (!calc.segments.length || calc.segments.length > MAX_SEGMENTS) return { error: '请输入 1 至 10 个分段' };
    const legs: Leg[] = [];
    for (const [i, segment] of calc.segments.entries()) {
      const end = parseDistance(segment.end);
      const pace = parsePaceSPerKm(segment.pace);
      if (end === null || end <= (legs[i - 1]?.end ?? 0)) return { error: `第 ${i + 1} 段终点须大于起点，且最多 100 km` };
      if (pace === null) return { error: `请输入第 ${i + 1} 段的配速，例如 5:00` };
      legs.push({ end, pace, note: segment.note });
    }
    return { result: summarize(legs, calc) };
  }

  const distance = parseDistance(calc.distance);
  const time = parseCalculatorTime(calc.time);
  const pace = parsePaceSPerKm(calc.pace);
  if (calc.mode !== 'distance' && distance === null) return { error: '请输入 0.001 至 100 km 的距离' };
  if (calc.mode !== 'time' && time === null) return { error: '请输入有效用时，例如 3:30:00' };
  if (calc.mode !== 'pace' && pace === null) return { error: '请输入有效配速，例如 5:00' };

  // Each mode validates its two inputs above.
  let leg: Leg;
  if (calc.mode === 'pace' && distance !== null && time !== null) {
    leg = { end: distance, pace: time / distance };
  } else if (calc.mode === 'time' && distance !== null && pace !== null) {
    leg = { end: distance, pace };
  } else if (time !== null && pace !== null) {
    leg = { end: time / pace, pace };
  } else {
    return { error: '请输入有效的距离、用时或配速' };
  }
  return { result: summarize([leg], calc) };
}

export function applyRaceTemplate(template: PaceRaceTemplate, target: string): PaceSegment[] | null {
  const seconds = parseCalculatorTime(target);
  if (seconds === null || seconds < 7200 || seconds > 28800) return null;
  const weightedDelta = template.segments.reduce(
    (sum, segment) => sum + (segment.end_km - segment.start_km) * segment.pace_delta_seconds,
    0,
  );
  const basePace = (seconds - weightedDelta) / template.distance_km;
  const options = template.segments.map((segment) => {
    const pace = basePace + segment.pace_delta_seconds;
    return { pace, distance: segment.end_km - segment.start_km };
  });
  if (options.some(({ pace }) => pace < 1 || pace > 5999)) return null;

  // Each leg can round up or down to a whole second per kilometer. Choose the
  // combination closest to the target, favoring the smallest pace changes on ties.
  let best: number[] = [];
  let bestTimeError = Infinity;
  let bestPaceError = Infinity;
  for (let mask = 0; mask < 2 ** options.length; mask++) {
    const paces = options.map(({ pace }, i) => (mask & (1 << i)) ? Math.ceil(pace) : Math.floor(pace));
    const total = options.reduce((sum, { distance }, i) => sum + distance * paces[i], 0);
    const timeError = Math.abs(Math.round(total) - seconds);
    const paceError = options.reduce((sum, { pace }, i) => sum + (pace - paces[i]) ** 2, 0);
    if (timeError < bestTimeError || (timeError === bestTimeError && paceError < bestPaceError)) {
      best = paces;
      bestTimeError = timeError;
      bestPaceError = paceError;
    }
  }
  return template.segments.map((segment, i) => ({
    end: String(segment.end_km),
    pace: formatPace(best[i]).replace('/km', ''),
    note: segment.note,
  }));
}

// Share only the inputs. Receivers recompute all tables even without a network connection.
export function encodeCalculation(calc: Calculation): string {
  const fields = calc.mode === 'segment'
    ? calc.segments.flatMap(({ end, pace }) => [Number(end), parsePaceSPerKm(pace)])
    : [
      calc.mode === 'distance' ? '' : Number(calc.distance),
      calc.mode === 'time' ? '' : parseCalculatorTime(calc.time),
      calc.mode === 'pace' ? '' : parsePaceSPerKm(calc.pace),
    ];
  return ['1', calc.mode, ...fields].join('~');
}

export function decodeCalculation(input: string): Calculation | null {
  if (input.length > 220) return null;
  const [version, mode, ...fields] = input.split('~');
  if (version !== '1') return null;
  if (mode === 'segment') {
    if (!fields.length || fields.length % 2 !== 0 || fields.length > MAX_SEGMENTS * 2) return null;
    const segments: PaceSegment[] = [];
    for (let i = 0; i < fields.length; i += 2) {
      segments.push({ end: fields[i], pace: sharedPace(fields[i + 1]) });
    }
    return { mode, segments };
  }
  if (mode !== 'pace' && mode !== 'time' && mode !== 'distance') return null;
  if (fields.length !== 3) return null;
  const [distance, seconds, pace] = fields;
  const time = /^\d{1,6}$/.test(seconds) ? inputDuration(Number(seconds)) : '';
  return { mode, distance, time, pace: sharedPace(pace) };
}

function parseCalculatorTime(value: string): number | null {
  const time = value.trim();
  return parseDuration(time.split(':').length === 2 ? `${time}:00` : time);
}

function inputDuration(seconds: number): string {
  const formatted = formatDuration(seconds);
  return seconds < 3600 ? `0:${formatted}` : formatted;
}

function sharedPace(seconds: string): string {
  return /^\d{1,4}$/.test(seconds) ? formatPace(Number(seconds)).replace('/km', '') : '';
}
