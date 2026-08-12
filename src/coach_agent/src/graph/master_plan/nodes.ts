import { END, ReducedValue, Send, StateSchema } from "@langchain/langgraph";
import { z } from "zod/v4";
import { getLogger } from "../../utils/logger.js";
import { measureExecutionTimeAsync } from "../../utils/performance.js";
import {
	type AssessmentFacts,
	type AthleteAssessment,
	AthleteAssessmentSchema,
	authoritativeGoalLevel,
	authoritativeReadiness,
	canonicalizeAssessmentSummary,
	deriveAssessmentFacts,
	type GoalAssessment,
	GoalAssessmentSchema,
	validateAssessmentReferences,
	validateAthleteAssessmentRanges,
	validateGoalAssessmentTargets,
} from "./assessment.js";
import {
	type ContextSnapshot,
	ContextSnapshotSchema,
	type MasterPlanContextProvider,
} from "./context.js";
import {
	MasterPlanGraphContext,
	MasterPlanGraphOutcome,
	MasterPlanGraphRequest,
} from "./contracts.js";
import {
	adjudicateMasterPlanReviews,
	mergeReviewReportsByRevisionAndTask,
	mergeReviewWorkerErrors,
	REQUIRED_REVIEWERS,
	type ReviewAdjudication,
	type ReviewerType,
	ReviewReportSchema,
	type ReviewWorkerError,
	ReviewWorkerErrorSchema,
	reviewTaskId,
} from "./review.js";
import { type RuleReport, runMasterPlanRuleFilter } from "./rules.js";
import {
	MasterPlanSchema,
	type SelectedStrategy,
	SelectedStrategySchema,
	StrategyArchetypeSchema,
	type StrategyCandidate,
	StrategyCandidateSchema,
	type StrategyJudgment,
	StrategyJudgmentSchema,
} from "./schemas.js";
import { type SimulationReport, simulateMasterPlanLoad } from "./simulation.js";
import {
	aggregateStrategySelection,
	mergeCandidatesByStableId,
	mergeJudgmentsByStableKey,
	mergeWorkerErrors,
	validateCandidateDiversity,
	validateStrategyCandidate,
	validateStrategyJudgment,
} from "./strategy.js";

type StrategyArchetype = z.infer<typeof StrategyArchetypeSchema>;
type Judge = StrategyJudgment["judge"];

interface SkeletonModel {
	invoke(input: {
		request: MasterPlanGraphRequest;
		context: MasterPlanGraphContext;
		snapshot: ContextSnapshot;
		facts: AssessmentFacts;
		athleteAssessment: AthleteAssessment;
		goalAssessment: GoalAssessment;
		selectedStrategy: SelectedStrategy;
	}): Promise<unknown>;
}
interface AssessmentModel {
	invoke(input: {
		request: MasterPlanGraphRequest;
		snapshot: ContextSnapshot;
		facts: AssessmentFacts;
	}): Promise<unknown>;
}
interface StrategyModel {
	invoke(input: {
		archetype: StrategyArchetype;
		request: MasterPlanGraphRequest;
		snapshot: ContextSnapshot;
		facts: AssessmentFacts;
		athleteAssessment: AthleteAssessment;
		goalAssessment: GoalAssessment;
	}): Promise<unknown>;
}
interface JudgmentModel {
	invoke(input: {
		judge: Judge;
		candidate: StrategyCandidate;
		request: MasterPlanGraphRequest;
		facts: AssessmentFacts;
		athleteAssessment: AthleteAssessment;
		goalAssessment: GoalAssessment;
	}): Promise<unknown>;
}
interface ReviewModel {
	invoke(input: {
		reviewerType: ReviewerType;
		reviewTaskId: string;
		artifactRevision: number;
		request: MasterPlanGraphRequest;
		plan: z.infer<typeof MasterPlanSchema>;
		facts: AssessmentFacts;
		athleteAssessment: AthleteAssessment;
		goalAssessment: GoalAssessment;
		selectedStrategy: SelectedStrategy;
		simulationReport: SimulationReport;
		ruleReport: RuleReport;
	}): Promise<unknown>;
}

export interface MasterPlanGraphDependencies {
	contextProvider: MasterPlanContextProvider;
	assessmentModel: AssessmentModel;
	goalAssessmentModel: AssessmentModel;
	strategyModel: StrategyModel;
	judgmentModel: JudgmentModel;
	reviewModel: ReviewModel;
	skeletonModel: SkeletonModel;
	strategyArchetypes?: readonly StrategyArchetype[];
	artifactRevision?: number;
}

