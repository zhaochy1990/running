import assert from "node:assert/strict";
import test from "node:test";
import {
	aggregateStrategySelection,
	mergeCandidatesByStableId,
	mergeJudgmentsByStableKey,
	validateCandidateDiversity,
	validateStrategyCandidate,
	validateStrategyJudgment,
} from "./strategy.js";
import {
	createTestJudgments,
	createTestStrategyCandidate,
} from "./testFixtures.js";
import {
	createAssessmentSnapshot,
	createTestAthleteAssessment,
	createTestRequest,
} from "./testFixtures.js";
import {
	AthleteAssessmentSchema,
	deriveAssessmentFacts,
} from "./assessment.js";
import { ContextSnapshotSchema } from "./context.js";
import { MasterPlanGraphRequest } from "./contracts.js";

test("candidate reducer is order-independent, keyed by stable ID, and duplicate-safe", () => {
	const conservative = createTestStrategyCandidate("conservative");
	const balanced = createTestStrategyCandidate("balanced");
	assert.deepEqual(
		mergeCandidatesByStableId([balanced], [conservative]).map(
			(x) => x.candidate_id,
		),
		[balanced.candidate_id, conservative.candidate_id],
	);
	assert.deepEqual(mergeCandidatesByStableId([conservative], [conservative]), [
		conservative,
	]);
	assert.throws(
		() =>
			mergeCandidatesByStableId(
				[conservative],
				[{ ...conservative, load_curve: "conflict" }],
			),
		/duplicate candidate_id/,
	);
});

test("judgment reducer rejects conflicting duplicates", () => {
	const judgment = createTestJudgments("strategy-balanced-v1")[0]!;
	assert.deepEqual(mergeJudgmentsByStableKey([judgment], [judgment]), [
		judgment,
	]);
	assert.throws(
		() => mergeJudgmentsByStableKey([judgment], [{ ...judgment, score: 1 }]),
		/duplicate judgment/,
	);
});

test("deterministic selection applies veto, documented weights, and stable tie break", () => {
	const conservative = createTestStrategyCandidate("conservative");
	const balanced = createTestStrategyCandidate("balanced");
	const aggressive = createTestStrategyCandidate("aggressive_gated");
	const judgments = [
		...createTestJudgments(conservative.candidate_id, [4, 4, 4]),
		...createTestJudgments(balanced.candidate_id, [5, 4, 3]),
		...createTestJudgments(aggressive.candidate_id, [5, 5, 5]).map((j) =>
			j.judge === "safety_load" ? { ...j, veto: true } : j,
		),
	];
	const selected = aggregateStrategySelection(
		[balanced, aggressive, conservative],
		judgments,
	);
	assert.equal(selected.candidate.candidate_id, balanced.candidate_id);
	assert.equal(selected.scores.weighted_total, 4.25);
	assert.deepEqual(selected.weights, {
		performance_path: 0.45,
		safety_load: 0.35,
		constraint_feasibility: 0.2,
	});

	const tie = aggregateStrategySelection(
		[balanced, conservative],
		[
			...createTestJudgments(balanced.candidate_id),
			...createTestJudgments(conservative.candidate_id),
		],
	);
	assert.equal(tie.candidate.candidate_id, balanced.candidate_id);
});

test("selection rejects missing judges and all-ineligible candidates", () => {
	const balanced = createTestStrategyCandidate("balanced");
	assert.throws(
		() =>
			aggregateStrategySelection(
				[balanced],
				createTestJudgments(balanced.candidate_id).slice(0, 2),
			),
		/missing judgment/,
	);
	assert.throws(
		() =>
			aggregateStrategySelection(
				[
					{
						...balanced,
						hard_constraints_satisfied: false,
						hard_constraint_violations: ["run days"],
					},
				],
				createTestJudgments(balanced.candidate_id),
			),
		/no eligible strategy/,
	);
});

test("selection treats a low score as a tradeoff unless the judge explicitly vetoes", () => {
	const balanced = createTestStrategyCandidate("balanced");
	assert.equal(
		aggregateStrategySelection(
			[balanced],
			createTestJudgments(balanced.candidate_id, [5, 2, 5]),
		).candidate.candidate_id,
		balanced.candidate_id,
	);
});

test("strategy and judgment evidence must reference deterministic facts", () => {
	const facts = deriveAssessmentFacts(
		ContextSnapshotSchema.parse(createAssessmentSnapshot()),
		MasterPlanGraphRequest.parse(createTestRequest()),
	);
	const athlete = AthleteAssessmentSchema.parse(createTestAthleteAssessment());
	const candidate = {
		...createTestStrategyCandidate("balanced"),
		evidence_fact_ids: ["invented.fact"],
	};
	assert.throws(
		() => validateStrategyCandidate(candidate, facts, athlete),
		/unknown fact_id/,
	);
	const valid = createTestStrategyCandidate("balanced");
	const judgment = {
		...createTestJudgments(valid.candidate_id)[0]!,
		evidence_fact_ids: ["invented.fact"],
	};
	assert.throws(
		() => validateStrategyJudgment(judgment, valid, facts),
		/unknown fact_id/,
	);
});

test("strategy candidates must differ materially beyond ID and archetype", () => {
	const conservative = createTestStrategyCandidate("conservative");
	const balanced = {
		...conservative,
		candidate_id: "strategy-balanced-v1" as const,
		archetype: "balanced" as const,
	};
	assert.throws(
		() => validateCandidateDiversity([conservative, balanced]),
		/materially different/,
	);
});
