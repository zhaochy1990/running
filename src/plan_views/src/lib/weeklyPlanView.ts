import type { PlanDay, PlannedSession, RunWorkout, WeeklyActivity, WeeklyPlanContent, WorkoutStep } from "../types";

export function shanghaiToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year + "-" + values.month + "-" + values.day;
}

export function formatWeekRange(from: string, to: string): string {
  return formatDateShort(from) + " – " + formatDateShort(to);
}

export function formatDateShort(value: string): string {
  const [, month, day] = value.slice(0, 10).split("-");
  return month && day ? Number(month) + "月" + Number(day) + "日" : value;
}

export function weekdayCN(value: string): string {
  const date = new Date(value.slice(0, 10) + "T00:00:00Z");
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getUTCDay()] ?? "";
}

export function formatSessionLoad(session: PlannedSession): string {
  if (session.total_distance_m != null) return (session.total_distance_m / 1000).toFixed(1) + " km";
  if (session.total_duration_s != null) return Math.round(session.total_duration_s / 60) + " min";
  return "—";
}

export function formatEstimatedDose(session: PlannedSession): string | null {
  if (session.estimated_dose == null) return null;
  return "预计负荷 " + session.estimated_dose.toFixed(1) + " PMC";
}

export function sessionTarget(session: PlannedSession): string | null {
  if (!session.spec || session.spec.schema !== "run-workout/v1") return null;
  for (const block of session.spec.blocks) {
    for (const step of block.steps) {
      if (step.step_kind !== "work") continue;
      if (step.target.kind === "pace_s_km" && step.target.low != null && step.target.high != null) {
        return formatPace(step.target.high) + "–" + formatPace(step.target.low);
      }
      if (step.target.kind === "hr_bpm" && step.target.low != null && step.target.high != null) {
        return Math.round(step.target.low) + "–" + Math.round(step.target.high) + " bpm";
      }
      if (step.hr_cap_bpm != null) return "HR ≤" + Math.round(step.hr_cap_bpm);
    }
  }
  return null;
}

export function weeklyStats(days: PlanDay[]) {
  const sessions = days.flatMap((day) => day.sessions);
  return {
    sessions,
    plannedRunKm: sessions.filter((session) => session.kind === "run").reduce((total, session) => total + (session.total_distance_m ?? 0) / 1000, 0),
    runCount: sessions.filter((session) => session.kind === "run").length,
    strengthCount: sessions.filter((session) => session.kind === "strength").length,
    nutritionDays: days.filter((day) => day.nutrition != null).length,
    estimatedLoad: round1(sessions.reduce((total, session) => total + (session.estimated_dose ?? 0), 0)),
  };
}

export function actualRunKm(activities: WeeklyActivity[]): number {
  return activities.filter(isRun).reduce((total, activity) => total + activity.distance_km, 0);
}

export function strengthActivityStats(activities: WeeklyActivity[]) {
  const strength = activities.filter(isStrength);
  return {
    count: strength.length,
    durationS: strength.reduce((total, activity) => total + (activity.duration_s ?? 0), 0),
  };
}

export function formatDurationClock(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  return [Math.floor(safe / 3600), Math.floor((safe % 3600) / 60), safe % 60].map((value) => String(value).padStart(2, "0")).join(":");
}

export function intensityBreakdown(sessions: PlannedSession[]) {
  let low = 0;
  let mid = 0;
  let high = 0;
  for (const session of sessions.filter((item) => item.kind === "run")) {
    const km = (session.total_distance_m ?? 0) / 1000;
    const spec = session.spec?.schema === "run-workout/v1" ? session.spec : null;
    const quality = spec ? specQualityDistance(spec.blocks) : null;
    if (quality) {
      const totalQuality = quality.mid + quality.high;
      const scale = totalQuality > km && totalQuality > 0 ? km / totalQuality : 1;
      mid += quality.mid * scale;
      high += quality.high * scale;
      low += Math.max(0, km - totalQuality * scale);
      continue;
    }
    const tier = classifySession(session);
    if (tier === "high") high += km;
    else if (tier === "low") low += km;
    else mid += km;
  }
  return { low: round1(low), mid: round1(mid), high: round1(high) };
}