export class ModelContractError extends Error {}

export const GraphInput = new StateSchema({ request: MasterPlanGraphRequest });
export const GraphOutput = new StateSchema({ outcome: MasterPlanGraphOutcome });
export const GraphState = new StateSchema({
	request: MasterPlanGraphRequest,
	context: MasterPlanGraphContext.optional(),
	snapshot: ContextSnapshotSchema.optional(),
	facts: z.custom<AssessmentFacts>().optional(),
	athleteAssessment: AthleteAssessmentSchema.optional(),
	goalAssessment: GoalAssessmentSchema.optional(),
	strategyArchetype: StrategyArchetypeSchema.optional(),
	judge: StrategyJudgmentSchema.shape.judge.optional(),
	candidate: StrategyCandidateSchema.optional(),
	strategyCandidates: new ReducedValue(
		z.array(StrategyCandidateSchema).default(() => []),
		{ reducer: mergeCandidatesByStableId },
	),
	judgments: new ReducedValue(
		z.array(StrategyJudgmentSchema).default(() => []),
		{ reducer: mergeJudgmentsByStableKey },
	),
	workerErrors: new ReducedValue(
		z.array(z.string()).default(() => []),
		{ reducer: mergeWorkerErrors },
	),
	selectedStrategy: SelectedStrategySchema.optional(),
	plan: MasterPlanSchema.optional(),
	outcome: MasterPlanGraphOutcome.optional(),
	simulationReport: z.custom<SimulationReport>().optional(),
	ruleReport: z.custom<RuleReport>().optional(),
	reviewerType: z.custom<ReviewerType>().optional(),
	reviewTaskId: z.string().optional(),
	artifactRevision: z.int().positive().default(1),
	reviewReports: new ReducedValue(
		z.array(ReviewReportSchema).default(() => []),
		{ reducer: mergeReviewReportsByRevisionAndTask },
	),
	reviewWorkerErrors: new ReducedValue(
		z.array(ReviewWorkerErrorSchema).default(() => []),
		{ reducer: mergeReviewWorkerErrors },
	),
	adjudication: z.custom<ReviewAdjudication>().optional(),
});

const logger = getLogger("master-plan-graph");
const DEFAULT_STRATEGY_ARCHETYPES: readonly StrategyArchetype[] = [
	"conservative",
	"balanced",
	"aggressive_gated",
];

/** Node implementations and routing helpers for the planning graph. */
class MasterPlanNodes {
	private readonly archetypes: readonly StrategyArchetype[];

	constructor(private readonly dependencies: MasterPlanGraphDependencies) {
		this.archetypes =
			dependencies.strategyArchetypes ?? DEFAULT_STRATEGY_ARCHETYPES;
		if (
			this.archetypes.length < 2 ||
			this.archetypes.length > 3 ||
			new Set(this.archetypes).size !== this.archetypes.length
		) {
			throw new Error("strategyArchetypes must contain 2-3 unique archetypes");
		}
	}

	readonly initialize = async (
		state: typeof GraphState.State,
		runtime: { context?: MasterPlanGraphContext },
	) => {
		const request = MasterPlanGraphRequest.parse(state.request);
		const context = MasterPlanGraphContext.parse(runtime.context);

		const artifactRevision = 1;
		if (request.requested_mode !== "new_season") {
			logger.warn(`Requested mode ${request.requested_mode} is not supported`);
			return {
				context,
				artifactRevision,
				outcome: MasterPlanGraphOutcome.parse({
					decision: "unsupported",
					request_id: request.request_id,
					generation_id: context.generationId,
					artifact: {
						type: "capability_gap",
						requested_mode: request.requested_mode,
						supported_modes: ["new_season"],
					},
				}),
			};
		}

		let snapshot: ContextSnapshot;
		try {
			const res = await measureExecutionTimeAsync(() =>
				this.dependencies.contextProvider.loadSnapshot(
					context.userId,
					request.requested_as_of,
				),
			);
			snapshot = res.result;
			logger.info(
				`Loaded context snapshot for user ${context.userId} as of ${snapshot.as_of} in ${res.time.toFixed(2)} ms`,
			);
		} catch (e) {
			logger.error(
				`Failed to load context snapshot for user ${context.userId}: ${e instanceof Error ? e.message : "unknown error"}`,
			);
			return {
				context,
				outcome: infrastructureFailure(
					request,
					context,
					"context_snapshot_unavailable",
				),
			};
		}
		// const safetyReasons = explicitAcuteRestrictions(request, snapshot);
		// if (safetyReasons.length > 0)
		//   return {
		//     context,
		//     snapshot,
		//     outcome: MasterPlanGraphOutcome.parse({
		//       decision: "blocked_for_safety",
		//       request_id: request.request_id,
		//       generation_id: context.generationId,
		//       reasons: safetyReasons,
		//       prerequisites: [
		//         "Obtain clinical clearance or an explicit return-to-run restriction update",
		//       ],
		//     }),
		//   };

		const facts = deriveAssessmentFacts(snapshot, request);
		const volume = facts.facts.find(
			(fact) => fact.fact_id === "volume.recent_weekly_km",
		)?.value;
		const frequency = facts.facts.find(
			(fact) => fact.fact_id === "frequency.recent_run_days_per_week",
		)?.value;
		if (
			typeof volume !== "number" ||
			volume <= 0 ||
			typeof frequency !== "number" ||
			frequency <= 0
		)
			return {
				context,
				snapshot,
				facts,
				outcome: MasterPlanGraphOutcome.parse({
					decision: "needs_baseline",
					request_id: request.request_id,
					generation_id: context.generationId,
					artifact: {
						type: "baseline_requirements",
						missing: ["positive recent running volume and frequency"],
						next_steps: [
							"Record at least two representative running weeks before season planning",
						],
					},
				}),
			};
		return { context, snapshot, facts, artifactRevision };
	};

