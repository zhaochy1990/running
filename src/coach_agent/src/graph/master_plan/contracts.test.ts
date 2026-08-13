import assert from "node:assert/strict";
import test from "node:test";
import { MasterPlanGraphOutcome, MasterPlanGraphRequest } from "./contracts.js";
import {
	createAssessmentSnapshot,
	createTestAthleteAssessment,
	createTestGoalAssessment,
	createTestJudgments,
	createTestMasterPlan,
	createTestRequest,
	createTestReviewReport,
	createTestStrategyCandidate,
} from "./testFixtures.js";
import { deriveAssessmentFacts } from "./assessment.js";
import { simulateMasterPlanLoad } from "./simulation.js";
import { runMasterPlanRuleFilter } from "./rules.js";
import { adjudicateMasterPlanReviews } from "./review.js";

test("request accepts explicit empty constraints in a complete confirmed intake", () => {
	const request = createTestRequest();
	assert.deepEqual(MasterPlanGraphRequest.parse(request), request);
});

test("request accepts an omitted or null race location", () => {
	const request = createTestRequest();
	const goal = request.goals[0];
	assert.ok(goal);
	const { location: _location, ...goalWithoutLocation } = goal;
	const withoutLocation = { ...request, goals: [goalWithoutLocation] };
	assert.equal(MasterPlanGraphRequest.safeParse(withoutLocation).success, true);

	const withNullLocation = {
		...request,
		goals: [{ ...goal, location: null }],
	};
	assert.equal(
		MasterPlanGraphRequest.safeParse(withNullLocation).success,
		true,
	);
});

test("request rejects omitted intake fields and unconfirmed answers", () => {
	const { preferences: _, ...missingPreferences } = createTestRequest();
	assert.equal(
		MasterPlanGraphRequest.safeParse(missingPreferences).success,
		false,
	);

	const unconfirmed = createTestRequest();
	const invalidConfirmation = {
		...unconfirmed,
		user_confirmations: {
			...unconfirmed.user_confirmations,
			constraints_confirmed: false,
		},
	};
	assert.equal(
		MasterPlanGraphRequest.safeParse(invalidConfirmation).success,
		false,
	);
});

test("request rejects ambiguous primary race priorities", () => {
	const request = createTestRequest();
	const ambiguous = {
		...request,
		goals: [
			...request.goals,
			{ ...request.goals[0]!, race_name: "上海马拉松", location: "上海" },
		],
	};

	assert.equal(MasterPlanGraphRequest.safeParse(ambiguous).success, false);
});

test("request rejects malformed race target times instead of treating them as finish-only", () => {
	const request = createTestRequest();
	request.goals[0]!.target_time = "2:50";
	assert.equal(MasterPlanGraphRequest.safeParse(request).success, false);
});

test("outcome rejects decision and artifact mismatches", () => {
	const completed = completedOutcome();
	assert.equal(MasterPlanGraphOutcome.safeParse(completed).success, true);
	assert.equal(
		MasterPlanGraphOutcome.safeParse({ ...completed, artifact: undefined })
			.success,
		false,
	);

	const safetyWithDraft = {
		...completed,
		decision: "blocked_for_safety",
		reasons: ["acute pain"],
		prerequisites: ["medical clearance"],
	};
	assert.equal(
		MasterPlanGraphOutcome.safeParse(safetyWithDraft).success,
		false,
	);
});

function completedOutcome() {
	const facts = deriveAssessmentFacts(
		createAssessmentSnapshot(),
		createTestRequest(),
	);
	const reviewReports = [
		createTestReviewReport("periodization"),
		createTestReviewReport("load_progression"),
		createTestReviewReport("constraint_grounding"),
	];
	return {
		decision: "completed",
		request_id: "request-342",
		generation_id: "generation-342",
		artifact: {
			type: "master_plan_draft",
			activation_status: "inactive",
			plan: createTestMasterPlan(),
			facts,
			athlete_assessment: createTestAthleteAssessment(),
			goal_assessment: createTestGoalAssessment(),
			strategy_candidates: [
				createTestStrategyCandidate("conservative"),
				createTestStrategyCandidate("balanced"),
			],
			judgments: [
				...createTestJudgments("strategy-conservative-v1"),
				...createTestJudgments("strategy-balanced-v1"),
			],
			selected_strategy: {
				candidate: createTestStrategyCandidate("balanced"),
				scores: {
					performance_path: 4,
					safety_load: 4,
					constraint_feasibility: 4,
					weighted_total: 4,
				},
				weights: {
					performance_path: 0.45,
					safety_load: 0.35,
					constraint_feasibility: 0.2,
				},
				rationale: "balanced wins",
				tradeoffs: ["moderate risk"],
			},
			simulation_report: simulateMasterPlanLoad(
				createTestMasterPlan(),
				createAssessmentSnapshot(),
			),
			rule_report: runMasterPlanRuleFilter(
				createTestMasterPlan(),
				MasterPlanGraphRequest.parse(createTestRequest()),
				createAssessmentSnapshot(),
			),
			artifact_revision: 1,
			review_reports: reviewReports,
			adjudication: adjudicateMasterPlanReviews(1, reviewReports, facts),
			warnings: [],
		},
	};
}

test("completed outcome requires a complete candidate-judgment relationship", () => {
	const outcome = completedOutcome();
	outcome.artifact.judgments = outcome.artifact.judgments.filter(
		(judgment) =>
			!(
				judgment.candidate_id ===
					outcome.artifact.strategy_candidates[0]!.candidate_id &&
				judgment.judge === "safety_load"
			),
	);
	assert.equal(MasterPlanGraphOutcome.safeParse(outcome).success, false);
});
