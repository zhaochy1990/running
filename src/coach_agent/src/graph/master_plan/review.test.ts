import assert from "node:assert/strict";
import test from "node:test";
import {
	adjudicateMasterPlanReviews,
	mergeReviewReportsByRevisionAndTask,
	mergeReviewWorkerErrors,
	type ReviewReport,
} from "./review.js";
import { deriveAssessmentFacts } from "./assessment.js";
import { createAssessmentSnapshot, createTestRequest } from "./testFixtures.js";

const reviewerTypes = [
	"periodization",
	"load_progression",
	"constraint_grounding",
] as const;
const facts = deriveAssessmentFacts(
	createAssessmentSnapshot(),
	createTestRequest(),
);

function report(
	reviewerType: (typeof reviewerTypes)[number],
	overrides: Partial<ReviewReport> = {},
): ReviewReport {
	return {
		review_task_id: `master-plan:r1:${reviewerType}:rubric-v1:prompt-v1`,
		reviewer_type: reviewerType,
		artifact_revision: 1,
		rubric_version: "rubric-v1",
		prompt_version: "prompt-v1",
		verdict: "pass",
		scores:
			reviewerType === "periodization"
				? {
						season_structure: 5,
						peak_timing: 5,
						recovery_absorption: 5,
						taper_quality: 5,
					}
				: reviewerType === "load_progression"
					? {
							volume_progression: 5,
							dose_trajectory: 5,
							hard_stimulus_density: 5,
							long_run_concentration: 5,
						}
					: {
							goal_fidelity: 5,
							availability_fit: 5,
							evidence_grounding: 5,
							selected_strategy_fidelity: 5,
						},
		evidence_refs: ["fact:volume.recent_weekly_km"],
		issues: [],
		rationale: `${reviewerType} passed`,
		confidence: 0.9,
		...overrides,
	};
}

test("review reducer is completion-order independent and deduplicates a stable task key", () => {
	const first = report("periodization", { confidence: 0.7 });
	const duplicate = report("periodization", { confidence: 0.7 });
	const forward = mergeReviewReportsByRevisionAndTask([], [first, duplicate]);
	const reverse = mergeReviewReportsByRevisionAndTask([], [duplicate, first]);
	assert.deepEqual(forward, reverse);
	assert.equal(forward.length, 1);
	assert.equal(forward[0]?.confidence, 0.7);
	assert.throws(
		() =>
			mergeReviewReportsByRevisionAndTask(
				[],
				[first, report("periodization", { confidence: 0.9 })],
			),
		/conflicting duplicate/,
	);
});

test("review reducer ignores stale artifact revisions regardless of completion order", () => {
	const stale = report("periodization");
	const current = {
		...report("periodization"),
		artifact_revision: 2,
		review_task_id: "master-plan:r2:periodization:rubric-v1:prompt-v1",
	};
	assert.deepEqual(mergeReviewReportsByRevisionAndTask([current], [stale]), [
		current,
	]);
	assert.deepEqual(mergeReviewReportsByRevisionAndTask([stale], [current]), [
		current,
	]);
});

test("adjudicator applies hard and block vetoes instead of majority voting", () => {
	const blocked = report("constraint_grounding", {
		verdict: "block",
		issues: [
			{
				issue_id: "confirmed-rest-day-violation",
				severity: "hard",
				evidence_fact_ids: ["frequency.recent_run_days_per_week"],
				evidence_refs: ["fact:frequency.recent_run_days_per_week"],
				target_path: "/weeks/0",
				suggested_action: "Restore the confirmed rest day.",
			},
		],
	});
	const result = adjudicateMasterPlanReviews(
		1,
		[report("periodization"), report("load_progression"), blocked],
		facts,
	);
	assert.equal(result.decision, "block");
	assert.equal(result.issues.length, 1);
});

test("adjudicator returns pass_with_warnings and stably merges duplicate issue targets", () => {
	const issue = {
		issue_id: "late-peak",
		severity: "warning" as const,
		evidence_fact_ids: ["race.a.weeks_to_race"],
		evidence_refs: ["fact:race.a.weeks_to_race"],
		target_path: "/phases/2",
		suggested_action: "Check peak timing.",
	};
	const result = adjudicateMasterPlanReviews(
		1,
		[
			report("periodization", { verdict: "warning", issues: [issue] }),
			report("load_progression", {
				verdict: "warning",
				issues: [{ ...issue, suggested_action: "Move peak earlier." }],
			}),
			report("constraint_grounding"),
		],
		facts,
	);
	assert.equal(result.decision, "pass_with_warnings");
	assert.equal(result.issues.length, 1);
	assert.equal(result.issues[0]?.suggested_action, "Move peak earlier.");
});

test("review worker error reduction is completion-order independent", () => {
	const contract = {
		review_task_id: "task",
		reviewer_type: "periodization" as const,
		artifact_revision: 1,
		kind: "contract" as const,
		code: "review_contract_invalid",
	};
	const infrastructure = {
		...contract,
		kind: "infrastructure" as const,
		code: "review_model_unavailable",
	};
	assert.deepEqual(
		mergeReviewWorkerErrors([], [contract, infrastructure]),
		mergeReviewWorkerErrors([], [infrastructure, contract]),
	);
	assert.equal(
		mergeReviewWorkerErrors([], [contract, infrastructure])[0]?.kind,
		"infrastructure",
	);
});

test("adjudicator blocks a missing required reviewer and rejects unknown evidence IDs", () => {
	const missing = adjudicateMasterPlanReviews(
		1,
		[report("periodization"), report("load_progression")],
		facts,
	);
	assert.equal(missing.decision, "block");
	assert.ok(
		missing.issues.some(
			(issue) => issue.issue_id === "missing-reviewer-constraint-grounding",
		),
	);

	assert.throws(
		() =>
			adjudicateMasterPlanReviews(
				1,
				[
					report("periodization", {
						verdict: "revise",
						issues: [
							{
								issue_id: "unsupported",
								severity: "error",
								evidence_fact_ids: ["not.a.fact"],
								evidence_refs: ["fact:not.a.fact"],
								target_path: "/goal",
								suggested_action: "Use real evidence.",
							},
						],
					}),
					report("load_progression"),
					report("constraint_grounding"),
				],
				facts,
			),
		/unknown evidence fact_id/,
	);
});

test("adjudicator rejects unknown rule and simulation evidence", () => {
	const evidence = {
		simulation: {
			algorithm_version: "master-plan-load-v1" as const,
			estimated: true as const,
			provenance: "test",
			weeks: [],
		},
		rules: {
			authority: "typescript-master-plan-rule-filter-v1" as const,
			checked_rule_ids: ["schema_validity"],
			violations: [],
			has_errors: false,
		},
	};
	assert.throws(
		() =>
			adjudicateMasterPlanReviews(
				1,
				[
					report("periodization", { evidence_refs: ["rule:not-a-rule"] }),
					report("load_progression"),
					report("constraint_grounding"),
				],
				facts,
				evidence,
			),
		/unknown rule evidence/,
	);
	assert.throws(
		() =>
			adjudicateMasterPlanReviews(
				1,
				[
					report("periodization", { evidence_refs: ["simulation:missing"] }),
					report("load_progression"),
					report("constraint_grounding"),
				],
				facts,
				evidence,
			),
		/unknown simulation evidence/,
	);
});