	readonly assessAthlete = async (state: typeof GraphState.State) => {
		const { request, snapshot, facts, context } = required(state);
		try {
			const assessment = canonicalizeAssessmentSummary(
				AthleteAssessmentSchema.parse(
					await this.dependencies.assessmentModel.invoke({
						request,
						snapshot,
						facts,
					}),
				),
			);
			validateAssessmentReferences(assessment, facts);
			validateAthleteAssessmentRanges(assessment, facts, request);
			if (assessment.readiness !== authoritativeReadiness(facts))
				throw new Error("readiness conflict");
			if (assessment.readiness === "missing_baseline")
				return {
					outcome: MasterPlanGraphOutcome.parse({
						decision: "needs_baseline",
						request_id: request.request_id,
						generation_id: context.generationId,
						artifact: {
							type: "baseline_requirements",
							missing: assessment.gaps.length
								? assessment.gaps.map((gap) => gap.description)
								: ["assessment baseline"],
							next_steps: [
								"Collect the missing baseline evidence and reassess without changing the confirmed goal",
							],
						},
					}),
				};
			return { athleteAssessment: assessment };
		} catch (error) {
			return {
				outcome: modelFailure(
					error,
					request,
					context,
					"athlete_assessment_contract_invalid",
					"assessment_model_unavailable",
				),
			};
		}
	};

	readonly assessGoal = async (state: typeof GraphState.State) => {
		const { request, snapshot, facts, context } = required(state);
		try {
			const assessment = canonicalizeAssessmentSummary(
				GoalAssessmentSchema.parse(
					await this.dependencies.goalAssessmentModel.invoke({
						request,
						snapshot,
						facts,
					}),
				),
			);
			validateAssessmentReferences(assessment, facts);
			validateGoalAssessmentTargets(assessment, request, facts);
			if (
				assessment.level !== authoritativeGoalLevel(facts) ||
				(assessment.level !== "multi_cycle_required" &&
					assessment.multi_cycle_path.length)
			)
				throw new Error("goal assessment conflict");
			if (assessment.level === "multi_cycle_required")
				return {
					outcome: MasterPlanGraphOutcome.parse({
						decision: "multi_cycle_required",
						request_id: request.request_id,
						generation_id: context.generationId,
						artifact: {
							type: "multi_cycle_path",
							cycles:
								assessment.multi_cycle_path.length >= 2
									? assessment.multi_cycle_path
									: [
											"Develop the required baseline",
											"Reassess the confirmed target",
										],
						},
					}),
				};
			if (assessment.level === "unsafe_or_incompatible")
				return {
					outcome: MasterPlanGraphOutcome.parse({
						decision: "goal_conflict",
						request_id: request.request_id,
						generation_id: context.generationId,
						artifact: {
							type: "goal_options",
							conflicts: assessment.conflicts.length
								? assessment.conflicts.map((conflict) => conflict.description)
								: [assessment.summary],
							options: [
								"Keep the confirmed A goal as an unplanned aspiration",
								"Explicitly confirm a compatible planning target",
							],
						},
					}),
				};
			return { goalAssessment: assessment };
		} catch (error) {
			return {
				outcome: modelFailure(
					error,
					request,
					context,
					"goal_assessment_contract_invalid",
					"assessment_model_unavailable",
				),
			};
		}
	};

