import type { MasterPlanGraphRequest } from "@stride/contract";
import { type AssessmentFacts, AssessmentFactsSchema, addDays, type Fact, type GoalAssessment, type GoalClaim, shanghaiDay } from "@stride/contract";
import { median } from "../../utils/statistics.js";
import type { ContextSnapshot } from "./context.js";

export type {
  AssessmentFacts,
  GoalAssessment,
} from "@stride/contract";
export {
  AssessmentFactsSchema,
  GoalAssessmentSchema,
} from "@stride/contract";

export function deriveAssessmentFacts(snapshot: ContextSnapshot, request: MasterPlanGraphRequest): AssessmentFacts {
  const asOfDay = shanghaiDay(snapshot.as_of);
  const weeks = snapshot.recent_history.weeks.filter((week) => addDays(week.week_start, 6) < asOfDay);
  const recent = weeks.slice(-4);
  const stable = weeks.slice(Math.max(0, weeks.length - 8), Math.max(0, weeks.length - 4));
  const baseline = stable.length > 0 ? stable : weeks.slice(0, Math.max(0, weeks.length - recent.length));
  const goal = request.goals.find((candidate) => candidate.priority === "A")!;
  const matchingPb = snapshot.personal_bests.filter((pb) => normalizeDistance(pb.distance) === goal.distance).sort((a, b) => a.time_sec - b.time_sec)[0];
  const targetSeconds = goal.target_time === null ? null : parseDuration(goal.target_time);
  const statuses = snapshot.coverage.map((item) => item.status);
  const coverageRatio =
    statuses.length === 0 ? 0 : statuses.reduce((sum, status) => sum + (status === "complete" ? 1 : status === "partial" ? 0.5 : 0), 0) / statuses.length;
  const fact = (
    fact_id: string,
    value: Fact["value"],
    unit: string,
    source: string,
    confidence: "high" | "medium" | "low" | "unavailable" = value === null ? "unavailable" : "high",
  ) => ({ fact_id, value, unit, source, confidence });
  const maxGap = snapshot.macro_history.gap_periods.length === 0 ? 0 : Math.max(...snapshot.macro_history.gap_periods.map((gap) => gap.days));

  return AssessmentFactsSchema.parse({
    schema_version: 1,
    as_of: snapshot.as_of,
    facts: [
      fact(
        "volume.stable_weekly_km",
        median(baseline.map((week) => week.distance_km)),
        "km/week",
        "snapshot.recent_history.weeks",
        baseline.length >= 3 ? "high" : baseline.length > 0 ? "low" : "unavailable",
      ),
      fact(
        "volume.recent_weekly_km",
        median(recent.map((week) => week.distance_km)),
        "km/week",
        "snapshot.recent_history.weeks",
        recent.length >= 3 ? "high" : recent.length > 0 ? "low" : "unavailable",
      ),
      fact(
        "frequency.recent_run_days_per_week",
        median(recent.map((week) => week.run_day_count)),
        "run_days/week",
        "snapshot.recent_history.weeks",
        recent.length >= 3 ? "high" : recent.length > 0 ? "low" : "unavailable",
      ),
      fact(
        "tolerance.long_run_km",
        median(recent.flatMap((week) => (week.long_run_km === null ? [] : [week.long_run_km]))),
        "km",
        "snapshot.recent_history.weeks",
        recent.length >= 3 ? "high" : "low",
      ),
      fact(
        "tolerance.quality_sessions_per_week",
        median(recent.map((week) => week.speed_session_count)),
        "sessions/week",
        "snapshot.recent_history.weeks",
        recent.length >= 3 ? "high" : "low",
      ),
      fact("history.peak_weekly_km", snapshot.macro_history.peak_weekly_distance_km, "km/week", "snapshot.macro_history.peak_weekly_distance_km"),
      fact("history.longest_run_km", snapshot.macro_history.longest_run_km, "km", "snapshot.macro_history.longest_run_km"),
      fact("history.longest_road_run_km", snapshot.macro_history.longest_road_run_km, "km", "snapshot.macro_history.longest_road_run_km"),
      fact("history.max_gap_days", maxGap, "days", "snapshot.macro_history.gap_periods"),
      fact("history.gap_count", snapshot.macro_history.gap_periods.length, "count", "snapshot.macro_history.gap_periods"),
      fact("load.current_ctl", snapshot.fitness_state.ctl, "training_dose", "snapshot.fitness_state.ctl"),
      fact("load.current_atl", snapshot.fitness_state.atl, "training_dose", "snapshot.fitness_state.atl"),
      fact("load.current_form", snapshot.fitness_state.form, "training_dose", "snapshot.fitness_state.form"),
      fact("race.a.weeks_to_race", round(daysBetween(asOfDay, goal.race_date) / 7, 2), "weeks", "request.goals[A].race_date+snapshot.as_of"),
      fact("goal.a.target_seconds", targetSeconds, "seconds", "request.goals[A].target_time"),
      fact("goal.a.matching_pb_seconds", matchingPb?.time_sec ?? null, "seconds", "snapshot.personal_bests", matchingPb ? "high" : "unavailable"),
      fact(
        "goal.a.improvement_pct",
        matchingPb && targetSeconds ? round(((matchingPb.time_sec - targetSeconds) / matchingPb.time_sec) * 100, 2) : null,
        "percent",
        "request.goals[A].target_time+snapshot.personal_bests",
        matchingPb && targetSeconds ? "high" : "unavailable",
      ),
      fact("coverage.ratio", round(coverageRatio, 2), "ratio", "snapshot.coverage", statuses.length > 0 ? "high" : "unavailable"),
      fact(
        "coverage.missing_domains",
        snapshot.coverage
          .filter((item) => item.status === "missing")
          .map((item) => item.domain)
          .sort()
          .join(",") || "none",
        "domain_list",
        "snapshot.coverage",
      ),
      fact("constraints.goal_incompatible", goalIncompatible(request), "boolean", "request.availability+request.prohibited_arrangements"),
      fact("continuity.days_since_last_run", snapshot.continuity.days_since_last_run, "days", "snapshot.continuity.days_since_last_run"),
      fact("continuity.current_phase", snapshot.current_phase?.name ?? "none", "phase", "snapshot.current_phase"),
    ],
  });
}

