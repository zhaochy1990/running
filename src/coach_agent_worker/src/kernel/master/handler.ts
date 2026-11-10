import { masterPlanToContent } from "@stride/coach-agent";
import { type DanielsAudit, type LoadPlan, type MasterPlanAnchor, MasterPlanGraphRequest, type PhaseDivisionIntent } from "@stride/contract";
import { ERROR_CODES, type Handler, newPermanentError } from "../../job/errors.js";
import type { PlanJob } from "../../job/model.js";
import { type MasterPlanGraphShim, runMasterKernel } from "./kernel.js";

export interface MasterPlanHandlerDeps {
  graph: MasterPlanGraphShim;
  /** Resolve the athlete's active race-goal id to attach the plan to. */
  resolveGoalId(userId: string): Promise<string | null>;
}

/** kernel runner 的完整产物（#859：不再只取 plan，政策数据一起落库）。 */
export interface MasterPlanKernelResult {
  plan: import("@stride/contract").MasterPlan;
  revision: number;
  warnings: string[];
  policy: PhaseDivisionIntent;
  skeleton: LoadPlan;
  anchor: MasterPlanAnchor;
  audit: DanielsAudit;
}

/**
 * `generate_master_plan` job handler: re-validates the enqueued kernel request,
 * runs the master kernel (streaming progress), then reports the full v2 plan
 * content in the job's result_json (#585 — no draft insert; the admin reviews
 * the artifact and applies it through the existing admin endpoint).
 */
export function createMasterPlanJobHandler(deps: MasterPlanHandlerDeps): Handler {
  return async (job: PlanJob, hb) => {
    let request: MasterPlanGraphRequest;
    try {
      request = MasterPlanGraphRequest.parse(JSON.parse(job.inputJson));
    } catch (error) {
      throw newPermanentError(ERROR_CODES.CONTRACT_VIOLATION, error);
    }
    const kernelResult = await runMasterKernel(deps.graph, request, { userId: job.userId, generationId: `plan-job-${job.jobId}` }, hb);
    // The plan's goal must reference a real race_goal row (Go enforces a UUID);
    // the active race goal is the athlete's A goal this season.
    const goalId = await deps.resolveGoalId(job.userId);
    if (goalId === null) {
      throw newPermanentError(ERROR_CODES.NO_ACTIVE_RACE_GOAL, new Error("user has no active race goal to attach the plan to"));
    }
    // #859（2026-11-10 用户拍板 breaking change）：policy/skeleton/anchor/audit
    // 直接放进 content——不加版本号、不维护兼容层（没有真实用户在用 v1/v2）
    const content = masterPlanToContent(kernelResult.plan, goalId);
    content.policy = kernelResult.policy;
    content.skeleton = kernelResult.skeleton;
    content.anchor = kernelResult.anchor;
    content.audit = kernelResult.audit;
    content.warnings = kernelResult.warnings;
    return { result: JSON.stringify({ content, revision: kernelResult.revision, generated_by: "plan-job" }) };
  };
}