	readonly strategyWorker = async (state: typeof GraphState.State) => {
		const { request, snapshot, facts, athleteAssessment, goalAssessment } =
			requiredWithAssessments(state);
		try {
			const candidate = StrategyCandidateSchema.parse(
				await this.dependencies.strategyModel.invoke({
					archetype: state.strategyArchetype!,
					request,
					snapshot,
					facts,
					athleteAssessment,
					goalAssessment,
				}),
			);
			validateStrategyCandidate(candidate, facts, athleteAssessment);
			return { strategyCandidates: [candidate] };
		} catch (error) {
			return {
				workerErrors: [
					isInfrastructureError(error)
						? "infra:strategy_model_unavailable"
						: "quality:strategy_candidate_invalid",
				],
			};
		}
	};

	readonly judgeWorker = async (state: typeof GraphState.State) => {
		const { request, facts, athleteAssessment, goalAssessment } =
			requiredWithAssessments(state);
		try {
			const judgment = StrategyJudgmentSchema.parse(
				await this.dependencies.judgmentModel.invoke({
					judge: state.judge!,
					candidate: state.candidate!,
					request,
					facts,
					athleteAssessment,
					goalAssessment,
				}),
			);
			validateStrategyJudgment(judgment, state.candidate!, facts);
			return { judgments: [judgment] };
		} catch (error) {
			return {
				workerErrors: [
					isInfrastructureError(error)
						? "infra:strategy_judgment_unavailable"
						: "quality:strategy_judgment_invalid",
				],
			};
		}
	};

	readonly dispatchJudges = (state: typeof GraphState.State) => {
		if (state.workerErrors.length) return { outcome: workerFailure(state) };
		try {
			validateCandidateDiversity(state.strategyCandidates);
			return {};
		} catch {
			return {
				outcome: qualityFailure(
					state.request,
					state.context!,
					"strategy_candidates_not_distinct",
				),
			};
		}
	};

	readonly selectStrategy = (state: typeof GraphState.State) => {
		if (state.workerErrors.length) return { outcome: workerFailure(state) };
		try {
			return {
				selectedStrategy: aggregateStrategySelection(
					state.strategyCandidates,
					state.judgments,
				),
			};
		} catch {
			const { request, context } = required(state);
			return {
				outcome: qualityFailure(request, context, "no_eligible_strategy"),
			};
		}
	};

	readonly expandSkeleton = async (state: typeof GraphState.State) => {
		const {
			request,
			snapshot,
			facts,
			context,
			athleteAssessment,
			goalAssessment,
		} = requiredWithAssessments(state);
		let raw: unknown;
		try {
			raw = await this.dependencies.skeletonModel.invoke({
				request,
				context,
				snapshot,
				facts,
				athleteAssessment,
				goalAssessment,
				selectedStrategy: state.selectedStrategy!,
			});
		} catch (error) {
			return {
				outcome: isContractError(error)
					? qualityFailure(request, context, "candidate_plan_contract_invalid")
					: infrastructureFailure(
							request,
							context,
							"skeleton_model_unavailable",
						),
			};
		}
		const schemaReport = runMasterPlanRuleFilter(raw, request, snapshot);
		if (
			schemaReport.violations.some((item) => item.rule_id === "schema_validity")
		)
			return {
				ruleReport: schemaReport,
				outcome: qualityFailureWithRuleReport(request, context, schemaReport),
			};
		const plan = MasterPlanSchema.parse(raw);
		return { plan };
	};

