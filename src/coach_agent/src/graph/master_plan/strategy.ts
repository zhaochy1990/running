import type {
	SelectedStrategy,
	StrategyCandidate,
	StrategyJudgment,
} from "./schemas.js";
import {
	SelectedStrategySchema,
	StrategyCandidateSchema,
	StrategyJudgmentSchema,
} from "./schemas.js";
import type { AssessmentFacts, AthleteAssessment } from "./assessment.js";

export const STRATEGY_WEIGHTS = {
	performance_path: 0.45,
	safety_load: 0.35,
	constraint_feasibility: 0.2,
} as const;

function stableMerge<T>(
	current: readonly T[],
	update: readonly T[],
	keyOf: (value: T) => string,
	parse: (value: T) => T,
	label: string,
): T[] {
	const values = new Map<string, T>();
	for (const raw of [...current, ...update]) {
		const value = parse(raw);
		const key = keyOf(value);
		const existing = values.get(key);
		if (existing && JSON.stringify(existing) !== JSON.stringify(value))
			throw new Error(`conflicting duplicate ${label}: ${key}`);
		values.set(key, value);
	}
	return [...values.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([, value]) => value);
}

export function mergeCandidatesByStableId(
	current: readonly StrategyCandidate[],
	update: readonly StrategyCandidate[],
): StrategyCandidate[] {
	return stableMerge(
		current,
		update,
		(value) => value.candidate_id,
		(value) => StrategyCandidateSchema.parse(value),
		"candidate_id",
	);
}

export function mergeJudgmentsByStableKey(
	current: readonly StrategyJudgment[],
	update: readonly StrategyJudgment[],
): StrategyJudgment[] {
	return stableMerge(
		current,
		update,
		(value) => `${value.candidate_id}:${value.judge}`,
		(value) => StrategyJudgmentSchema.parse(value),
		"judgment",
	);
}

export function mergeWorkerErrors(
	current: readonly string[],
	update: readonly string[],
): string[] {
	return [...new Set([...current, ...update])].sort();
}

export function validateStrategyCandidate(
	candidate: StrategyCandidate,
	facts: AssessmentFacts,
	athlete: AthleteAssessment,
): void {
	const ids = new Set(facts.facts.map((fact) => fact.fact_id));
	for (const id of candidate.evidence_fact_ids)
		if (!ids.has(id)) throw new Error(`strategy cites unknown fact_id: ${id}`);
	const safe = athlete.safe_training_ranges;
	if (
		candidate.phases.reduce((sum, phase) => sum + phase.weeks, 0) !==
		candidate.weekly_highs_km.length
	)
		throw new Error("strategy phase weeks must equal weekly load curve length");
	if (candidate.race_week_index !== candidate.weekly_highs_km.length)
		throw new Error("strategy race week must be the final planned week");
	if (
		candidate.weekly_highs_km.some(
			(value, index) =>
				index + 1 !== candidate.race_week_index &&
				value > safe.weekly_distance_km.high,
		)
	)
		throw new Error("strategy weekly load exceeds athlete safe range");
	if (candidate.max_long_run_km > safe.long_run_km.high)
		throw new Error("strategy long run exceeds athlete safe range");
	if (
		candidate.max_quality_sessions_per_week >
		safe.quality_sessions_per_week.high
	)
		throw new Error("strategy quality density exceeds athlete safe range");
}

export function validateStrategyJudgment(
	judgment: StrategyJudgment,
	candidate: StrategyCandidate,
	facts: AssessmentFacts,
): void {
	const ids = new Set(facts.facts.map((fact) => fact.fact_id));
	if (judgment.candidate_id !== candidate.candidate_id)
		throw new Error("judgment candidate ID mismatch");
	for (const id of judgment.evidence_fact_ids)
		if (!ids.has(id)) throw new Error(`judgment cites unknown fact_id: ${id}`);
}

export function validateCandidateDiversity(
	candidates: readonly StrategyCandidate[],
): void {
	const fingerprints = candidates.map((candidate) =>
		JSON.stringify({
			phase_weeks: candidate.phases.map((phase) => phase.weeks),
			phase_ranges: candidate.phases.map((phase) => [
				phase.weekly_km_low,
				phase.weekly_km_high,
			]),
			weekly_highs_km: candidate.weekly_highs_km,
			max_long_run_km: candidate.max_long_run_km,
			max_quality_sessions_per_week: candidate.max_quality_sessions_per_week,
			race_week_index: candidate.race_week_index,
		}),
	);
	if (new Set(fingerprints).size !== candidates.length)
		throw new Error("strategy candidates must be materially different");
}

export function aggregateStrategySelection(
	candidates: readonly StrategyCandidate[],
	judgments: readonly StrategyJudgment[],
): SelectedStrategy {
	const uniqueCandidates = mergeCandidatesByStableId([], candidates);
	const uniqueJudgments = mergeJudgmentsByStableKey([], judgments);
	const ranked = uniqueCandidates
		.flatMap((candidate) => {
			const candidateJudgments = uniqueJudgments.filter(
				(judgment) => judgment.candidate_id === candidate.candidate_id,
			);
			for (const judge of Object.keys(STRATEGY_WEIGHTS) as Array<
				keyof typeof STRATEGY_WEIGHTS
			>) {
				if (!candidateJudgments.some((judgment) => judgment.judge === judge))
					throw new Error(
						`missing judgment ${judge} for ${candidate.candidate_id}`,
					);
			}
			if (
				!candidate.hard_constraints_satisfied ||
				candidateJudgments.some((judgment) => judgment.veto)
			)
				return [];
			const score = (judge: StrategyJudgment["judge"]) =>
				candidateJudgments.find((judgment) => judgment.judge === judge)!.score;
			const scores = {
				performance_path: score("performance_path"),
				safety_load: score("safety_load"),
				constraint_feasibility: score("constraint_feasibility"),
				weighted_total: Number(
					(
						score("performance_path") * STRATEGY_WEIGHTS.performance_path +
						score("safety_load") * STRATEGY_WEIGHTS.safety_load +
						score("constraint_feasibility") *
							STRATEGY_WEIGHTS.constraint_feasibility
					).toFixed(2),
				),
			};
			return [{ candidate, scores, candidateJudgments }];
		})
		.sort(
			(left, right) =>
				right.scores.weighted_total - left.scores.weighted_total ||
				left.candidate.candidate_id.localeCompare(right.candidate.candidate_id),
		);
	const winner = ranked[0];
	if (!winner)
		throw new Error(
			"no eligible strategy after hard-constraint and veto filtering",
		);
	return SelectedStrategySchema.parse({
		candidate: winner.candidate,
		scores: winner.scores,
		weights: STRATEGY_WEIGHTS,
		rationale: `按performance 45%、safety/load 35%、feasibility 20%加权后选择；先剔除veto及硬约束失败候选。${winner.candidate.candidate_id}得分最高。`,
		tradeoffs: winner.candidate.risk_tradeoffs,
	});
}
