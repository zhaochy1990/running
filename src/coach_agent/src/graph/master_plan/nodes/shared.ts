/**
 * Plumbing every master-plan node shares: the graph's logger, the state
 * accessors, and the constructors that turn a caught failure into a terminal
 * outcome.
 *
 * These live here rather than in `nodes.ts` so an extracted node module can
 * import them without reaching back into the aggregator. The `GraphState` import
 * below is type-only, so there is no runtime cycle.
 */
import { getLogger, ModelContractError } from "@stride/common";
import { type MasterPlanGraphContext, MasterPlanGraphOutcome, type MasterPlanGraphRequest } from "@stride/contract";
import { z } from "zod/v4";
import type { GraphState } from "../nodes.js";

export const logger = getLogger("master-plan-graph");

// get the required state values
export function required(state: typeof GraphState.State) {
  return {
    request: state.request,
    context: state.context!,
    snapshot: state.snapshot!,
    facts: state.facts!,
  };
}
export function requiredWithGoalAssessment(state: typeof GraphState.State) {
  return {
    ...required(state),
    goalAssessment: state.goalAssessment!,
  };
}

export function isContractError(error: unknown) {
  return error instanceof ModelContractError || error instanceof z.ZodError;
}

/**
 * Nodes catch their own failures and hand the graph a structured outcome — what
 * the graph wants, but it makes the cause invisible in the logs. Every catch
 * site that swallows an exception must call this first.
 */
export function logSwallowedFailure(site: string, error: unknown, extra: Record<string, unknown> = {}): void {
  logger.warn({ site, ...extra, err: error }, `${site}: failure converted into a structured outcome`);
}

export function modelFailure(error: unknown, request: MasterPlanGraphRequest, context: MasterPlanGraphContext, issue: string, code: string) {
  logSwallowedFailure("modelFailure", error, { issue });
  return isContractError(error) || !(error instanceof Error) || !/(?:timeout|ECONN|network|unavailable)/i.test(error.message)
    ? qualityFailure(request, context, issue)
    : infrastructureFailure(request, context, code);
}

export function infrastructureFailure(request: MasterPlanGraphRequest, context: MasterPlanGraphContext, code: string) {
  return MasterPlanGraphOutcome.parse({
    decision: "infrastructure_failure",
    request_id: request.request_id,
    generation_id: context.generationId,
    code,
    retryable: true,
  });
}
export function qualityFailure(request: MasterPlanGraphRequest, context: MasterPlanGraphContext, ...issues: string[]) {
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