	readonly finalize = (state: typeof GraphState.State) => {
		const { request, context, facts, athleteAssessment, goalAssessment } =
			requiredWithAssessments(state);
		const plan = state.plan!;
		const goal =
			request.goals.find((item) => item.priority === "A") ?? request.goals[0]!;
		if (
			plan.goal.race_name !== goal.race_name ||
			plan.goal.location !== goal.location ||
			plan.goal.distance !== goal.distance ||
			plan.goal.race_date !== goal.race_date ||
			plan.goal.target_time !== (goal.target_time ?? "finish_only")
		)
			return {
				outcome: qualityFailure(
					request,
					context,
					"candidate_plan_changed_confirmed_goal",
				),
			};
		return {
			outcome: MasterPlanGraphOutcome.parse({
				decision: "completed",
				request_id: request.request_id,
				generation_id: context.generationId,
				artifact: {
					type: "master_plan_draft",
					activation_status: "inactive",
					plan,
					facts,
					athlete_assessment: athleteAssessment,
					goal_assessment: goalAssessment,
					strategy_candidates: state.strategyCandidates,
					judgments: state.judgments,
					selected_strategy: state.selectedStrategy,
					simulation_report: state.simulationReport,
					rule_report: state.ruleReport,
					artifact_revision: state.artifactRevision,
					review_reports: state.reviewReports,
					adjudication: state.adjudication,
					warnings:
						state.adjudication?.issues
							.filter((item) => item.severity === "warning")
							.map((item) => item.issue_id) ?? [],
				},
			}),
		};
	};

	readonly simulateLoad = (state: typeof GraphState.State) => {
		try {
			return {
				simulationReport: simulateMasterPlanLoad(
					state.plan!,
					state.snapshot!,
					state.request,
				),
			};
		} catch (error) {
			return {
				outcome: qualityFailure(
					state.request,
					state.context!,
					`load_simulation_failed:${error instanceof Error ? error.message : "unknown"}`,
				),
			};
		}
	};

	readonly filterRules = (state: typeof GraphState.State) => {
		const report = runMasterPlanRuleFilter(
			state.plan!,
			state.request,
			state.snapshot!,
		);
		return report.has_errors
			? {
					ruleReport: report,
					outcome: qualityFailureWithReports(
						state.request,
						state.context!,
						state.simulationReport!,
						report,
					),
				}
			: { ruleReport: report };
	};

	readonly validateSelected = (state: typeof GraphState.State) => {
		try {
			validateSkeletonAgainstStrategy(
				state.plan!,
				state.selectedStrategy!,
				state.athleteAssessment!,
			);
			return {};
		} catch (error) {
			return {
				outcome: qualityFailureWithReports(
					state.request,
					state.context!,
					state.simulationReport!,
					state.ruleReport!,
					`candidate_plan_strategy_mismatch:${error instanceof Error ? error.message : "unknown"}`,
				),
			};
		}
	};

	readonly reviewWorker = async (state: typeof GraphState.State) => {
		const input = {
			reviewerType: state.reviewerType!,
			reviewTaskId: state.reviewTaskId!,
			artifactRevision: state.artifactRevision,
			request: state.request,
			plan: state.plan!,
			facts: state.facts!,
			athleteAssessment: state.athleteAssessment!,
			goalAssessment: state.goalAssessment!,
			selectedStrategy: state.selectedStrategy!,
			simulationReport: state.simulationReport!,
			ruleReport: state.ruleReport!,
		};
		try {
			const report = ReviewReportSchema.parse(
				await this.dependencies.reviewModel.invoke(input),
			);
			if (
				report.review_task_id !== input.reviewTaskId ||
				report.reviewer_type !== input.reviewerType ||
				report.artifact_revision !== input.artifactRevision
			)
				throw new Error("review identity mismatch");
			return { reviewReports: [report] };
		} catch (error) {
			return {
				reviewWorkerErrors: [
					ReviewWorkerErrorSchema.parse({
						review_task_id: input.reviewTaskId,
						reviewer_type: input.reviewerType,
						artifact_revision: input.artifactRevision,
						kind: isInfrastructureError(error) ? "infrastructure" : "contract",
						code: isInfrastructureError(error)
							? "review_model_unavailable"
							: "review_contract_invalid",
					}),
				],
			};
		}
	};

	readonly adjudicateReviews = (state: typeof GraphState.State) => {
		const currentErrors = state.reviewWorkerErrors.filter(
			(item) => item.artifact_revision === state.artifactRevision,
		);
		if (currentErrors.some((item) => item.kind === "infrastructure"))
			return {
				outcome: infrastructureFailure(
					state.request,
					state.context!,
					"review_model_unavailable",
				),
			};
		if (currentErrors.length)
			return {
				outcome: qualityFailureWithReviews(
					state,
					"review_contract_invalid",
					undefined,
					currentErrors,
				),
			};
		try {
			const adjudication = adjudicateMasterPlanReviews(
				state.artifactRevision,
				state.reviewReports,
				state.facts!,
				{ simulation: state.simulationReport!, rules: state.ruleReport! },
			);
			return adjudication.decision === "pass" ||
				adjudication.decision === "pass_with_warnings"
				? { adjudication }
				: {
						adjudication,
						outcome: qualityFailureWithReviews(
							state,
							`review_${adjudication.decision}`,
							adjudication,
						),
					};
		} catch {
			return {
				outcome: qualityFailureWithReviews(
					state,
					"review_adjudication_invalid",
				),
			};
		}
	};

