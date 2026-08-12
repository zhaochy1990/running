import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelConfig } from "../../../config/config.js";
import {
	AthleteAssessmentSchema,
	authoritativeContinuity,
	authoritativeGoalLevel,
	authoritativeReadiness,
	canonicalizeAssessmentSummary,
	GoalAssessmentSchema,
	validateAssessmentReferences,
	validateAthleteAssessmentRanges,
	validateGoalAssessmentTargets,
} from "../assessment.js";
import {
	type MasterPlanGraphDependencies,
	validateSkeletonAgainstStrategy,
} from "../nodes.js";
import { ReviewReportSchema } from "../review.js";
import { runMasterPlanRuleFilter } from "../rules.js";
import {
	MasterPlanSchema,
	StrategyCandidateSchema,
	StrategyJudgmentSchema,
} from "../schemas.js";
import { invokeStructured } from "./structured.js";

export type MasterPlanLlmModels = Pick<
	MasterPlanGraphDependencies,
	| "assessmentModel"
	| "goalAssessmentModel"
	| "strategyModel"
	| "judgmentModel"
	| "skeletonModel"
	| "reviewModel"
>;

export interface MasterPlanLlmOptions {
	masterPlanModel: ModelConfig;
	reviewerModel: ModelConfig;
}

const REVIEWER_TYPES = [
	"periodization",
	"load_progression",
	"constraint_grounding",
] as const;

