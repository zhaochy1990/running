import { END, ReducedValue, Send, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod/v4";
import { AthleteAssessmentSchema, GoalAssessmentSchema, authoritativeGoalLevel, authoritativeReadiness, canonicalizeAssessmentSummary, deriveAssessmentFacts, validateAssessmentReferences, validateAthleteAssessmentRanges, validateGoalAssessmentTargets, type AssessmentFacts, type AthleteAssessment, type GoalAssessment } from "./assessment.js";
import { MasterPlanGraphContext, MasterPlanGraphOutcome, MasterPlanGraphRequest } from "./contracts.js";
import { ContextSnapshotSchema, type ContextSnapshot, type MasterPlanContextProvider } from "./context.js";
import { MasterPlanSchema, SelectedStrategySchema, StrategyArchetypeSchema, StrategyCandidateSchema, StrategyJudgmentSchema, type SelectedStrategy, type StrategyCandidate, type StrategyJudgment } from "./schemas.js";
import { aggregateStrategySelection, mergeCandidatesByStableId, mergeJudgmentsByStableKey, mergeWorkerErrors, validateCandidateDiversity, validateStrategyCandidate, validateStrategyJudgment } from "./strategy.js";

type StrategyArchetype = z.infer<typeof StrategyArchetypeSchema>;
type Judge = StrategyJudgment["judge"];

interface SkeletonModel { invoke(input: { request: MasterPlanGraphRequest; context: MasterPlanGraphContext; snapshot: ContextSnapshot; facts: AssessmentFacts; athleteAssessment: AthleteAssessment; goalAssessment: GoalAssessment; selectedStrategy: SelectedStrategy }): Promise<unknown>; }
interface AssessmentModel { invoke(input: { request: MasterPlanGraphRequest; snapshot: ContextSnapshot; facts: AssessmentFacts }): Promise<unknown>; }
interface StrategyModel { invoke(input: { archetype: StrategyArchetype; request: MasterPlanGraphRequest; snapshot: ContextSnapshot; facts: AssessmentFacts; athleteAssessment: AthleteAssessment; goalAssessment: GoalAssessment }): Promise<unknown>; }
interface JudgmentModel { invoke(input: { judge: Judge; candidate: StrategyCandidate; request: MasterPlanGraphRequest; facts: AssessmentFacts; athleteAssessment: AthleteAssessment; goalAssessment: GoalAssessment }): Promise<unknown>; }

interface MasterPlanGraphDependencies {
  contextProvider: MasterPlanContextProvider;
  assessmentModel: AssessmentModel;
  goalAssessmentModel: AssessmentModel;
  strategyModel: StrategyModel;
  judgmentModel: JudgmentModel;
  skeletonModel: SkeletonModel;
  strategyArchetypes?: readonly StrategyArchetype[];
}

export class ModelContractError extends Error {}

const GraphInput = new StateSchema({ request: MasterPlanGraphRequest });
const GraphOutput = new StateSchema({ outcome: MasterPlanGraphOutcome });
const GraphState = new StateSchema({
  request: MasterPlanGraphRequest,
  context: MasterPlanGraphContext.optional(), snapshot: ContextSnapshotSchema.optional(), facts: z.custom<AssessmentFacts>().optional(),
  athleteAssessment: AthleteAssessmentSchema.optional(), goalAssessment: GoalAssessmentSchema.optional(),
  strategyArchetype: StrategyArchetypeSchema.optional(), judge: StrategyJudgmentSchema.shape.judge.optional(), candidate: StrategyCandidateSchema.optional(),
  strategyCandidates: new ReducedValue(z.array(StrategyCandidateSchema).default(() => []), { reducer: mergeCandidatesByStableId }),
  judgments: new ReducedValue(z.array(StrategyJudgmentSchema).default(() => []), { reducer: mergeJudgmentsByStableKey }),
  workerErrors: new ReducedValue(z.array(z.string()).default(() => []), { reducer: mergeWorkerErrors }),
  selectedStrategy: SelectedStrategySchema.optional(), plan: MasterPlanSchema.optional(), outcome: MasterPlanGraphOutcome.optional(),
});

/** Build the compiled Master Plan Planning Kernel. */
export function createMasterPlanGraph(dependencies: MasterPlanGraphDependencies) {
  const archetypes = dependencies.strategyArchetypes ?? ["conservative", "balanced", "aggressive_gated"];
  const strategyModel = dependencies.strategyModel;
  const judgmentModel = dependencies.judgmentModel;
  if (archetypes.length < 2 || archetypes.length > 3 || new Set(archetypes).size !== archetypes.length) throw new Error("strategyArchetypes must contain 2-3 unique archetypes");

  const initialize = async (state: typeof GraphState.State, runtime: { context?: MasterPlanGraphContext }) => {
    const request = MasterPlanGraphRequest.parse(state.request); const context = MasterPlanGraphContext.parse(runtime.context);
    if (request.requested_mode !== "new_season") return { context, outcome: MasterPlanGraphOutcome.parse({ decision: "unsupported", request_id: request.request_id, generation_id: context.generationId, artifact: { type: "capability_gap", requested_mode: request.requested_mode, supported_modes: ["new_season"] } }) };
    let snapshot: ContextSnapshot;
    try { snapshot = await dependencies.contextProvider.loadSnapshot(context.userId, request.requested_as_of); }
    catch { return { context, outcome: infrastructureFailure(request, context, "context_snapshot_unavailable") }; }
    const safetyReasons = explicitAcuteRestrictions(request, snapshot);
    if (safetyReasons.length > 0) return { context, snapshot, outcome: MasterPlanGraphOutcome.parse({ decision: "blocked_for_safety", request_id: request.request_id, generation_id: context.generationId, reasons: safetyReasons, prerequisites: ["Obtain clinical clearance or an explicit return-to-run restriction update"] }) };
    const facts = deriveAssessmentFacts(snapshot, request);
    const volume = facts.facts.find((fact) => fact.fact_id === "volume.recent_weekly_km")?.value;
    const frequency = facts.facts.find((fact) => fact.fact_id === "frequency.recent_run_days_per_week")?.value;
    if (typeof volume !== "number" || volume <= 0 || typeof frequency !== "number" || frequency <= 0) return { context, snapshot, facts, outcome: MasterPlanGraphOutcome.parse({ decision: "needs_baseline", request_id: request.request_id, generation_id: context.generationId, artifact: { type: "baseline_requirements", missing: ["positive recent running volume and frequency"], next_steps: ["Record at least two representative running weeks before season planning"] } }) };
    return { context, snapshot, facts };
  };

  const assessAthlete = async (state: typeof GraphState.State) => {
    const { request, snapshot, facts, context } = required(state);
    try {
      const assessment = canonicalizeAssessmentSummary(AthleteAssessmentSchema.parse(await dependencies.assessmentModel.invoke({ request, snapshot, facts })));
      validateAssessmentReferences(assessment, facts); validateAthleteAssessmentRanges(assessment, facts, request);
      if (assessment.readiness !== authoritativeReadiness(facts)) throw new Error("readiness conflict");
      if (assessment.readiness === "missing_baseline") return { outcome: MasterPlanGraphOutcome.parse({ decision: "needs_baseline", request_id: request.request_id, generation_id: context.generationId, artifact: { type: "baseline_requirements", missing: assessment.gaps.length ? assessment.gaps.map((gap) => gap.description) : ["assessment baseline"], next_steps: ["Collect the missing baseline evidence and reassess without changing the confirmed goal"] } }) };
      return { athleteAssessment: assessment };
    } catch (error) { return { outcome: modelFailure(error, request, context, "athlete_assessment_contract_invalid", "assessment_model_unavailable") }; }
  };

  const assessGoal = async (state: typeof GraphState.State) => {
    const { request, snapshot, facts, context } = required(state);
    try {
      const assessment = canonicalizeAssessmentSummary(GoalAssessmentSchema.parse(await dependencies.goalAssessmentModel.invoke({ request, snapshot, facts })));
      validateAssessmentReferences(assessment, facts); validateGoalAssessmentTargets(assessment, request, facts);
      if (assessment.level !== authoritativeGoalLevel(facts) || (assessment.level !== "multi_cycle_required" && assessment.multi_cycle_path.length)) throw new Error("goal assessment conflict");
      if (assessment.level === "multi_cycle_required") return { outcome: MasterPlanGraphOutcome.parse({ decision: "multi_cycle_required", request_id: request.request_id, generation_id: context.generationId, artifact: { type: "multi_cycle_path", cycles: assessment.multi_cycle_path.length >= 2 ? assessment.multi_cycle_path : ["Develop the required baseline", "Reassess the confirmed target"] } }) };
      if (assessment.level === "unsafe_or_incompatible") return { outcome: MasterPlanGraphOutcome.parse({ decision: "goal_conflict", request_id: request.request_id, generation_id: context.generationId, artifact: { type: "goal_options", conflicts: assessment.conflicts.length ? assessment.conflicts.map((conflict) => conflict.description) : [assessment.summary], options: ["Keep the confirmed A goal as an unplanned aspiration", "Explicitly confirm a compatible planning target"] } }) };
      return { goalAssessment: assessment };
    } catch (error) { return { outcome: modelFailure(error, request, context, "goal_assessment_contract_invalid", "assessment_model_unavailable") }; }
  };

  const strategyWorker = async (state: typeof GraphState.State) => {
    const { request, snapshot, facts, athleteAssessment, goalAssessment } = requiredWithAssessments(state);
    try { const candidate = StrategyCandidateSchema.parse(await strategyModel.invoke({ archetype: state.strategyArchetype!, request, snapshot, facts, athleteAssessment, goalAssessment })); validateStrategyCandidate(candidate, facts, athleteAssessment); return { strategyCandidates: [candidate] }; }
    catch (error) { return { workerErrors: [isInfrastructureError(error) ? "infra:strategy_model_unavailable" : "quality:strategy_candidate_invalid"] }; }
  };
  const judgeWorker = async (state: typeof GraphState.State) => {
    const { request, facts, athleteAssessment, goalAssessment } = requiredWithAssessments(state);
    try { const judgment = StrategyJudgmentSchema.parse(await judgmentModel.invoke({ judge: state.judge!, candidate: state.candidate!, request, facts, athleteAssessment, goalAssessment })); validateStrategyJudgment(judgment, state.candidate!, facts); return { judgments: [judgment] }; }
    catch (error) { return { workerErrors: [isInfrastructureError(error) ? "infra:strategy_judgment_unavailable" : "quality:strategy_judgment_invalid"] }; }
  };
  const dispatchJudges = (state: typeof GraphState.State) => { if (state.workerErrors.length) return { outcome: workerFailure(state) }; try { validateCandidateDiversity(state.strategyCandidates); return {}; } catch { return { outcome: qualityFailure(state.request, state.context!, "strategy_candidates_not_distinct") }; } };
  const selectStrategy = (state: typeof GraphState.State) => { if (state.workerErrors.length) return { outcome: workerFailure(state) }; try { return { selectedStrategy: aggregateStrategySelection(state.strategyCandidates, state.judgments) }; } catch { const { request, context } = required(state); return { outcome: qualityFailure(request, context, "no_eligible_strategy") }; } };
  const expandSkeleton = async (state: typeof GraphState.State) => {
    const { request, snapshot, facts, context, athleteAssessment, goalAssessment } = requiredWithAssessments(state);
    let raw: unknown;
    try { raw = await dependencies.skeletonModel.invoke({ request, context, snapshot, facts, athleteAssessment, goalAssessment, selectedStrategy: state.selectedStrategy! }); }
    catch (error) { return { outcome: isContractError(error) ? qualityFailure(request, context, "candidate_plan_contract_invalid") : infrastructureFailure(request, context, "skeleton_model_unavailable") }; }
    let plan: z.infer<typeof MasterPlanSchema>;
    try { plan = MasterPlanSchema.parse(raw); }
    catch { return { outcome: qualityFailure(request, context, "candidate_plan_schema_invalid") }; }
    try { validateSkeletonAgainstStrategy(plan, state.selectedStrategy!, athleteAssessment); return { plan }; }
    catch (error) { return { outcome: qualityFailure(request, context, `candidate_plan_strategy_mismatch:${error instanceof Error ? error.message : "unknown"}`) }; }
  };
  const finalize = (state: typeof GraphState.State) => {
    const { request, context, facts, athleteAssessment, goalAssessment } = requiredWithAssessments(state); const plan = state.plan!;
    const goal = request.goals.find((item) => item.priority === "A") ?? request.goals[0]!;
    if (plan.goal.race_name !== goal.race_name || plan.goal.location !== goal.location || plan.goal.distance !== goal.distance || plan.goal.race_date !== goal.race_date || plan.goal.target_time !== (goal.target_time ?? "finish_only")) return { outcome: qualityFailure(request, context, "candidate_plan_changed_confirmed_goal") };
    return { outcome: MasterPlanGraphOutcome.parse({ decision: "completed", request_id: request.request_id, generation_id: context.generationId, artifact: { type: "master_plan_draft", activation_status: "inactive", plan, facts, athlete_assessment: athleteAssessment, goal_assessment: goalAssessment, strategy_candidates: state.strategyCandidates, judgments: state.judgments, selected_strategy: state.selectedStrategy } }) };
  };

  const stopOr = (next: string) => (state: typeof GraphState.State) => state.outcome ? END : next;
  const fanStrategies = (state: typeof GraphState.State) => archetypes.map((archetype) => new Send("strategy_worker", { ...sharedWorkerState(state), strategyArchetype: archetype }));
  const judges: Judge[] = ["performance_path", "safety_load", "constraint_feasibility"];
  const fanJudges = (state: typeof GraphState.State) => state.strategyCandidates.flatMap((candidate) => judges.map((judge) => new Send("judge_worker", { ...sharedWorkerState(state), candidate, judge })));

  return new StateGraph({ state: GraphState, input: GraphInput, output: GraphOutput, context: MasterPlanGraphContext })
    .addNode("initialize", initialize).addNode("assess_athlete", assessAthlete).addNode("assess_goal", assessGoal)
    .addNode("strategy_worker", strategyWorker).addNode("dispatch_judges", dispatchJudges).addNode("judge_worker", judgeWorker).addNode("select_strategy", selectStrategy)
    .addNode("expand_skeleton", expandSkeleton).addNode("finalize", finalize)
    .addEdge(START, "initialize").addConditionalEdges("initialize", stopOr("assess_athlete"), ["assess_athlete", END])
    .addConditionalEdges("assess_athlete", stopOr("assess_goal"), ["assess_goal", END])
    .addConditionalEdges("assess_goal", (state) => state.outcome ? END : fanStrategies(state), ["strategy_worker", END])
    .addEdge("strategy_worker", "dispatch_judges").addConditionalEdges("dispatch_judges", (state) => state.outcome ? END : fanJudges(state), ["judge_worker", END])
    .addEdge("judge_worker", "select_strategy").addConditionalEdges("select_strategy", stopOr("expand_skeleton"), ["expand_skeleton", END])
    .addConditionalEdges("expand_skeleton", stopOr("finalize"), ["finalize", END]).addEdge("finalize", END).compile();
}

function sharedWorkerState(state: typeof GraphState.State) { return { request: state.request, context: state.context, snapshot: state.snapshot, facts: state.facts, athleteAssessment: state.athleteAssessment, goalAssessment: state.goalAssessment }; }
function required(state: typeof GraphState.State) { return { request: state.request, context: state.context!, snapshot: state.snapshot!, facts: state.facts! }; }
function requiredWithAssessments(state: typeof GraphState.State) { return { ...required(state), athleteAssessment: state.athleteAssessment!, goalAssessment: state.goalAssessment! }; }
function isContractError(error: unknown) { return error instanceof ModelContractError || error instanceof z.ZodError; }
function modelFailure(error: unknown, request: MasterPlanGraphRequest, context: MasterPlanGraphContext, issue: string, code: string) { return isContractError(error) || !(error instanceof Error) || !/(?:timeout|ECONN|network|unavailable)/i.test(error.message) ? qualityFailure(request, context, issue) : infrastructureFailure(request, context, code); }
function isInfrastructureError(error: unknown): boolean { return error instanceof Error && /(?:timeout|ECONN|network|unavailable|rate limit|429|5\d\d)/i.test(error.message); }
function workerFailure(state: typeof GraphState.State) { const error = state.workerErrors[0]!; return error.startsWith("infra:") ? infrastructureFailure(state.request, state.context!, error.slice(6)) : qualityFailure(state.request, state.context!, error.replace(/^quality:/, "")); }
function infrastructureFailure(request: MasterPlanGraphRequest, context: MasterPlanGraphContext, code: string) { return MasterPlanGraphOutcome.parse({ decision: "infrastructure_failure", request_id: request.request_id, generation_id: context.generationId, code, retryable: true }); }
function qualityFailure(request: MasterPlanGraphRequest, context: MasterPlanGraphContext, issue: string) { return MasterPlanGraphOutcome.parse({ decision: "failed_quality_gate", request_id: request.request_id, generation_id: context.generationId, artifact: { type: "quality_failure_report", unresolved_issues: [issue], attempt_history: [] } }); }
function explicitAcuteRestrictions(request: MasterPlanGraphRequest, snapshot: ContextSnapshot): string[] { const explicit = /(?:acute|急性|stop running|no running|禁止跑|停跑|non-weight-bearing|不可负重|medical restriction|医生限制)/i; return [...request.injury_declarations.filter((injury) => injury.kind === "current" && isPositiveRestriction(`${injury.status} ${injury.training_impact}`, explicit)).map((injury) => `Current ${injury.body_area} restriction: ${injury.status}; ${injury.training_impact}`), ...snapshot.injuries.filter((injury) => isPositiveRestriction(injury.status, explicit)).map((injury) => `Canonical ${injury.body_area} restriction: ${injury.status}`)]; }
function isPositiveRestriction(text: string, restriction: RegExp): boolean { return text.split(/[,;，；]|\bbut\b|\bhowever\b|\band\b|但是|并且|而且|且|但/i).some((clause) => restriction.test(clause) && !/(?:no|without|none|not|无|没有|否认)[^,;，；]{0,30}(?:acute|injury|pain|running restriction|restriction|伤|痛|限制)/i.test(clause)); }
export function validateSkeletonAgainstStrategy(plan: z.infer<typeof MasterPlanSchema>, selected: SelectedStrategy, athlete: AthleteAssessment): void { if (selected.candidate.phases.reduce((sum, phase) => sum + phase.weeks, 0) !== selected.candidate.race_week_index) throw new Error("selected phase structure must cover the race runway"); validatePhaseTimeline(plan); const preRacePhases = plan.phases.filter((phase) => phase.start_date <= plan.goal.race_date && phase.name !== "赛后恢复期"); if (preRacePhases.length !== selected.candidate.phases.length || preRacePhases.some((phase, index) => inclusiveWeeks(phase.start_date, phase.end_date) !== selected.candidate.phases[index]!.weeks)) throw new Error("skeleton phase boundaries must match selected strategy"); for (const [index, week] of plan.weeks.entries()) { const expected = addDays(plan.weeks[0]!.week_start, index * 7); if (week.week_start !== expected || new Date(`${week.week_start}T00:00:00Z`).getUTCDay() !== 1) throw new Error("skeleton weeks must be consecutive Mondays"); const phase = plan.phases.find((item) => item.name === week.phase_name); if (!phase || week.week_start < phase.start_date || week.week_start > phase.end_date) throw new Error("skeleton week must align to its phase"); if (week.target_weekly_km_low > week.target_weekly_km_high || week.target_weekly_km_low < phase.weekly_distance_km_low || week.target_weekly_km_high > phase.weekly_distance_km_high) throw new Error("skeleton weekly volume must fit phase range"); const isException = week.is_recovery_week || week.phase_name === "赛前减量期" || week.phase_name === "赛后恢复期" || week.key_sessions.some((session) => session.type === "race"); if (!isException && week.target_weekly_km_high > athlete.safe_training_ranges.weekly_distance_km.high) throw new Error("skeleton weekly volume exceeds athlete safe range"); if (index < selected.candidate.race_week_index && week.target_weekly_km_high !== selected.candidate.weekly_highs_km[index]) throw new Error("skeleton weekly highs must match selected strategy"); const hard = week.key_sessions.filter((session) => ["threshold", "tempo", "interval", "vo2max", "hill", "race_pace", "time_trial", "tune_up_race", "race"].includes(session.type) || session.type === "long_run" && hasEmbeddedRacePace(`${session.intensity ?? ""} ${session.purpose ?? ""}`)).length; if (hard > selected.candidate.max_quality_sessions_per_week && !week.key_sessions.some((session) => session.type === "race")) throw new Error("skeleton quality density exceeds selected strategy"); for (const session of week.key_sessions) if (session.type === "long_run" && (session.distance_km ?? 0) > selected.candidate.max_long_run_km) throw new Error("skeleton long run exceeds selected strategy"); } const raceWeek = plan.weeks[selected.candidate.race_week_index - 1]; if (!raceWeek?.key_sessions.some((session) => session.type === "race")) throw new Error("skeleton race must match selected race week"); const taperWeeks = plan.weeks.slice(Math.max(0, selected.candidate.race_week_index - 2), selected.candidate.race_week_index); if (plan.goal.distance === "FM" && selected.candidate.race_week_index >= 3 && (taperWeeks.length !== 2 || taperWeeks.some((week) => week.phase_name !== "赛前减量期"))) throw new Error("FM skeleton must preserve the selected two-week taper"); const milestoneCount = plan.phases.flatMap((phase) => phase.milestones).filter((milestone) => milestone.date <= plan.goal.race_date).length; if (milestoneCount < selected.candidate.milestones.length) throw new Error("skeleton must retain selected strategy milestones"); if (plan.phases.some((phase) => !phase.strength.focus || !phase.strength.timing || !phase.recovery.focus || !phase.recovery.adjustment_trigger)) throw new Error("skeleton must retain strength and recovery direction"); if (!plan.training_principles.some((item) => /(?:nutrition|fuel|carb|electrolyte|营养|补给|碳水|电解质)/i.test(item))) throw new Error("skeleton must retain nutrition direction"); }
function hasEmbeddedRacePace(text: string): boolean { const marker = /(?:\bMP\b|\bHMP\b|\bRP\b|目标配速|马拉松配速|半马配速)/i; return marker.test(text) && !/(?:不|无|不含|没有|no|without)[^。；,;]{0,20}(?:MP|HMP|RP|目标配速|马拉松配速|半马配速)/i.test(text); }
function validatePhaseTimeline(plan: z.infer<typeof MasterPlanSchema>): void { if (plan.phases[0]!.start_date !== plan.start_date || plan.phases.at(-1)!.end_date !== plan.end_date) throw new Error("phases must cover the plan window"); for (let index = 1; index < plan.phases.length; index += 1) if (plan.phases[index]!.start_date !== addDays(plan.phases[index - 1]!.end_date, 1)) throw new Error("phases must be continuous without gaps or overlap"); }
function inclusiveWeeks(start: string, end: string): number { return Math.ceil(((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000 + 1) / 7); }
function addDays(day: string, amount: number): string { const date = new Date(`${day}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + amount); return date.toISOString().slice(0, 10); }
