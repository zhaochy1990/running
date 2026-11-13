import { randomUUID } from "node:crypto";
import { masterPlanToContent } from "@stride/coach-agent";
import { type DanielsAudit, type LoadPlan, type MasterPlanAnchor, MasterPlanGraphRequest, type PhaseDivisionIntent, type WeeklyPlan } from "@stride/contract";
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
  /** 首批周课文档（#858 PR-A：L4 完整产物不再被 v2 快照收缩丢弃；可空数组）。 */
  weeklyDocs: WeeklyPlan[];
}

/**
 * `generate_master_plan` job handler: re-validates the enqueued kernel request,
 * runs the master kernel (streaming progress), then reports the full v2 plan
 * content, policy and full first-batch weekly docs in result_json. The handler
 * never writes a season, week, or workout; Go applies the candidate only
 * after explicit confirmation.
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
    const masterPlanId = randomUUID();
    const content = masterPlanToContent(kernelResult.plan, goalId, { weekly_run_days_max: request.availability.weekly_run_days_max });
    content.master_plan_id = masterPlanId;
    content.candidate_job_id = job.jobId;
    content.candidate_user_id = job.userId;
    content.policy = kernelResult.policy;
    content.skeleton = kernelResult.skeleton;
    content.anchor = kernelResult.anchor;
    content.audit = kernelResult.audit;
    content.warnings = kernelResult.warnings;
    // 首批完整文档随候选内容传递；只有明确启用时 Go 才能写入正式课表。
    content.weekly_docs = kernelResult.weeklyDocs;
    return {
      result: JSON.stringify({
        content,
        user_id: job.userId,
        revision: kernelResult.revision,
        master_plan_id: masterPlanId,
        generated_by: "plan-job",
      }),
    };
  };
}