	readonly stopOr = (next: string) => (state: typeof GraphState.State) =>
		state.outcome ? END : next;
	readonly fanStrategies = (state: typeof GraphState.State) =>
		this.archetypes.map(
			(archetype) =>
				new Send("strategy_worker", {
					...sharedWorkerState(state),
					strategyArchetype: archetype,
				}),
		);
	readonly fanJudges = (state: typeof GraphState.State) =>
		state.strategyCandidates.flatMap((candidate) =>
			JUDGES.map(
				(judge) =>
					new Send("judge_worker", {
						...sharedWorkerState(state),
						candidate,
						judge,
					}),
			),
		);
	readonly fanReviewers = (state: typeof GraphState.State) =>
		REQUIRED_REVIEWERS.map(
			(reviewerType) =>
				new Send("review_worker", {
					...sharedWorkerState(state),
					plan: state.plan,
					simulationReport: state.simulationReport,
					ruleReport: state.ruleReport,
					artifactRevision: state.artifactRevision,
					reviewerType,
					reviewTaskId: reviewTaskId(reviewerType, state.artifactRevision),
				}),
		);
}

const JUDGES: readonly Judge[] = [
	"performance_path",
	"safety_load",
	"constraint_feasibility",
];

/** Bind graph dependencies once and expose ready-to-register node functions. */
export function createMasterPlanNodes(
	dependencies: MasterPlanGraphDependencies,
) {
	return new MasterPlanNodes(dependencies);
}

