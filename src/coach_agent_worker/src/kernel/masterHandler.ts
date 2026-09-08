import { randomUUID } from "node:crypto";
import { MasterPlanGraphRequest } from "@stride/contract";
import { ERROR_CODES, type Handler, newPermanentError } from "../job/errors.js";
import type { PlanJob } from "../job/model.js";
import { masterPlanToDraftContent } from "./contentTransform.js";
import { type MasterPlanGraphShim, runMasterKernel } from "./masterKernel.js";

export interface MasterPlanHandlerDeps {
  graph: MasterPlanGraphShim;
  /** Resolve the athlete's active race-goal id to attach the plan to. */
  resolveGoalId(userId: string): Promise<string | null>;
  /** Insert the plan draft through the Go internal endpoint; returns the draft id. */
  insertDraft(userId: string, draftId: string, content: unknown): Promise<string>;
}

/**
 * `generate_master_plan` job handler: re-validates the enqueued kernel request,
 * runs the master kernel (streaming progress), then lands a plan draft through
 * the Go internal insert endpoint (Go stays the single plan-table writer).
 */
export function createMasterPlanJobHandler(deps: MasterPlanHandlerDeps): Handler {
  return async (job: PlanJob, hb) => {
    let request: MasterPlanGraphRequest;
    try {
      request = MasterPlanGraphRequest.parse(JSON.parse(job.inputJson));
    } catch (error) {
      throw newPermanentError(ERROR_CODES.CONTRACT_VIOLATION, error);
    }
    const { plan, revision } = await runMasterKernel(deps.graph, request, { userId: job.userId, generationId: `plan-job-${job.jobId}` }, hb);
    // The draft's goal must reference a real race_goal row (Go enforces a UUID);
    // the active race goal is the athlete's A goal this season.
    const goalId = await deps.resolveGoalId(job.userId);
    if (goalId === null) {
      throw newPermanentError(ERROR_CODES.NO_ACTIVE_RACE_GOAL, new Error("user has no active race goal to attach the plan to"));
    }
    const content = masterPlanToDraftContent(plan, goalId);
    const draftId = await deps.insertDraft(job.userId, randomUUID(), content);
    return { result: JSON.stringify({ draft_id: draftId, revision, generated_by: "plan-job" }), draftId };
  };
}
