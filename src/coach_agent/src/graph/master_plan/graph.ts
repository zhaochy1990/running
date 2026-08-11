import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod/v4";
import {
  MasterPlanGraphContext,
  MasterPlanGraphOutcome,
  MasterPlanGraphRequest,
} from "./contracts.js";
import { MasterPlanSchema } from "./schemas.js";
import type { ContextSnapshot, MasterPlanContextProvider } from "./context.js";
import { AthleteAssessmentSchema, GoalAssessmentSchema, authoritativeGoalLevel, authoritativeReadiness, canonicalizeAssessmentSummary, deriveAssessmentFacts, validateAssessmentReferences, validateAthleteAssessmentRanges, validateGoalAssessmentTargets, type AssessmentFacts, type AthleteAssessment, type GoalAssessment } from "./assessment.js";

interface SkeletonModel {
  invoke(input: {
    request: MasterPlanGraphRequest;
    context: MasterPlanGraphContext;
    snapshot: ContextSnapshot;
    facts: AssessmentFacts;
    athleteAssessment: AthleteAssessment;
    goalAssessment: GoalAssessment;
  }): Promise<unknown>;
}

interface AssessmentModel<Output> { invoke(input: { request: MasterPlanGraphRequest; snapshot: ContextSnapshot; facts: AssessmentFacts }): Promise<unknown>; }

interface MasterPlanGraphDependencies {
  contextProvider: MasterPlanContextProvider;
  assessmentModel: AssessmentModel<AthleteAssessment>;
  goalAssessmentModel: AssessmentModel<GoalAssessment>;
  skeletonModel: SkeletonModel;
}

export class ModelContractError extends Error {}

const GraphInput = new StateSchema({
  request: MasterPlanGraphRequest,
});

const GraphOutput = new StateSchema({
  outcome: MasterPlanGraphOutcome,
});

const GraphState = new StateSchema({
  request: MasterPlanGraphRequest,
  outcome: MasterPlanGraphOutcome.optional(),
});