export function validateAssessmentReferences(assessment: GoalAssessment, facts: AssessmentFacts): void {
  const byId = new Map(facts.facts.map((fact) => [fact.fact_id, fact]));
  const conclusionIds = assessment.material_conclusions.flatMap((item) => item.fact_ids);
  const noteIds = assessment.conflicts.flatMap((item) => item.fact_ids);
  const gateIds = Object.values(assessment.abc_gates).flatMap((gate) => gate.conditions.flatMap((condition) => condition.fact_ids));
  for (const factId of conclusionIds) if (!byId.has(factId)) throw new Error(`assessment cites unknown fact_id: ${factId}`);
  for (const factId of noteIds) if (!byId.has(factId)) throw new Error(`assessment note cites unknown fact_id: ${factId}`);
  for (const factId of gateIds) if (!byId.has(factId)) throw new Error(`assessment gate cites unknown fact_id: ${factId}`);
  for (const item of assessment.material_conclusions) validateClaim(item.claim, item.fact_ids, byId);
}

/**
 * The required-claim citations are deterministic rules, so a model that picks
 * the claim but under-cites its backing facts is a prompt-compliance miss, not
 * a capability judgment. Backfill the missing ids (only ones the facts actually
 * carry — ids absent from the facts stay missing so validation still fails
 * loudly instead of inventing evidence); contradictory values remain rejected
 * by validateClaim.
 */
export function withBackfilledClaimCitations(assessment: GoalAssessment, facts: AssessmentFacts): GoalAssessment {
  const known = new Set(facts.facts.map((fact) => fact.fact_id));
  return {
    ...assessment,
    material_conclusions: assessment.material_conclusions.map((item) => ({
      ...item,
      fact_ids: [...item.fact_ids, ...REQUIRED_CLAIM_FACTS[item.claim].filter((id) => !item.fact_ids.includes(id) && known.has(id))],
    })),
  };
}

