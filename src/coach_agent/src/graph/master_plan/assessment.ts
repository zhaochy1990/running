import type { MasterPlanGraphRequest } from "@stride/contract";
import {
	type AssessmentFacts,
	AssessmentFactsSchema,
	type AthleteAssessment,
	AthleteAssessmentSchema,
	type AthleteClaim,
	addDays,
	type Fact,
	type GoalAssessment,
	GoalAssessmentSchema,
	type GoalClaim,
	shanghaiDay,
} from "@stride/contract";
import { median } from "../../utils/statistics.js";
import type { ContextSnapshot } from "./context.js";

export type {
	AssessmentFacts,
	AthleteAssessment,
	GoalAssessment,
} from "@stride/contract";
export {
	AssessmentFactsSchema,
	AthleteAssessmentSchema,
	GoalAssessmentSchema,
} from "@stride/contract";

export function deriveAssessmentFacts(
	snapshot: ContextSnapshot,
	request: MasterPlanGraphRequest,
): AssessmentFacts {
	const asOfDay = shanghaiDay(snapshot.as_of);
	const weeks = snapshot.recent_history.weeks.filter(
		(week) => addDays(week.week_start, 6) < asOfDay,
	);
	const recent = weeks.slice(-4);
	const stable = weeks.slice(
		Math.max(0, weeks.length - 8),
		Math.max(0, weeks.length - 4),
	);
	const baseline =
		stable.length > 0
			? stable
			: weeks.slice(0, Math.max(0, weeks.length - recent.length));
	const goal = request.goals.find((candidate) => candidate.priority === "A")!;
	const matchingPb = snapshot.personal_bests
		.filter((pb) => normalizeDistance(pb.distance) === goal.distance)
		.sort((a, b) => a.time_sec - b.time_sec)[0];
	const targetSeconds =
		goal.target_time === null ? null : parseDuration(goal.target_time);
	const statuses = snapshot.coverage.map((item) => item.status);
	const coverageRatio =
		statuses.length === 0
			? 0
			: statuses.reduce(
					(sum, status) =>
						sum + (status === "complete" ? 1 : status === "partial" ? 0.5 : 0),
					0,
				) / statuses.length;
	const fact = (
		fact_id: string,
		value: Fact["value"],
		unit: string,
		source: string,
		confidence: "high" | "medium" | "low" | "unavailable" = value === null
			? "unavailable"
			: "high",
	) => ({ fact_id, value, unit, source, confidence });
	const maxGap =
		snapshot.macro_history.gap_periods.length === 0
			? 0
			: Math.max(...snapshot.macro_history.gap_periods.map((gap) => gap.days));

	return AssessmentFactsSchema.parse({
		schema_version: 1,
		as_of: snapshot.as_of,
		facts: [
			fact(
				"volume.stable_weekly_km",
				median(baseline.map((week) => week.distance_km)),
				"km/week",
				"snapshot.recent_history.weeks",
				baseline.length >= 3
					? "high"
					: baseline.length > 0
						? "low"
						: "unavailable",
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
				median(
					recent.flatMap((week) =>
						week.long_run_km === null ? [] : [week.long_run_km],
					),
				),
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
			fact(
				"history.peak_weekly_km",
				snapshot.macro_history.peak_weekly_distance_km,
				"km/week",
				"snapshot.macro_history.peak_weekly_distance_km",
			),
			fact(
				"history.longest_run_km",
				snapshot.macro_history.longest_run_km,
				"km",
				"snapshot.macro_history.longest_run_km",
			),
			fact(
				"history.longest_road_run_km",
				snapshot.macro_history.longest_road_run_km,
				"km",
				"snapshot.macro_history.longest_road_run_km",
			),
			fact(
				"history.max_gap_days",
				maxGap,
				"days",
				"snapshot.macro_history.gap_periods",
			),
			fact(
				"history.gap_count",
				snapshot.macro_history.gap_periods.length,
				"count",
				"snapshot.macro_history.gap_periods",
			),
			fact(
				"load.current_ctl",
				snapshot.fitness_state.ctl,
				"training_dose",
				"snapshot.fitness_state.ctl",
			),
			fact(
				"load.current_atl",
				snapshot.fitness_state.atl,
				"training_dose",
				"snapshot.fitness_state.atl",
			),
			fact(
				"load.current_form",
				snapshot.fitness_state.form,
				"training_dose",
				"snapshot.fitness_state.form",
			),
			fact(
				"race.a.weeks_to_race",
				round(daysBetween(asOfDay, goal.race_date) / 7, 2),
				"weeks",
				"request.goals[A].race_date+snapshot.as_of",
			),
			fact(
				"goal.a.target_seconds",
				targetSeconds,
				"seconds",
				"request.goals[A].target_time",
			),
			fact(
				"goal.a.matching_pb_seconds",
				matchingPb?.time_sec ?? null,
				"seconds",
				"snapshot.personal_bests",
				matchingPb ? "high" : "unavailable",
			),
			fact(
				"goal.a.improvement_pct",
				matchingPb && targetSeconds
					? round(
							((matchingPb.time_sec - targetSeconds) / matchingPb.time_sec) *
								100,
							2,
						)
					: null,
				"percent",
				"request.goals[A].target_time+snapshot.personal_bests",
				matchingPb && targetSeconds ? "high" : "unavailable",
			),
			fact(
				"coverage.ratio",
				round(coverageRatio, 2),
				"ratio",
				"snapshot.coverage",
				statuses.length > 0 ? "high" : "unavailable",
			),
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
			fact(
				"constraints.goal_incompatible",
				goalIncompatible(request),
				"boolean",
				"request.availability+request.prohibited_arrangements",
			),
			fact(
				"continuity.days_since_last_run",
				snapshot.continuity.days_since_last_run,
				"days",
				"snapshot.continuity.days_since_last_run",
			),
			fact(
				"continuity.current_phase",
				snapshot.current_phase?.name ?? "none",
				"phase",
				"snapshot.current_phase",
			),
		],
	});
}

export function validateAssessmentReferences(
	assessment: AthleteAssessment | GoalAssessment,
	facts: AssessmentFacts,
): void {
	const byId = new Map(facts.facts.map((fact) => [fact.fact_id, fact]));
	const conclusionIds = assessment.material_conclusions.flatMap(
		(item) => item.fact_ids,
	);
	const noteIds =
		"gaps" in assessment
			? [
					...assessment.gaps,
					...assessment.limiting_factors,
					...assessment.assumptions_to_validate,
				].flatMap((item) => item.fact_ids)
			: assessment.conflicts.flatMap((item) => item.fact_ids);
	const gateIds =
		"abc_gates" in assessment
			? Object.values(assessment.abc_gates).flatMap((gate) =>
					gate.conditions.flatMap((condition) => condition.fact_ids),
				)
			: [];
	for (const factId of conclusionIds)
		if (!byId.has(factId))
			throw new Error(`assessment cites unknown fact_id: ${factId}`);
	for (const factId of noteIds)
		if (!byId.has(factId))
			throw new Error(`assessment note cites unknown fact_id: ${factId}`);
	for (const factId of gateIds)
		if (!byId.has(factId))
			throw new Error(`assessment gate cites unknown fact_id: ${factId}`);
	for (const item of assessment.material_conclusions)
		validateClaim(item.claim, item.fact_ids, byId);
}

export function canonicalizeAssessmentSummary<
	T extends AthleteAssessment | GoalAssessment,
>(assessment: T): T {
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

export function validateGoalAssessmentTargets(
	assessment: GoalAssessment,
	request: MasterPlanGraphRequest,
	facts: AssessmentFacts,
): void {
	const primary = request.goals.find((goal) => goal.priority === "A")!;
	const confirmedSeconds =
		primary.target_time === null ? null : parseDuration(primary.target_time);
	const a = assessment.abc_gates.A.target;
	const b = assessment.abc_gates.B.target;
	const c = assessment.abc_gates.C.target;
	for (const gate of Object.values(assessment.abc_gates))
		for (const condition of gate.conditions)
			if (
				/(?:readiness|evidence)\s+(?:supports?|no longer supports?)/i.test(
					condition.criterion,
				)
			)
				throw new Error(
					"goal gate criterion must be an observable future validation",
				);
	const matchingPb = numberFact(
		facts.facts.find((fact) => fact.fact_id === "goal.a.matching_pb_seconds")
			?.value,
	);
	if (
		a.kind !== (confirmedSeconds === null ? "finish" : "time") ||
		a.time_seconds !== confirmedSeconds
	) {
		throw new Error(
			"goal assessment A target must match the confirmed primary target",
		);
	}
	if (
		(a.kind === "time" && a.time_seconds === null) ||
		(a.kind !== "time" && a.time_seconds !== null)
	)
		throw new Error("goal assessment A target kind and time must agree");
	if (confirmedSeconds === null) {
		if (
			b.kind !== "finish" ||
			b.time_seconds !== null ||
			c.kind !== "finish" ||
			c.time_seconds !== null
		)
			throw new Error("finish-only goals cannot invent timed B/C targets");
		return;
	}
	if (
		b.kind === "time" &&
		(b.time_seconds === null ||
			(confirmedSeconds !== null && b.time_seconds <= confirmedSeconds))
	)
		throw new Error("goal assessment B target must be slower than A");
	if (
		b.kind === "pb" &&
		(matchingPb === null ||
			b.time_seconds !== matchingPb ||
			!/(?:PB|personal best|个人最好)/i.test(b.label))
	)
		throw new Error(
			"goal assessment PB target requires exact matching PB evidence",
		);
	if (b.kind !== "time" && b.kind !== "pb")
		throw new Error(
			"goal assessment B target must be a conservative time or PB",
		);
	const bFloor = b.kind === "time" ? b.time_seconds : matchingPb;
	if (
		c.kind === "time" &&
		(c.time_seconds === null ||
			(bFloor !== null && c.time_seconds <= bFloor) ||
			(bFloor === null &&
				confirmedSeconds !== null &&
				c.time_seconds <= confirmedSeconds))
	)
		throw new Error("goal assessment C target must be slower than B");
	if (c.kind === "finish" && c.time_seconds !== null)
		throw new Error("goal assessment finish target must not carry a time");
	if (
		c.kind === "pb" &&
		(matchingPb === null ||
			c.time_seconds !== matchingPb ||
			(bFloor !== null && matchingPb < bFloor) ||
			!/(?:PB|personal best|个人最好)/i.test(c.label))
	)
		throw new Error(
			"goal assessment PB fallback must be no faster than B and backed by exact matching PB",
		);
	if (c.kind === "finish" && !/(?:finish|completion|完赛|安全)/i.test(c.label))
		throw new Error(
			"goal assessment finish fallback must identify safe completion",
		);
	if (c.kind !== "time" && c.kind !== "pb" && c.kind !== "finish")
		throw new Error("goal assessment C target must be a fallback");
}

export function authoritativeReadiness(
	facts: AssessmentFacts,
): AthleteAssessment["readiness"] {
	const values = new Map(facts.facts.map((fact) => [fact.fact_id, fact.value]));
	if (
		(numberFact(values.get("volume.recent_weekly_km")) ?? 0) <= 0 ||
		(numberFact(values.get("frequency.recent_run_days_per_week")) ?? 0) <= 0
	)
		return "missing_baseline";
	const daysSinceLastRun = numberFact(
		values.get("continuity.days_since_last_run"),
	);
	const ctl = numberFact(values.get("load.current_ctl"));
	const form = numberFact(values.get("load.current_form"));
	if (
		(daysSinceLastRun !== null && daysSinceLastRun >= 14) ||
		(ctl !== null && ctl > 0 && form !== null && form / ctl < -0.25)
	)
		return "limited";
	return "ready";
}

export function authoritativeContinuity(
	facts: AssessmentFacts,
): AthleteAssessment["continuity"] {
	const days = numberFact(
		facts.facts.find(
			(fact) => fact.fact_id === "continuity.days_since_last_run",
		)?.value,
	);
	if (days === null) return "unknown";
	if (days >= 28) return "returning";
	if (days >= 14) return "interrupted";
	return "continuous";
}

export function authoritativeGoalLevel(
	facts: AssessmentFacts,
	athlete?: AthleteAssessment,
): GoalAssessment["level"] {
	const values = new Map(facts.facts.map((fact) => [fact.fact_id, fact.value]));
	const improvement = numberFact(values.get("goal.a.improvement_pct"));
	const runway = numberFact(values.get("race.a.weeks_to_race"));
	if (
		(runway !== null && runway <= 0) ||
		values.get("constraints.goal_incompatible") === true
	)
		return "unsafe_or_incompatible";
	if (improvement === null) return "conditional";
	if (improvement > 15 || (improvement > 10 && (runway ?? 0) < 16))
		return "multi_cycle_required";
	if (
		athlete &&
		(athlete.readiness === "limited" ||
			athlete.continuity === "returning" ||
			athlete.capability_confidence === "low")
	)
		return "conditional";
	if (improvement > 3 || (runway ?? 99) < 12) return "aggressive_but_plausible";
	return "supported";
}

export function validateAthleteAssessmentRanges(
	assessment: AthleteAssessment,
	facts: AssessmentFacts,
	request: MasterPlanGraphRequest,
): void {
	const byId = new Map(facts.facts.map((fact) => [fact.fact_id, fact.value]));
	const recentKm = numberFact(byId.get("volume.recent_weekly_km"));
	const stableKm = numberFact(byId.get("volume.stable_weekly_km"));
	const historyPeak = numberFact(byId.get("history.peak_weekly_km"));
	const roadLongest = numberFact(byId.get("history.longest_road_run_km"));
	const quality = numberFact(byId.get("tolerance.quality_sessions_per_week"));
	const distance = assessment.safe_training_ranges.weekly_distance_km;
	const startingDistance =
		assessment.safe_training_ranges.starting_weekly_distance_km;
	if (
		startingDistance.low > startingDistance.high ||
		startingDistance.high > distance.high ||
		startingDistance.high > Math.max(recentKm ?? 0, stableKm ?? 0) * 1.1 + 1
	)
		throw new Error(
			"athlete assessment starting range exceeds peak training boundary",
		);
	const currentPhase = byId.get("continuity.current_phase");
	if (
		assessment.current_phase !== (currentPhase === "none" ? null : currentPhase)
	)
		throw new Error("athlete assessment current phase contradicts snapshot");
	const athleteNoteIds = [
		...assessment.limiting_factors,
		...assessment.assumptions_to_validate,
		...assessment.gaps,
	].flatMap((item) => item.fact_ids);
	if (
		athleteNoteIds.some(
			(id) => id.startsWith("goal.") || id.startsWith("race."),
		)
	)
		throw new Error(
			"athlete assessment notes must not assess race-goal feasibility",
		);
	if (
		distance.low > distance.high ||
		distance.high >
			Math.max(historyPeak ?? 0, recentKm ?? 0, stableKm ?? 0) * 1.1 + 1
	)
		throw new Error(
			"athlete assessment weekly-distance range exceeds deterministic evidence",
		);
	if (
		assessment.safe_training_ranges.runs_per_week.high >
		request.availability.weekly_run_days_max
	)
		throw new Error(
			"athlete assessment run frequency exceeds confirmed availability",
		);
	if (
		roadLongest === null &&
		assessment.safe_training_ranges.long_run_km.high > 0
	)
		throw new Error(
			"athlete assessment long-run range requires road-run evidence",
		);
	if (
		roadLongest !== null &&
		assessment.safe_training_ranges.long_run_km.high > roadLongest
	)
		throw new Error(
			"athlete assessment long-run range exceeds road-run evidence",
		);
	if (
		quality !== null &&
		assessment.safe_training_ranges.quality_sessions_per_week.high >
			Math.ceil(quality)
	)
		throw new Error(
			"athlete assessment quality-session range exceeds deterministic evidence",
		);
}

function round(value: number, digits: number): number {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}
function daysBetween(from: string, to: string): number {
	return (
		(Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
		86_400_000
	);
}
function normalizeDistance(distance: string): "FM" | "HM" | null {
	const value = distance.trim().toUpperCase();
	return value === "FM" || value === "MARATHON" || value === "42.195"
		? "FM"
		: value === "HM" || value === "HALF MARATHON" || value === "21.0975"
			? "HM"
			: null;
}
function parseDuration(value: string): number | null {
	const parts = value.split(":").map(Number);
	if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part)))
		return null;
	return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
}
function numberFact(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function goalIncompatible(request: MasterPlanGraphRequest): boolean {
	const available = new Set(
		request.availability.available_training_windows.map((window) => window.day),
	);
	const unavailable = new Set(request.availability.unavailable_days);
	if (available.size > 0 && [...available].every((day) => unavailable.has(day)))
		return true;
	const primary = request.goals.find((goal) => goal.priority === "A")!;
	return (
		/^(?:FM|HM)$/.test(primary.distance) &&
		request.prohibited_arrangements.some((item) =>
			/(?:no|禁止|不做|不能).{0,10}(?:running|run|long run|跑步|长跑|长距离)/i.test(
				item,
			),
		)
	);
}
function validateClaim(
	claim: AthleteClaim | GoalClaim,
	factIds: string[],
	facts: Map<string, Fact>,
): void {
	const required: Record<AthleteClaim | GoalClaim, string[]> = {
		volume_baseline_established: ["volume.recent_weekly_km"],
		long_run_tolerance_established: ["tolerance.long_run_km"],
		quality_tolerance_established: ["tolerance.quality_sessions_per_week"],
		availability_requires_adjustment: ["frequency.recent_run_days_per_week"],
		load_state_supportive: ["load.current_form"],
		coverage_sufficient: ["coverage.ratio", "coverage.missing_domains"],
		goal_requires_improvement: ["goal.a.improvement_pct"],
		goal_runway_limited: ["race.a.weeks_to_race"],
		goal_supported_by_history: [
			"history.peak_weekly_km",
			"history.longest_road_run_km",
		],
	};
	for (const id of required[claim])
		if (!factIds.includes(id) || !facts.has(id))
			throw new Error(`assessment claim ${claim} requires fact_id: ${id}`);
	const value = (id: string) => facts.get(id)?.value;
	const valid =
		claim === "volume_baseline_established"
			? positive(value("volume.recent_weekly_km"))
			: claim === "long_run_tolerance_established"
				? positive(value("tolerance.long_run_km"))
				: claim === "quality_tolerance_established"
					? positive(value("tolerance.quality_sessions_per_week"))
					: claim === "availability_requires_adjustment"
						? positive(value("frequency.recent_run_days_per_week"))
						: claim === "load_state_supportive"
							? numberFact(value("load.current_form")) !== null &&
								numberFact(value("load.current_form"))! >= 0
							: claim === "coverage_sufficient"
								? (numberFact(value("coverage.ratio")) ?? 0) >= 0.7 &&
									value("coverage.missing_domains") === "none"
								: claim === "goal_requires_improvement"
									? (numberFact(value("goal.a.improvement_pct")) ?? 0) > 0
									: claim === "goal_runway_limited"
										? (numberFact(value("race.a.weeks_to_race")) ?? 99) < 12
										: positive(value("history.peak_weekly_km")) &&
											positive(value("history.longest_road_run_km"));
	if (!valid)
		throw new Error(
			`assessment claim ${claim} contradicts deterministic facts`,
		);
}
function positive(value: unknown): boolean {
	return (numberFact(value) ?? 0) > 0;
}
function claimExplanation(claim: AthleteClaim | GoalClaim): string {
	return (
		{
			volume_baseline_established:
				"Recent volume establishes a usable training baseline.",
			long_run_tolerance_established:
				"Recent long-run history establishes a durability baseline.",
			quality_tolerance_established:
				"Recent quality work establishes a quality-session baseline.",
			availability_requires_adjustment:
				"Recent running frequency must be reconciled with confirmed availability.",
			load_state_supportive:
				"Current STRIDE load state is supportive rather than overloaded.",
			coverage_sufficient:
				"Available planning evidence is sufficiently covered.",
			goal_requires_improvement:
				"The confirmed goal requires improvement over the matching personal best.",
			goal_runway_limited: "The remaining race runway limits adaptation time.",
			goal_supported_by_history:
				"Historical volume and road-running durability support the goal path.",
		} as const
	)[claim];
}
