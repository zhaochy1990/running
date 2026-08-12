import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildResponsesModel } from "../agents/common.js";
import {
	getAgentConfig,
	loadConfig,
	readStrideMySqlConfig,
} from "../config/config.js";
import { validateSkeletonAgainstStrategy } from "../graph/master_plan/graph.js";
import {
	type AssessmentFacts,
	type AthleteAssessment,
	AthleteAssessmentSchema,
	authoritativeContinuity,
	authoritativeGoalLevel,
	authoritativeReadiness,
	type ContextSnapshot,
	canonicalizeAssessmentSummary,
	createMasterPlanGraph,
	type GoalAssessment,
	GoalAssessmentSchema,
	MasterPlanGraphRequest,
	MasterPlanSchema,
	ModelContractError,
	ReviewReportSchema,
	StrategyCandidateSchema,
	StrategyJudgmentSchema,
	validateAssessmentReferences,
	validateAthleteAssessmentRanges,
	validateGoalAssessmentTargets,
} from "../graph/master_plan/index.js";
import { runMasterPlanRuleFilter } from "../graph/master_plan/rules.js";
import {
	MySqlMasterPlanContextProvider,
	StrideDataStore,
} from "../persistence/index.js";
import { getLogger } from "../utils/logger.js";

type Profile = "local" | "prod";
const PROFILE = "local" as Profile;
const USER_ID = "11c2e582-5a85-4633-81d2-df7e37ad7b48";
const AS_OF = new Date("2026-08-07").toISOString();

export const config = loadConfig();
const modelConfig = getAgentConfig(config, "master_plan");
const reviewerConfig = getAgentConfig(config, "reviewer");
const store = StrideDataStore.create(readStrideMySqlConfig(config));
const logger = getLogger("test_master_plan");

const doctrine = await readFile(
	resolve(
		dirname(fileURLToPath(import.meta.url)),
		"../graph/master_plan/doctrine/planning.md",
	),
	"utf8",
);
const reviewRubricEntries = await Promise.all(
	["periodization", "load_progression", "constraint_grounding"].map(
		async (name) =>
			[
				name,
				await readFile(
					resolve(
						dirname(fileURLToPath(import.meta.url)),
						`../graph/master_plan/doctrine/review/${name}.md`,
					),
					"utf8",
				),
			] as const,
	),
);
const reviewRubrics = Object.fromEntries(reviewRubricEntries) as Record<
	string,
	string
>;

const provider = new MySqlMasterPlanContextProvider(store);

let capturedSnapshot: ContextSnapshot | undefined;
let capturedFacts: AssessmentFacts | undefined;
let capturedAthleteAssessment: AthleteAssessment | undefined;
let capturedGoalAssessment: GoalAssessment | undefined;
const capturedStrategies: unknown[] = [];
const capturedJudgments: unknown[] = [];
let capturedSelectedStrategy: unknown;
let capturedPlanBeforeValidation: unknown;

const request = MasterPlanGraphRequest.parse({
	request_id: `snapshot-${Date.now()}`,
	requested_mode: "new_season",
	requested_modifiers: [],
	goals: [
		{
			race_name: "西安马拉松",
			location: "西安",
			distance: "FM",
			race_date: "2026-10-18",
			target_time: "2:50:00",
			finish_only: false,
			priority: "A",
		},
	],
	availability: {
		weekly_run_days_max: 6,
		available_training_windows: [],
		unavailable_days: [],
		max_session_duration_min: 180,
		allows_double_sessions: true,
		preferred_long_run_day: "saturday",
		strength_sessions_per_week: 2,
		strength_available_days: ["monday", "thursday"],
	},
	injury_declarations: [],
	environment_constraints: [],
	travel_constraints: [],
	preferences: [],
	prohibited_arrangements: [],
	active_plan_action: "none",
	user_confirmations: {
		intake_complete: true,
		goals_confirmed: true,
		availability_confirmed: true,
		injury_history_confirmed: true,
		constraints_confirmed: true,
	},
	requested_as_of: AS_OF,
});