function specQualityDistance(blocks: RunWorkout["blocks"]) {
  let mid = 0;
  let high = 0;
  for (const block of blocks) {
    for (const step of block.steps) {
      if (step.step_kind !== "work") continue;
      let distanceKm: number | null = null;
      if (step.duration.kind === "distance_m" && step.duration.value != null) {
        distanceKm = step.duration.value / 1000;
      } else if (
        step.duration.kind === "time_s" &&
        step.duration.value != null &&
        step.target.kind === "pace_s_km" &&
        step.target.low != null &&
        step.target.high != null
      ) {
        distanceKm = step.duration.value / ((step.target.low + step.target.high) / 2);
      }
      if (distanceKm == null || distanceKm <= 0) continue;
      const distance = distanceKm * Math.max(1, block.repeat);
      const tier = classifyTarget(step.target);
      if (tier === "high") high += distance;
      else if (tier === "mid") mid += distance;
    }
  }
  return { mid, high };
}

function classifyTarget(target: WorkoutStep["target"]): "low" | "mid" | "high" {
  if (target.kind === "hr_bpm" && target.low != null && target.high != null) {
    const average = (target.low + target.high) / 2;
    return average < 155 ? "low" : average >= 160 ? "high" : "mid";
  }
  if (target.kind === "pace_s_km" && target.low != null && target.high != null) {
    const average = (target.low + target.high) / 2;
    return average > 270 ? "low" : average <= 250 ? "high" : "mid";
  }
  return "mid";
}

function classifySession(session: PlannedSession): "low" | "mid" | "high" {
  const text = session.summary + " " + (session.notes_md ?? "");
  const rpe = /RPE\s*(\d+(?:\.\d+)?)/i.exec(text);
  if (rpe) {
    const value = Number(rpe[1]);
    if (value <= 4) return "low";
    if (value >= 6) return "high";
  }
  if (/间歇|interval|冲刺|sprint|阈|threshold|vo2|高强度|5km配速|10km配速/i.test(text)) return "high";
  if (/恢复|recovery|轻松|easy|长距离|long run|base|有氧|aerobic|慢跑/i.test(text)) return "low";
  return "mid";
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function sportName(activity: WeeklyActivity): string {
  if (isRun(activity)) return "跑步";
  if (isStrength(activity)) return "力量训练";
  return activity.sport_name || "训练";
}

function isRun(activity: WeeklyActivity): boolean {
  return activity.sport_type === 100 || /run|treadmill|trail|track/i.test(activity.sport_name ?? "");
}

function isStrength(activity: WeeklyActivity): boolean {
  return [4, 402, 800].includes(activity.sport_type) || /strength/i.test(activity.sport_name ?? "");
}

function formatPace(seconds: number): string {
  const rounded = Math.round(seconds);
  return Math.floor(rounded / 60) + ":" + String(rounded % 60).padStart(2, "0") + "/km";
}

// Re-exported here so consumers can build the canonical PlanDay[] from a
// content_version: 2 WeeklyPlanContent without depending on the API layer.
export function buildPlanDays(plan: WeeklyPlanContent): PlanDay[] {
  const start = parseDate(plan.week_name.slice(0, 10));
  if (!start) return [];
  const nutritionByDate = new Map(plan.nutrition.map((item) => [item.date, item]));
  return Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + offset);
    const iso = date.toISOString().slice(0, 10);
    return {
      date: iso,
      sessions: plan.sessions.filter((session) => session.date === iso).sort((a, b) => a.session_index - b.session_index),
      nutrition: nutritionByDate.get(iso) ?? null,
    };
  });
}

function parseDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + "T00:00:00Z");
  return Number.isNaN(date.getTime()) ? null : date;
}