export function canonicalizeAssessmentSummary(assessment: GoalAssessment): GoalAssessment {
  const material_conclusions = assessment.material_conclusions.map((item) => ({
    ...item,
    explanation: claimExplanation(item.claim),
  }));
  return {
    ...assessment,
    material_conclusions,
    summary: material_conclusions.map((item) => item.explanation).join(" "),
  };
}

/**
 * The goal-level ladder is deterministic (authoritativeGoalLevel); the model's
 * own level pick is coherence, not authority — a disagreement is prompt
 * compliance noise, not a capability judgment. Canonicalize to the
 * authoritative level and keep multi_cycle_path only when that level requires it.
 */
export function withAuthoritativeLevel(assessment: GoalAssessment, facts: AssessmentFacts): GoalAssessment {
  const level = authoritativeGoalLevel(facts);
  if (level === assessment.level && (level === "multi_cycle_required" || assessment.multi_cycle_path.length === 0)) return assessment;
  return { ...assessment, level, multi_cycle_path: level === "multi_cycle_required" ? assessment.multi_cycle_path : [] };
}

export function validateGoalAssessmentTargets(assessment: GoalAssessment, request: MasterPlanGraphRequest, facts: AssessmentFacts): void {
  const primary = request.goals.find((goal) => goal.priority === "A")!;
  const confirmedSeconds = primary.target_time === null ? null : parseDuration(primary.target_time);
  const a = assessment.abc_gates.A.target;
  const b = assessment.abc_gates.B.target;
  const c = assessment.abc_gates.C.target;
  for (const gate of Object.values(assessment.abc_gates))
    for (const condition of gate.conditions)
      if (/(?:readiness|evidence)\s+(?:supports?|no longer supports?)/i.test(condition.criterion))
        throw new Error("goal gate criterion must be an observable future validation");
  const matchingPb = numberFact(facts.facts.find((fact) => fact.fact_id === "goal.a.matching_pb_seconds")?.value);
  if (a.kind !== (confirmedSeconds === null ? "finish" : "time") || a.time_seconds !== confirmedSeconds) {
    throw new Error("goal assessment A target must match the confirmed primary target");
  }
  if ((a.kind === "time" && a.time_seconds === null) || (a.kind !== "time" && a.time_seconds !== null))
    throw new Error("goal assessment A target kind and time must agree");
  if (confirmedSeconds === null) {
    if (b.kind !== "finish" || b.time_seconds !== null || c.kind !== "finish" || c.time_seconds !== null)
      throw new Error("finish-only goals cannot invent timed B/C targets");
    return;
  }
  if (b.kind === "time" && (b.time_seconds === null || (confirmedSeconds !== null && b.time_seconds <= confirmedSeconds)))
    throw new Error("goal assessment B target must be slower than A");
  if (b.kind === "pb" && (matchingPb === null || b.time_seconds !== matchingPb || !/(?:PB|personal best|个人最好)/i.test(b.label)))
    throw new Error("goal assessment PB target requires exact matching PB evidence");
  if (b.kind !== "time" && b.kind !== "pb") throw new Error("goal assessment B target must be a conservative time or PB");
  const bFloor = b.kind === "time" ? b.time_seconds : matchingPb;
  if (
    c.kind === "time" &&
    (c.time_seconds === null ||
      (bFloor !== null && c.time_seconds <= bFloor) ||
      (bFloor === null && confirmedSeconds !== null && c.time_seconds <= confirmedSeconds))
  )
    throw new Error("goal assessment C target must be slower than B");
  if (c.kind === "finish" && c.time_seconds !== null) throw new Error("goal assessment finish target must not carry a time");
  if (
    c.kind === "pb" &&
    (matchingPb === null || c.time_seconds !== matchingPb || (bFloor !== null && matchingPb < bFloor) || !/(?:PB|personal best|个人最好)/i.test(c.label))
  )
    throw new Error("goal assessment PB fallback must be no faster than B and backed by exact matching PB");
  if (c.kind === "finish" && !/(?:finish|completion|完赛|安全)/i.test(c.label))
    throw new Error("goal assessment finish fallback must identify safe completion");
  if (c.kind !== "time" && c.kind !== "pb" && c.kind !== "finish") throw new Error("goal assessment C target must be a fallback");
}