/** Build the compiled Master Plan Planning Kernel. */
export function createMasterPlanGraph(dependencies: MasterPlanGraphDependencies) {
  const runPlanning = async (
    state: typeof GraphState.State,
    runtime: { context?: MasterPlanGraphContext },
  ) => {
    const request = MasterPlanGraphRequest.parse(state.request);
    const context = MasterPlanGraphContext.parse(runtime.context);

    if (request.requested_mode !== "new_season") {
      return {
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
      snapshot = await dependencies.contextProvider.loadSnapshot(context.userId, request.requested_as_of);
    } catch {
      return { outcome: MasterPlanGraphOutcome.parse({ decision: "infrastructure_failure", request_id: request.request_id, generation_id: context.generationId, code: "context_snapshot_unavailable", retryable: true }) };
    }
    const safetyReasons = explicitAcuteRestrictions(request, snapshot);
    if (safetyReasons.length > 0) return { outcome: MasterPlanGraphOutcome.parse({ decision: "blocked_for_safety", request_id: request.request_id, generation_id: context.generationId, reasons: safetyReasons, prerequisites: ["Obtain clinical clearance or an explicit return-to-run restriction update"] }) };
    const facts = deriveAssessmentFacts(snapshot, request);
    const recentVolume = facts.facts.find((fact) => fact.fact_id === "volume.recent_weekly_km");
    const recentFrequency = facts.facts.find((fact) => fact.fact_id === "frequency.recent_run_days_per_week");
    if (typeof recentVolume?.value !== "number" || recentVolume.value <= 0 || typeof recentFrequency?.value !== "number" || recentFrequency.value <= 0) return { outcome: MasterPlanGraphOutcome.parse({ decision: "needs_baseline", request_id: request.request_id, generation_id: context.generationId, artifact: { type: "baseline_requirements", missing: ["positive recent running volume and frequency"], next_steps: ["Record at least two representative running weeks before season planning"] } }) };
    let athleteRaw: unknown;
    try {
      athleteRaw = await dependencies.assessmentModel.invoke({ request, snapshot, facts });
    } catch (error) {
      if (error instanceof ModelContractError || error instanceof z.ZodError) return qualityFailure(request, context, "athlete_assessment_contract_invalid");
      return { outcome: MasterPlanGraphOutcome.parse({ decision: "infrastructure_failure", request_id: request.request_id, generation_id: context.generationId, code: "assessment_model_unavailable", retryable: true }) };
    }
    let athleteAssessment: AthleteAssessment;
    try { athleteAssessment = canonicalizeAssessmentSummary(AthleteAssessmentSchema.parse(athleteRaw)); validateAssessmentReferences(athleteAssessment, facts); validateAthleteAssessmentRanges(athleteAssessment, facts, request); if (athleteAssessment.readiness !== authoritativeReadiness(facts)) throw new Error("athlete readiness conflicts with deterministic facts"); }
    catch { return qualityFailure(request, context, "athlete_assessment_contract_invalid"); }
    if (athleteAssessment.readiness === "missing_baseline") return { outcome: MasterPlanGraphOutcome.parse({ decision: "needs_baseline", request_id: request.request_id, generation_id: context.generationId, artifact: { type: "baseline_requirements", missing: athleteAssessment.gaps.length > 0 ? athleteAssessment.gaps.map((gap) => gap.description) : ["assessment baseline"], next_steps: ["Collect the missing baseline evidence and reassess without changing the confirmed goal"] } }) };
    let goalRaw: unknown;
    try { goalRaw = await dependencies.goalAssessmentModel.invoke({ request, snapshot, facts }); }
    catch (error) { if (error instanceof ModelContractError || error instanceof z.ZodError) return qualityFailure(request, context, "goal_assessment_contract_invalid"); return { outcome: MasterPlanGraphOutcome.parse({ decision: "infrastructure_failure", request_id: request.request_id, generation_id: context.generationId, code: "assessment_model_unavailable", retryable: true }) }; }
    let goalAssessment: GoalAssessment;
    try { goalAssessment = canonicalizeAssessmentSummary(GoalAssessmentSchema.parse(goalRaw)); validateAssessmentReferences(goalAssessment, facts); validateGoalAssessmentTargets(goalAssessment, request, facts); if (goalAssessment.level !== authoritativeGoalLevel(facts)) throw new Error("goal level conflicts with deterministic facts"); if (goalAssessment.level !== "multi_cycle_required" && goalAssessment.multi_cycle_path.length > 0) throw new Error("multi-cycle path requires authoritative multi-cycle level"); }
    catch { return qualityFailure(request, context, "goal_assessment_contract_invalid"); }
    if (goalAssessment.level === "multi_cycle_required") return { outcome: MasterPlanGraphOutcome.parse({ decision: "multi_cycle_required", request_id: request.request_id, generation_id: context.generationId, artifact: { type: "multi_cycle_path", cycles: goalAssessment.multi_cycle_path.length >= 2 ? goalAssessment.multi_cycle_path : ["Develop the required baseline", "Reassess the confirmed target"] } }) };
    if (goalAssessment.level === "unsafe_or_incompatible") return { outcome: MasterPlanGraphOutcome.parse({ decision: "goal_conflict", request_id: request.request_id, generation_id: context.generationId, artifact: { type: "goal_options", conflicts: goalAssessment.conflicts.length > 0 ? goalAssessment.conflicts.map((conflict) => conflict.description) : [goalAssessment.summary], options: ["Keep the confirmed A goal as an unplanned aspiration", "Explicitly confirm a compatible planning target"] } }) };
    let planRaw: unknown;
    try { planRaw = await dependencies.skeletonModel.invoke({ request, context, snapshot, facts, athleteAssessment, goalAssessment }); }
    catch { return { outcome: MasterPlanGraphOutcome.parse({ decision: "infrastructure_failure", request_id: request.request_id, generation_id: context.generationId, code: "skeleton_model_unavailable", retryable: true }) }; }
    let plan: z.infer<typeof MasterPlanSchema>;
    try { plan = MasterPlanSchema.parse(planRaw); }
    catch { return qualityFailure(request, context, "candidate_plan_contract_invalid"); }
    const primaryGoal = request.goals.find((goal) => goal.priority === "A") ?? request.goals[0]!;
    if (
      plan.goal.race_name !== primaryGoal.race_name
      || plan.goal.location !== primaryGoal.location
      || plan.goal.distance !== primaryGoal.distance
      || plan.goal.race_date !== primaryGoal.race_date
      || plan.goal.target_time !== (primaryGoal.target_time ?? "finish_only")
    ) {
      return qualityFailure(request, context, "candidate_plan_changed_confirmed_goal");
    }

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
        },
      }),
    };
  };

  return new StateGraph({
    state: GraphState,
    input: GraphInput,
    output: GraphOutput,
    context: MasterPlanGraphContext,
  })
    .addNode("run_planning", runPlanning)
    .addEdge(START, "run_planning")
    .addEdge("run_planning", END)
    .compile();
}

function explicitAcuteRestrictions(request: MasterPlanGraphRequest, snapshot: ContextSnapshot): string[] {
  const explicit = /(?:acute|急性|stop running|no running|禁止跑|停跑|non-weight-bearing|不可负重|medical restriction|医生限制)/i;
  const declarations = request.injury_declarations.filter((injury) => injury.kind === "current" && isPositiveRestriction(`${injury.status} ${injury.training_impact}`, explicit)).map((injury) => `Current ${injury.body_area} restriction: ${injury.status}; ${injury.training_impact}`);
  const canonical = snapshot.injuries.filter((injury) => isPositiveRestriction(injury.status, explicit)).map((injury) => `Canonical ${injury.body_area} restriction: ${injury.status}`);
  return [...declarations, ...canonical];
}

function isPositiveRestriction(text: string, restriction: RegExp): boolean { return text.split(/[,;，；]|\bbut\b|\bhowever\b|\band\b|但是|并且|而且|且|但/i).some((clause) => restriction.test(clause) && !/(?:no|without|none|not|无|没有|否认)[^,;，；]{0,30}(?:acute|injury|pain|running restriction|restriction|伤|痛|限制)/i.test(clause)); }
function qualityFailure(request: MasterPlanGraphRequest, context: MasterPlanGraphContext, issue: string) { return { outcome: MasterPlanGraphOutcome.parse({ decision: "failed_quality_gate", request_id: request.request_id, generation_id: context.generationId, artifact: { type: "quality_failure_report", unresolved_issues: [issue], attempt_history: [] } }) }; }