async function main() {
	try {
		const graph = createMasterPlanGraph({
			contextProvider: provider,
			assessmentModel: {
				async invoke(input) {
					capturedFacts = input.facts;
					try {
						capturedAthleteAssessment = await invokeStructured(
							modelConfig,
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
								if (canonical.readiness !== authoritativeReadiness(input.facts))
									throw new Error("readiness conflict");
								if (
									canonical.continuity !== authoritativeContinuity(input.facts)
								)
									throw new Error("continuity conflict");
								return canonical;
							},
						);
					} catch (error) {
						console.error("athlete assessment call failed");
						if (
							error instanceof Error &&
							(error.name === "ZodError" ||
								/structured|schema|parse/i.test(error.message))
						)
							throw new ModelContractError(error.message);
						throw error;
					}
					return capturedAthleteAssessment;
				},
			},
			goalAssessmentModel: {
				async invoke(input) {
					capturedFacts = input.facts;
					try {
						capturedGoalAssessment = await invokeStructured(
							modelConfig,
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
										authoritativeGoalLevel(
											input.facts,
											input.athleteAssessment,
										) ||
									(canonical.level !== "multi_cycle_required" &&
										canonical.multi_cycle_path.length)
								)
									throw new Error("goal classification conflict");
								return canonical;
							},
						);
					} catch (error) {
						if (
							error instanceof Error &&
							(error.name === "ZodError" ||
								/structured|schema|parse/i.test(error.message))
						)
							throw new ModelContractError(error.message);
						throw error;
					}
					return capturedGoalAssessment;
				},
			},
			strategyModel: {
				async invoke(input) {
					const value = await invokeStructured(
						modelConfig,
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
					capturedStrategies.push(value);
					return value;
				},
			},
			judgmentModel: {
				async invoke(input) {
					const value = await invokeStructured(
						reviewerConfig,
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
					capturedJudgments.push(value);
					return value;
				},
			},
			skeletonModel: {
				async invoke(input) {
					capturedSelectedStrategy = input.selectedStrategy;
					capturedPlanBeforeValidation = await invokeStructured(
						modelConfig,
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
							if (report.has_errors)
								throw new Error(
									`deterministic rule errors: ${report.violations
										.filter((item) => item.severity === "error")
										.map((item) => `${item.rule_id}:${item.message}`)
										.join("; ")}`,
								);
							validateSkeletonAgainstStrategy(
								plan,
								input.selectedStrategy,
								input.athleteAssessment,
							);
							return plan;
						},
					);
					return capturedPlanBeforeValidation;
				},
			},
			reviewModel: {
				async invoke(input) {
					const rubric = reviewRubrics[input.reviewerType]!;
					return invokeStructured(
						reviewerConfig,
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
		});
		const generationId = `master-plan-${PROFILE}-${Date.now()}`;
		const result = await graph.invoke(
			{ request },
			{ context: { userId: USER_ID, generationId } },
		);
		console.log(result.outcome.decision);
		//   if (result.outcome?.decision === "infrastructure_failure") {
		//     throw new Error(`planning snapshot failed: ${result.outcome.code}`);
		//   }
		//   if (!capturedSnapshot) throw new Error("snapshot was not loaded");
		//   const outputDir = resolve(process.cwd(), "../../.omc/eval/master-plan", generationId);
		//   await mkdir(outputDir, { recursive: true });
		//   await writeFile(resolve(outputDir, "snapshot-manifest.json"), `${JSON.stringify(redactedManifest(capturedSnapshot), null, 2)}\n`, "utf8");
		//   if (capturedFacts) await writeFile(resolve(outputDir, "assessment-facts.json"), `${JSON.stringify(capturedFacts, null, 2)}\n`, "utf8");
		//   if (capturedAthleteAssessment) await writeFile(resolve(outputDir, "athlete-assessment.json"), `${JSON.stringify(capturedAthleteAssessment, null, 2)}\n`, "utf8");
		//   if (capturedGoalAssessment) await writeFile(resolve(outputDir, "goal-assessment.json"), `${JSON.stringify(capturedGoalAssessment, null, 2)}\n`, "utf8");
		//   if (result.outcome?.decision === "completed") {
		//     await writeFile(resolve(outputDir, "strategy-candidates.json"), `${JSON.stringify(result.outcome.artifact.strategy_candidates, null, 2)}\n`, "utf8");
		//     await writeFile(resolve(outputDir, "strategy-judgments.json"), `${JSON.stringify(result.outcome.artifact.judgments, null, 2)}\n`, "utf8");
		//     await writeFile(resolve(outputDir, "selected-strategy.json"), `${JSON.stringify(result.outcome.artifact.selected_strategy, null, 2)}\n`, "utf8");
		//     await writeFile(resolve(outputDir, "final-draft.json"), `${JSON.stringify(result.outcome.artifact.plan, null, 2)}\n`, "utf8");
		//     await writeFile(resolve(outputDir, "simulation-report.json"), `${JSON.stringify(result.outcome.artifact.simulation_report, null, 2)}\n`, "utf8");
		//     await writeFile(resolve(outputDir, "rule-report.json"), `${JSON.stringify(result.outcome.artifact.rule_report, null, 2)}\n`, "utf8");
		//     await writeFile(resolve(outputDir, "review-reports.json"), `${JSON.stringify(result.outcome.artifact.review_reports, null, 2)}\n`, "utf8");
		//     await writeFile(resolve(outputDir, "review-adjudication.json"), `${JSON.stringify(result.outcome.artifact.adjudication, null, 2)}\n`, "utf8");
		//   }
		//   await writeFile(resolve(outputDir, "outcome.json"), `${JSON.stringify(result.outcome, null, 2)}\n`, "utf8");
		//   await writeFile(resolve(outputDir, "captured-strategies.json"), `${JSON.stringify(capturedStrategies, null, 2)}\n`, "utf8");
		//   await writeFile(resolve(outputDir, "captured-judgments.json"), `${JSON.stringify(capturedJudgments, null, 2)}\n`, "utf8");
		//   if (capturedSelectedStrategy) await writeFile(resolve(outputDir, "captured-selected-strategy.json"), `${JSON.stringify(capturedSelectedStrategy, null, 2)}\n`, "utf8");
		//   if (capturedPlanBeforeValidation) await writeFile(resolve(outputDir, "captured-plan-before-strategy-validation.json"), `${JSON.stringify(capturedPlanBeforeValidation, null, 2)}\n`, "utf8");
		//   if (result.outcome?.decision === "failed_quality_gate") {
		//     if (result.outcome.artifact.simulation_report) await writeFile(resolve(outputDir, "simulation-report.json"), `${JSON.stringify(result.outcome.artifact.simulation_report, null, 2)}\n`, "utf8");
		//     if (result.outcome.artifact.rule_report) await writeFile(resolve(outputDir, "rule-report.json"), `${JSON.stringify(result.outcome.artifact.rule_report, null, 2)}\n`, "utf8");
		//     if (result.outcome.artifact.review_reports) await writeFile(resolve(outputDir, "review-reports.json"), `${JSON.stringify(result.outcome.artifact.review_reports, null, 2)}\n`, "utf8");
		//     if (result.outcome.artifact.adjudication) await writeFile(resolve(outputDir, "review-adjudication.json"), `${JSON.stringify(result.outcome.artifact.adjudication, null, 2)}\n`, "utf8");
		//     if (result.outcome.artifact.review_worker_errors) await writeFile(resolve(outputDir, "review-worker-errors.json"), `${JSON.stringify(result.outcome.artifact.review_worker_errors, null, 2)}\n`, "utf8");
		//   }
		//   if (result.outcome?.decision !== "completed") throw new Error(`master-plan planning ended with ${result.outcome?.decision ?? "missing_outcome"}`);
		// console.log(`Master-plan evaluation artifacts: ${outputDir}; model=${modelConfig.model}`);
	} finally {
		await store.close();
	}
}

function redactedManifest(snapshot: ContextSnapshot) {
	return {
		as_of: snapshot.as_of,
		user: { id: "[redacted]" },
		coverage: snapshot.coverage,
		aggregate_counts: {
			months: snapshot.macro_history.months.length,
			recent_weeks: snapshot.recent_history.weeks.length,
			races: snapshot.race_history.length,
			personal_bests: snapshot.personal_bests.length,
			injuries: snapshot.injuries.length,
		},
		body_composition_fields_available: {
			weight_kg: snapshot.body_composition.weight_kg !== null,
			body_fat_pct: snapshot.body_composition.body_fat_pct !== null,
			skeletal_muscle_kg: snapshot.body_composition.skeletal_muscle_kg !== null,
		},
	};
}

async function invokeStructured<Output>(
	model: Parameters<typeof buildResponsesModel>[0],
	schema: { parse(value: unknown): Output },
	name: string,
	messages: Array<["system" | "user", string]>,
	validate: (value: Output) => Output = (value) => value,
): Promise<Output> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		try {
			const structured = buildResponsesModel(model).withStructuredOutput(
				schema as never,
				{ name, method: "functionCalling", strict: true },
			);
			const detail =
				lastError instanceof Error
					? lastError.message
					: "unknown contract violation";
			const retryMessage: ["user", string][] =
				attempt === 1
					? []
					: [
							[
								"user",
								`The previous submission violated the required schema or deterministic contract: ${detail}. Submit a corrected value only; do not relax or reinterpret any fact.`,
							],
						];
			return validate(
				schema.parse(await structured.invoke([...messages, ...retryMessage])),
			);
		} catch (error) {
			lastError = error;
			if (
				!(error instanceof Error) ||
				!/Zod|schema|contract|conflict|fact|target|range|structured|parse/i.test(
					`${error.name} ${error.message}`,
				)
			)
				throw error;
		}
	}
	console.error(`${name} contract failed after retries`);
	throw new ModelContractError(
		"structured output contract failed after retries",
	);
}

await main().catch((error) => {
	console.error(error);
	process.exit(1);
});