export function authoritativeGoalLevel(facts: AssessmentFacts): GoalAssessment["level"] {
  const values = new Map(facts.facts.map((fact) => [fact.fact_id, fact.value]));
  const improvement = numberFact(values.get("goal.a.improvement_pct"));
  const runway = numberFact(values.get("race.a.weeks_to_race"));
  if ((runway !== null && runway <= 0) || values.get("constraints.goal_incompatible") === true) return "unsafe_or_incompatible";
  if (improvement === null) return "conditional";
  if (improvement > 15 || (improvement > 10 && (runway ?? 0) < 16)) return "multi_cycle_required";
  if (improvement > 3 || (runway ?? 99) < 12) return "aggressive_but_plausible";
  return "supported";
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
function daysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}
function normalizeDistance(distance: string): "FM" | "HM" | null {
  const value = distance.trim().toUpperCase();
  return value === "FM" || value === "MARATHON" || value === "42.195" ? "FM" : value === "HM" || value === "HALF MARATHON" || value === "21.0975" ? "HM" : null;
}
function parseDuration(value: string): number | null {
  const parts = value.split(":").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null;
  return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
}
function numberFact(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function goalIncompatible(request: MasterPlanGraphRequest): boolean {
  const available = new Set(request.availability.available_training_windows.map((window) => window.day));
  const unavailable = new Set(request.availability.unavailable_days);
  if (available.size > 0 && [...available].every((day) => unavailable.has(day))) return true;
  const primary = request.goals.find((goal) => goal.priority === "A")!;
  return (
    /^(?:FM|HM)$/.test(primary.distance) &&
    request.prohibited_arrangements.some((item) => /(?:no|禁止|不做|不能).{0,10}(?:running|run|long run|跑步|长跑|长距离)/i.test(item))
  );
}
/** fact_ids that deterministically back each goal claim; conclusions citing a claim must cite all of them. */
const REQUIRED_CLAIM_FACTS: Record<GoalClaim, string[]> = {
  goal_requires_improvement: ["goal.a.improvement_pct"],
  goal_runway_limited: ["race.a.weeks_to_race"],
  goal_supported_by_history: ["history.peak_weekly_km", "history.longest_road_run_km"],
};
function validateClaim(claim: GoalClaim, factIds: string[], facts: Map<string, Fact>): void {
  for (const id of REQUIRED_CLAIM_FACTS[claim]) if (!factIds.includes(id) || !facts.has(id)) throw new Error(`assessment claim ${claim} requires fact_id: ${id}`);
  const value = (id: string) => facts.get(id)?.value;
  const valid =
    claim === "goal_requires_improvement"
      ? (numberFact(value("goal.a.improvement_pct")) ?? 0) > 0
      : claim === "goal_runway_limited"
        ? (numberFact(value("race.a.weeks_to_race")) ?? 99) < 12
        : positive(value("history.peak_weekly_km")) && positive(value("history.longest_road_run_km"));
  if (!valid) throw new Error(`assessment claim ${claim} contradicts deterministic facts`);
}
function positive(value: unknown): boolean {
  return (numberFact(value) ?? 0) > 0;
}
function claimExplanation(claim: GoalClaim): string {
  return (
    {
      goal_requires_improvement: "The confirmed goal requires improvement over the matching personal best.",
      goal_runway_limited: "The remaining race runway limits adaptation time.",
      goal_supported_by_history: "Historical volume and road-running durability support the goal path.",
    } as const
  )[claim];
}