function sharedWorkerState(state: typeof GraphState.State) {
	return {
		request: state.request,
		context: state.context,
		snapshot: state.snapshot,
		facts: state.facts,
		athleteAssessment: state.athleteAssessment,
		goalAssessment: state.goalAssessment,
	};
}
function required(state: typeof GraphState.State) {
	return {
		request: state.request,
		context: state.context!,
		snapshot: state.snapshot!,
		facts: state.facts!,
	};
}
function requiredWithAssessments(state: typeof GraphState.State) {
	return {
		...required(state),
		athleteAssessment: state.athleteAssessment!,
		goalAssessment: state.goalAssessment!,
	};
}
function isContractError(error: unknown) {
	return error instanceof ModelContractError || error instanceof z.ZodError;
}
function modelFailure(
	error: unknown,
	request: MasterPlanGraphRequest,
	context: MasterPlanGraphContext,
	issue: string,
	code: string,
) {
	return isContractError(error) ||
		!(error instanceof Error) ||
		!/(?:timeout|ECONN|network|unavailable)/i.test(error.message)
		? qualityFailure(request, context, issue)
		: infrastructureFailure(request, context, code);
}
function isInfrastructureError(error: unknown): boolean {
	return (
		error instanceof Error &&
		/(?:timeout|ECONN|network|unavailable|rate limit|429|5\d\d)/i.test(
			error.message,
		)
	);
}
function workerFailure(state: typeof GraphState.State) {
	const error = state.workerErrors[0]!;
	return error.startsWith("infra:")
		? infrastructureFailure(state.request, state.context!, error.slice(6))
		: qualityFailure(
				state.request,
				state.context!,
				error.replace(/^quality:/, ""),
			);
}
function infrastructureFailure(
	request: MasterPlanGraphRequest,
	context: MasterPlanGraphContext,
	code: string,
) {
	return MasterPlanGraphOutcome.parse({
		decision: "infrastructure_failure",
		request_id: request.request_id,
		generation_id: context.generationId,
		code,
		retryable: true,
	});
}
function qualityFailure(
	request: MasterPlanGraphRequest,
	context: MasterPlanGraphContext,
	...issues: string[]
) {
	return MasterPlanGraphOutcome.parse({
		decision: "failed_quality_gate",
		request_id: request.request_id,
		generation_id: context.generationId,
		artifact: {
			type: "quality_failure_report",
			unresolved_issues: issues.length ? issues : ["quality_gate_failed"],
			attempt_history: [],
		},
	});
}
function qualityFailureWithReports(
	request: MasterPlanGraphRequest,
	context: MasterPlanGraphContext,
	simulation: SimulationReport,
	rules: RuleReport,
	...additionalIssues: string[]
) {
	return MasterPlanGraphOutcome.parse({
		decision: "failed_quality_gate",
		request_id: request.request_id,
		generation_id: context.generationId,
		artifact: {
			type: "quality_failure_report",
			unresolved_issues: [
				...rules.violations
					.filter((item) => item.severity === "error")
					.map((item) => item.rule_id),
				...additionalIssues,
			],
			attempt_history: [],
			simulation_report: simulation,
			rule_report: rules,
		},
	});
}
function qualityFailureWithRuleReport(
	request: MasterPlanGraphRequest,
	context: MasterPlanGraphContext,
	rules: RuleReport,
) {
	return MasterPlanGraphOutcome.parse({
		decision: "failed_quality_gate",
		request_id: request.request_id,
		generation_id: context.generationId,
		artifact: {
			type: "quality_failure_report",
			unresolved_issues: rules.violations
				.filter((item) => item.severity === "error")
				.map((item) => item.rule_id),
			attempt_history: [],
			rule_report: rules,
		},
	});
}
function qualityFailureWithReviews(
	state: typeof GraphState.State,
	issue: string,
	adjudication?: ReviewAdjudication,
	errors: ReviewWorkerError[] = [],
) {
	return MasterPlanGraphOutcome.parse({
		decision: "failed_quality_gate",
		request_id: state.request.request_id,
		generation_id: state.context!.generationId,
		artifact: {
			type: "quality_failure_report",
			unresolved_issues: [issue],
			attempt_history: [],
			simulation_report: state.simulationReport,
			rule_report: state.ruleReport,
			review_reports: state.reviewReports,
			review_worker_errors: errors,
			...(adjudication ? { adjudication } : {}),
		},
	});
}
function explicitAcuteRestrictions(
	request: MasterPlanGraphRequest,
	snapshot: ContextSnapshot,
): string[] {
	const explicit =
		/(?:acute|急性|stop running|no running|禁止跑|停跑|non-weight-bearing|不可负重|medical restriction|医生限制)/i;
	return [
		...request.injury_declarations
			.filter(
				(injury) =>
					injury.kind === "current" &&
					isPositiveRestriction(
						`${injury.status} ${injury.training_impact}`,
						explicit,
					),
			)
			.map(
				(injury) =>
					`Current ${injury.body_area} restriction: ${injury.status}; ${injury.training_impact}`,
			),
		...snapshot.injuries
			.filter((injury) => isPositiveRestriction(injury.status, explicit))
			.map(
				(injury) =>
					`Canonical ${injury.body_area} restriction: ${injury.status}`,
			),
	];
}
function isPositiveRestriction(text: string, restriction: RegExp): boolean {
	return text
		.split(/[,;，；]|\bbut\b|\bhowever\b|\band\b|但是|并且|而且|且|但/i)
		.some(
			(clause) =>
				restriction.test(clause) &&
				!/(?:no|without|none|not|无|没有|否认)[^,;，；]{0,30}(?:acute|injury|pain|running restriction|restriction|伤|痛|限制)/i.test(
					clause,
				),
		);
}
export function validateSkeletonAgainstStrategy(
	plan: z.infer<typeof MasterPlanSchema>,
	selected: SelectedStrategy,
	athlete: AthleteAssessment,
): void {
	if (
		selected.candidate.phases.reduce((sum, phase) => sum + phase.weeks, 0) !==
		selected.candidate.race_week_index
	)
		throw new Error("selected phase structure must cover the race runway");
	validatePhaseTimeline(plan);
	const preRacePhases = plan.phases.filter(
		(phase) =>
			phase.start_date <= plan.goal.race_date && phase.name !== "赛后恢复期",
	);
	if (
		preRacePhases.length !== selected.candidate.phases.length ||
		preRacePhases.some(
			(phase, index) =>
				inclusiveWeeks(phase.start_date, phase.end_date) !==
				selected.candidate.phases[index]!.weeks,
		)
	)
		throw new Error("skeleton phase boundaries must match selected strategy");
	for (const [index, week] of plan.weeks.entries()) {
		const expected = addDays(plan.weeks[0]!.week_start, index * 7);
		if (
			week.week_start !== expected ||
			new Date(`${week.week_start}T00:00:00Z`).getUTCDay() !== 1
		)
			throw new Error("skeleton weeks must be consecutive Mondays");
		const phase = plan.phases.find((item) => item.name === week.phase_name);
		if (
			!phase ||
			week.week_start < phase.start_date ||
			week.week_start > phase.end_date
		)
			throw new Error("skeleton week must align to its phase");
		if (
			week.target_weekly_km_low > week.target_weekly_km_high ||
			week.target_weekly_km_low < phase.weekly_distance_km_low ||
			week.target_weekly_km_high > phase.weekly_distance_km_high
		)
			throw new Error("skeleton weekly volume must fit phase range");
		const isException =
			week.is_recovery_week ||
			week.phase_name === "赛前减量期" ||
			week.phase_name === "赛后恢复期" ||
			week.key_sessions.some((session) => session.type === "race");
		if (
			!isException &&
			week.target_weekly_km_high >
				athlete.safe_training_ranges.weekly_distance_km.high
		)
			throw new Error("skeleton weekly volume exceeds athlete safe range");
		if (
			index < selected.candidate.race_week_index &&
			week.target_weekly_km_high !== selected.candidate.weekly_highs_km[index]
		)
			throw new Error("skeleton weekly highs must match selected strategy");
		const hard = week.key_sessions.filter(
			(session) =>
				[
					"threshold",
					"tempo",
					"interval",
					"vo2max",
					"hill",
					"race_pace",
					"time_trial",
					"tune_up_race",
					"race",
				].includes(session.type) ||
				(session.type === "long_run" &&
					hasEmbeddedRacePace(
						`${session.intensity ?? ""} ${session.purpose ?? ""}`,
					)),
		).length;
		if (
			hard > selected.candidate.max_quality_sessions_per_week &&
			!week.key_sessions.some((session) => session.type === "race")
		)
			throw new Error("skeleton quality density exceeds selected strategy");
		for (const session of week.key_sessions)
			if (
				session.type === "long_run" &&
				(session.distance_km ?? 0) > selected.candidate.max_long_run_km
			)
				throw new Error("skeleton long run exceeds selected strategy");
	}
	const raceWeek = plan.weeks[selected.candidate.race_week_index - 1];
	if (!raceWeek?.key_sessions.some((session) => session.type === "race"))
		throw new Error("skeleton race must match selected race week");
	const taperWeeks = plan.weeks.slice(
		Math.max(0, selected.candidate.race_week_index - 2),
		selected.candidate.race_week_index,
	);
	if (
		plan.goal.distance === "FM" &&
		selected.candidate.race_week_index >= 3 &&
		(taperWeeks.length !== 2 ||
			taperWeeks.some((week) => week.phase_name !== "赛前减量期"))
	)
		throw new Error("FM skeleton must preserve the selected two-week taper");
	const milestoneCount = plan.phases
		.flatMap((phase) => phase.milestones)
		.filter((milestone) => milestone.date <= plan.goal.race_date).length;
	if (milestoneCount < selected.candidate.milestones.length)
		throw new Error("skeleton must retain selected strategy milestones");
	if (
		plan.phases.some(
			(phase) =>
				!phase.strength.focus ||
				!phase.strength.timing ||
				!phase.recovery.focus ||
				!phase.recovery.adjustment_trigger,
		)
	)
		throw new Error("skeleton must retain strength and recovery direction");
	if (
		!plan.training_principles.some((item) =>
			/(?:nutrition|fuel|carb|electrolyte|营养|补给|碳水|电解质)/i.test(item),
		)
	)
		throw new Error("skeleton must retain nutrition direction");
}
function hasEmbeddedRacePace(text: string): boolean {
	const marker = /(?:\bMP\b|\bHMP\b|\bRP\b|目标配速|马拉松配速|半马配速)/i;
	return (
		marker.test(text) &&
		!/(?:不|无|不含|没有|no|without)[^。；,;]{0,20}(?:MP|HMP|RP|目标配速|马拉松配速|半马配速)/i.test(
			text,
		)
	);
}
function validatePhaseTimeline(plan: z.infer<typeof MasterPlanSchema>): void {
	if (
		plan.phases[0]!.start_date !== plan.start_date ||
		plan.phases.at(-1)!.end_date !== plan.end_date
	)
		throw new Error("phases must cover the plan window");
	for (let index = 1; index < plan.phases.length; index += 1)
		if (
			plan.phases[index]!.start_date !==
			addDays(plan.phases[index - 1]!.end_date, 1)
		)
			throw new Error("phases must be continuous without gaps or overlap");
}
function inclusiveWeeks(start: string, end: string): number {
	return Math.ceil(
		((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
			86_400_000 +
			1) /
			7,
	);
}
function addDays(day: string, amount: number): string {
	const date = new Date(`${day}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + amount);
	return date.toISOString().slice(0, 10);
}