export async function createMasterPlanLlmModels({
	masterPlanModel,
	reviewerModel,
}: MasterPlanLlmOptions): Promise<MasterPlanLlmModels> {
	const { doctrine, reviewRubrics } = await loadPromptAssets();

	return {
		assessmentModel: {
			async invoke(input) {
				return invokeStructured(
					masterPlanModel,
					AthleteAssessmentSchema,
					"submit_athlete_assessment",
					[
						[
							"system",
							"You are the athlete capability assessor. Submit only the forced function schema. Treat AssessmentFacts as immutable truth. Assess the athlete independently of race-goal feasibility: current capability, evidence confidence, continuity, current and recommended entry phase, limiting factors, assumptions, and safe training boundaries. weekly_distance_km is the peak ceiling; starting_weekly_distance_km is the safe initial range. Allowed claims are only volume_baseline_established, long_run_tolerance_established, quality_tolerance_established, availability_requires_adjustment, load_state_supportive, coverage_sufficient. Do not discuss target improvement, race runway, or A/B/C goals. Every conclusion, factor, assumption, and gap cites fact_ids. Do not prescribe a season strategy.",
						],
						[
							"user",
							JSON.stringify({
								task: "Assess the athlete's current capability and safe planning entry point",
								request: input.request,
								assessment_facts: input.facts,
								snapshot: input.snapshot,
							}),
						],
					],
					(assessment) => {
						const canonical = canonicalizeAssessmentSummary(assessment);
						validateAssessmentReferences(canonical, input.facts);
						validateAthleteAssessmentRanges(
							canonical,
							input.facts,
							input.request,
						);
						if (canonical.readiness !== authoritativeReadiness(input.facts)) {
							throw new Error("readiness conflict");
						}
						if (canonical.continuity !== authoritativeContinuity(input.facts)) {
							throw new Error("continuity conflict");
						}
						return canonical;
					},
				);
			},
		},
		goalAssessmentModel: {
			async invoke(input) {
				return invokeStructured(
					masterPlanModel,
					GoalAssessmentSchema,
					"submit_goal_assessment",
					[
						[
							"system",
							"You are the race-goal feasibility assessor. Submit only the forced function schema. Treat AssessmentFacts and AthleteAssessment as immutable truth. Assess only goal feasibility; do not repeat the athlete capability assessment. Allowed claims are only goal_requires_improvement, goal_runway_limited, goal_supported_by_history. For a timed goal, A is the confirmed target; B is a strictly slower time or the exact matching PB; C is safe completion or a strictly slower time. Every gate must name an observable signal and a concrete criterion that can be evaluated later, such as a race-specific performance, long-run durability, health readiness, fueling execution, or availability consistency. A gate cannot merely say readiness supports the target or restate a historical fact. Cite fact_ids as the evidence that motivates each future criterion. Do not prescribe training. Use multi_cycle_required only for the deterministic extreme-gap case; otherwise multi_cycle_path must be empty.",
						],
						[
							"user",
							JSON.stringify({
								task: "Assess the confirmed race goal against the athlete assessment",
								request: input.request,
								assessment_facts: input.facts,
								athlete_assessment: input.athleteAssessment,
								snapshot: input.snapshot,
							}),
						],
					],
					(assessment) => {
						const canonical = canonicalizeAssessmentSummary(assessment);
						validateAssessmentReferences(canonical, input.facts);
						validateGoalAssessmentTargets(
							canonical,
							input.request,
							input.facts,
						);
						if (
							canonical.level !==
								authoritativeGoalLevel(input.facts, input.athleteAssessment) ||
							(canonical.level !== "multi_cycle_required" &&
								canonical.multi_cycle_path.length > 0)
						) {
							throw new Error("goal classification conflict");
						}
						return canonical;
					},
				);
			},
		},
		strategyModel: {
			async invoke(input) {
				return invokeStructured(
					masterPlanModel,
					StrategyCandidateSchema,
					`submit_${input.archetype}_strategy`,
					[
						[
							"system",
							`Generate exactly one macro strategy for the archetype supplied in the user message. Candidate ID must match the schema. Strategies differ materially but ALL must stay inside AthleteAssessment safe_training_ranges: phase weekly high never exceeds assessed weekly high; planned longest run never exceeds assessed long_run high; quality frequency never exceeds assessed quality high; load-week growth never exceeds 10% across recovery; phase weeks must fit race runway. Aggressive means using the upper safe boundary with stricter gates, never exceeding it. Fill weekly_highs_km, max_long_run_km, max_quality_sessions_per_week, and race_week_index so constraints are machine-checkable. Set hard_constraints_satisfied=false and list violations if any bound cannot be met. Use only supplied fact_ids as evidence. Do not generate weekly sessions yet.\n\n${doctrine}`,
						],
						["user", JSON.stringify(input)],
					],
				);
			},
		},
		judgmentModel: {
			async invoke(input) {
				return invokeStructured(
					reviewerModel,
					StrategyJudgmentSchema,
					`submit_${input.judge}_judgment`,
					[
						[
							"system",
							`Evaluate the judge role supplied in the user message against immutable facts, assessments, confirmed availability, and doctrine. Set veto=true only for a concrete confirmed hard-constraint or safety violation; low score or an ordinary tradeoff is not a veto. Use candidate_id exactly and cite only existing fact_ids.\n\n${doctrine}`,
						],
						["user", JSON.stringify(input)],
					],
				);
			},
		},
		skeletonModel: {
			async invoke(input) {
				return invokeStructured(
					masterPlanModel,
					MasterPlanSchema,
					"submit_master_plan_skeleton",
					[
						[
							"system",
							`Generate the complete strategic Master Plan JSON in Chinese from the selected strategy. Cover every Monday-Sunday week from the current planning week through race day plus two recovery weeks. Use 1-3 strategic key sessions only; no ordinary easy/recovery/filler runs. Recovery weeks have at most one key session; race week contains only race. Respect max session duration and confirmed goal. MP/HMP work embedded in a long run stays one long_run. Do not place two heavy marathon-specific long runs in consecutive weeks: the week before the maximal specific rehearsal must be an absorption week or use an easy/shorter long run with materially less MP exposure. Every week must fall inside its named phase date range and weekly volume range; each phase low must be <= the minimum weekly low inside that phase and each phase high must be >= the maximum weekly high. For every index before and including race week, copy selectedStrategy.candidate.weekly_highs_km exactly into weeks[index].target_weekly_km_high; do not optimize or round it. The race session must be at selectedStrategy.candidate.race_week_index. Non-recovery/pre-race weeks stay within AthleteAssessment safe high; long runs do not exceed selectedStrategy.max_long_run_km; hard running stimuli do not exceed selectedStrategy.max_quality_sessions_per_week. status=draft, generated_by=coach_agent, version=1, UTC timestamps.\n\n${doctrine}`,
						],
						["user", JSON.stringify(input)],
					],
					(plan) => {
						const report = runMasterPlanRuleFilter(
							plan,
							input.request,
							input.snapshot,
						);
						if (report.has_errors) {
							const errors = report.violations
								.filter((item) => item.severity === "error")
								.map((item) => `${item.rule_id}:${item.message}`)
								.join("; ");
							throw new Error(`deterministic rule errors: ${errors}`);
						}
						validateSkeletonAgainstStrategy(
							plan,
							input.selectedStrategy,
							input.athleteAssessment,
						);
						return plan;
					},
				);
			},
		},
		reviewModel: {
			async invoke(input) {
				const rubric = reviewRubrics[input.reviewerType];
				return invokeStructured(
					reviewerModel,
					ReviewReportSchema,
					`submit_${input.reviewerType}_review`,
					[
						[
							"system",
							`You are an independent Master Plan reviewer. Follow this versioned rubric exactly. Return the supplied review_task_id, reviewer_type, artifact_revision, rubric_version='rubric-v1', prompt_version='prompt-v1'. Use exactly the rubric score axes. Every report must cite evidence_refs using fact:<fact_id>, simulation:<field/path>, rule:<rule_id>, or system:<reason>. A pass has no issues; every non-pass has issues. Every issue must include at least one evidence_ref and include evidence_fact_ids for referenced facts.\n\n${rubric}`,
						],
						["user", JSON.stringify(input)],
					],
				);
			},
		},
	};
}

async function loadPromptAssets() {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const doctrine = await readFile(
		resolve(moduleDir, "../doctrine/planning.md"),
		"utf8",
	);
	const reviewRubricEntries = await Promise.all(
		REVIEWER_TYPES.map(
			async (name) =>
				[
					name,
					await readFile(
						resolve(moduleDir, `../doctrine/review/${name}.md`),
						"utf8",
					),
				] as const,
		),
	);

	return {
		doctrine,
		reviewRubrics: Object.fromEntries(reviewRubricEntries) as Record<
			(typeof REVIEWER_TYPES)[number],
			string
		>,
	};
}
