import type { MasterPlanGraphRequest } from "@stride/contract";
import {
  addDays,
  type MasterPlan,
  MasterPlanSchema,
  mondayOnOrBefore as monday,
  type RuleReport,
  RuleReportSchema,
  type RuleSeverity,
  type RuleViolation,
  RuleViolationSchema,
} from "@stride/contract";
import type { ContextSnapshot } from "./context.js";

export type { RuleReport, RuleSeverity, RuleViolation } from "@stride/contract";
export {
  RuleReportSchema,
  RuleViolationSchema,
} from "@stride/contract";

const RULE_IDS = [
  "schema_validity",
  "natural_week_sequence",
  "phase_timeline_coverage",
  "week_phase_alignment",
  "volume_range_consistency",
  "load_week_ramp",
  "recovery_cadence",
  "taper_volume_drop",
  "hard_stimulus_density",
  "long_run_share",
  "race_week_volume",
  "availability_constraints",
] as const;
const HARD = new Set(["threshold", "tempo", "interval", "vo2max", "hill", "race_pace", "time_trial", "tune_up_race", "race"]);
const TAPER = "taper";

export function runMasterPlanRuleFilter(rawPlan: unknown, rawRequest: MasterPlanGraphRequest, snapshot: ContextSnapshot): RuleReport {
  const violations: RuleViolation[] = [];
  const add = (rule_id: string, severity: RuleSeverity, message: string, evidence: Record<string, unknown>, suggested_fix: string) =>
    violations.push({ rule_id, severity, message, evidence, suggested_fix });
  const parsed = MasterPlanSchema.safeParse(rawPlan);
  if (!parsed.success) {
    add(
      "schema_validity",
      "error",
      "Master Plan does not satisfy MasterPlanSchema",
      {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      "Emit a complete schema-valid Master Plan artifact",
    );
    return report(violations);
  }
  const plan = parsed.data;
  const request = rawRequest;
  if (plan.weeks[0]!.week_start !== monday(plan.start_date))
    add(
      "natural_week_sequence",
      "error",
      "First active week must contain plan start and begin Monday",
      { plan_start: plan.start_date, first_week: plan.weeks[0]!.week_start },
      "Anchor weeks to the plan-start natural week",
    );
  for (const [i, week] of plan.weeks.entries())
    if (
      !validDay(week.week_start) ||
      week.week_index !== i + 1 ||
      week.week_start !== addDays(plan.weeks[0]!.week_start, i * 7) ||
      new Date(`${week.week_start}T00:00:00Z`).getUTCDay() !== 1
    )
      add(
        "natural_week_sequence",
        "error",
        "Weeks must be valid consecutive Mondays with consecutive indices",
        { week_index: week.week_index, week_start: week.week_start },
        "Realign active weeks from the first Monday",
      );
  if (plan.phases[0]!.start_date !== plan.start_date || plan.phases.at(-1)!.end_date !== plan.end_date)
    add(
      "phase_timeline_coverage",
      "error",
      "Phases must cover the full plan window",
      { plan_start: plan.start_date, plan_end: plan.end_date },
      "Extend phase boundaries to the plan boundaries",
    );
  for (let i = 1; i < plan.phases.length; i += 1)
    if (plan.phases[i]!.start_date !== addDays(plan.phases[i - 1]!.end_date, 1))
      add(
        "phase_timeline_coverage",
        "error",
        "Phases contain a gap or overlap",
        {
          previous: plan.phases[i - 1]!.end_date,
          current: plan.phases[i]!.start_date,
        },
        "Make adjacent phase dates continuous",
      );
  for (const week of plan.weeks) {
    const phase = plan.phases.find((p) => p.name === week.phase_name);
    if (!phase || week.week_start < phase.start_date || addDays(week.week_start, 6) > phase.end_date)
      add(
        "week_phase_alignment",
        "error",
        "Natural week is not fully contained by its named phase",
        {
          week_index: week.week_index,
          week_start: week.week_start,
          week_end: addDays(week.week_start, 6),
          phase_name: week.phase_name,
        },
        "Align phase boundaries to complete natural weeks",
      );
    if (
      week.target_weekly_km_low > week.target_weekly_km_high ||
      !phase ||
      week.target_weekly_km_low < phase.weekly_distance_km_low ||
      week.target_weekly_km_high > phase.weekly_distance_km_high
    )
      add(
        "volume_range_consistency",
        "error",
        "Week volume range is invalid or outside its phase range",
        {
          week_index: week.week_index,
          weekly: [week.target_weekly_km_low, week.target_weekly_km_high],
          phase: phase ? [phase.weekly_distance_km_low, phase.weekly_distance_km_high] : null,
        },
        "Keep low ≤ high and fit the phase range",
      );
  }
  let anchor: MasterPlan["weeks"][number] | undefined;
  let loadStreak = 0;
  for (const week of plan.weeks) {
    const exception = week.is_recovery_week || week.phase_name === TAPER || week.phase_name === "recovery";
    if (!exception) {
      if (anchor && week.target_weekly_km_high > anchor.target_weekly_km_high * 1.1 + 1e-9)
        add(
          "load_week_ramp",
          "error",
          "Load-week high increases by more than 10%",
          {
            anchor_week: anchor.week_index,
            week_index: week.week_index,
            anchor_high: anchor.target_weekly_km_high,
            high: week.target_weekly_km_high,
          },
          "Reduce the load-week high to at most 110% of the prior load anchor",
        );
      anchor = week;
      loadStreak += 1;
      if (loadStreak >= 4)
        add(
          "recovery_cadence",
          "warning",
          "Four consecutive non-recovery load weeks occur before taper",
          {
            ending_week_index: week.week_index,
            consecutive_load_weeks: loadStreak,
          },
          "Add a recovery week or document the reviewer-approved exception",
        );
    } else if (week.is_recovery_week) loadStreak = 0;
    if (week.phase_name === TAPER) loadStreak = 0;
  }
  const taper = plan.weeks.find((w) => w.phase_name === TAPER);
  const preTaper = taper ? plan.weeks.filter((w) => w.week_start < taper.week_start && !w.is_recovery_week) : [];
  if (taper && preTaper.length) {
    const peak = Math.max(...preTaper.map((w) => w.target_weekly_km_high));
    if (taper.target_weekly_km_high > peak * 0.75 + 1)
      add(
        "taper_volume_drop",
        "error",
        "First taper week is not at least 25% below the highest pre-taper load week",
        {
          peak_high: peak,
          taper_high: taper.target_weekly_km_high,
          allowed_high: peak * 0.75 + 1,
        },
        "Lower first taper high to peak × 75% + 1km or less",
      );
  }
  const share = request.availability.weekly_run_days_max <= 3 ? 0.5 : 0.35;
  for (const week of plan.weeks) {
    const hard = week.key_sessions.filter(
      (s) => HARD.has(s.type) || (s.type === "long_run" && positiveRacePace(`${s.intensity ?? ""} ${s.purpose ?? ""}`)),
    ).length;
    if (hard > 2)
      add(
        "hard_stimulus_density",
        "error",
        "Week contains more than two hard running stimuli",
        { week_index: week.week_index, hard_stimuli: hard },
        "Retain at most two hard stimuli; keep embedded MP as one long run",
      );
    const longest = Math.max(0, ...week.key_sessions.filter((s) => s.type === "long_run").map((s) => s.distance_km ?? 0));
    if (longest > week.target_weekly_km_high * share + 1)
      add(
        "long_run_share",
        "error",
        "Long run exceeds the allowed weekly-volume share",
        {
          week_index: week.week_index,
          long_run_km: longest,
          weekly_high: week.target_weekly_km_high,
          modifier: share === 0.5 ? "frequency_limited" : "default",
        },
        `Reduce long run to weekly high × ${share} + 1km or less`,
      );
    const race = week.key_sessions.find((s) => s.type === "race");
    const raceDistance = plan.goal.distance === "FM" ? 42.195 : 21.0975;
    if (race && week.target_weekly_km_high + 1e-9 < raceDistance)
      add(
        "race_week_volume",
        "error",
        "Race-week volume high does not include target race distance",
        {
          week_index: week.week_index,
          race_distance_km: raceDistance,
          weekly_high: week.target_weekly_km_high,
        },
        "Set race-week high to at least the target race distance",
      );
    const runningSessions = week.key_sessions.filter((session) => session.type !== "strength_key").length;
    if (runningSessions > request.availability.weekly_run_days_max)
      add(
        "availability_constraints",
        "error",
        "Running key-session count exceeds weekly run-day availability",
        {
          week_index: week.week_index,
          running_key_sessions: runningSessions,
          weekly_run_days_max: request.availability.weekly_run_days_max,
        },
        "Reduce running key sessions or explicitly revise availability",
      );
    for (const [sessionIndex, session] of week.key_sessions.entries()) {
      let duration = session.duration_min;
      if (duration === null && session.distance_km !== null) {
        const pace = conservativePace(session.type, snapshot);
        if (pace !== null) duration = (session.distance_km * pace) / 60;
        else
          add(
            "availability_duration_unverifiable",
            "warning",
            "Session duration cannot be checked without duration or running calibration",
            {
              week_index: week.week_index,
              session_index: sessionIndex,
              distance_km: session.distance_km,
            },
            "Provide duration_min or a usable threshold-speed calibration",
          );
      }
      if (duration === null && session.distance_km === null)
        add(
          "availability_duration_unverifiable",
          "warning",
          "Session duration cannot be checked without duration or distance",
          { week_index: week.week_index, session_index: sessionIndex },
          "Provide duration_min or distance_km",
        );
      if (duration !== null && duration > request.availability.max_session_duration_min)
        add(
          "availability_constraints",
          "error",
          "Key session exceeds maximum session duration",
          {
            week_index: week.week_index,
            session_index: sessionIndex,
            estimated_duration_min: Number(duration.toFixed(1)),
            max_session_duration_min: request.availability.max_session_duration_min,
            provenance: session.duration_min === null ? "threshold_speed_conservative_slow_edge" : "explicit_duration",
          },
          "Shorten or split the session within confirmed constraints",
        );
    }
  }
  return report(violations);
}

function report(violations: RuleViolation[]): RuleReport {
  return RuleReportSchema.parse({
    authority: "typescript-master-plan-rule-filter-v1",
    checked_rule_ids: [...RULE_IDS],
    violations,
    has_errors: violations.some((v) => v.severity === "error"),
  });
}
function positiveRacePace(text: string): boolean {
  const marker = /(?:\bMP\b|\bHMP\b|\bRP\b|race[- ]?pace|target[- ]?pace|目标配速|比赛配速|马拉松配速|半马配速)/i;
  return (
    marker.test(text) &&
    !/(?:不|无|非|不含|没有|no|without|free)[^。；,;]{0,20}(?:MP|HMP|RP|race[- ]?pace|target[- ]?pace|目标配速|比赛配速|马拉松配速|半马配速)/i.test(text)
  );
}
function conservativePace(type: MasterPlan["weeks"][number]["key_sessions"][number]["type"], snapshot: ContextSnapshot): number | null {
  const calibration = snapshot.running_calibration;
  if (!calibration) return null;
  const zones = calibration.pace_zones as Array<{
    name?: string;
    maxPaceSPerKm?: number | null;
    max_pace_s_per_km?: number | null;
  }>;
  const wanted =
    type === "long_run"
      ? ["easy", "recovery"]
      : type === "threshold" || type === "tempo"
        ? ["threshold"]
        : type === "race" || type === "race_pace"
          ? ["marathon"]
          : ["interval", "threshold"];
  for (const name of wanted) {
    const zone = zones.find((item) => item.name === name);
    const pace = zone?.maxPaceSPerKm ?? zone?.max_pace_s_per_km;
    if (typeof pace === "number" && pace > 0) return pace;
  }
  const speed = calibration.threshold_speed_mps;
  return speed && speed > 0 ? 1000 / (speed * (type === "long_run" ? 0.7 : HARD.has(type) ? 0.85 : 0.75)) : null;
}
function validDay(day: string): boolean {
  const date = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === day;
}
