import { randomUUID } from "node:crypto";
import { masterPlanToContent } from "@stride/coach-agent";
import { type DanielsAudit, type LoadPlan, type MasterPlanAnchor, MasterPlanGraphRequest, type PhaseDivisionIntent, type WeeklyPlan } from "@stride/contract";
import type { RollingWeeklyChannel } from "../../goClient/weeklyPlanClient.js";
import { ERROR_CODES, type Handler, newPermanentError } from "../../job/errors.js";
import type { PlanJob } from "../../job/model.js";
import { type MasterPlanGraphShim, runMasterKernel } from "./kernel.js";

export interface MasterPlanHandlerDeps {
  graph: MasterPlanGraphShim;
  /** Resolve the athlete's active race-goal id to attach the plan to. */
  resolveGoalId(userId: string): Promise<string | null>;
  /**
   * 周课落库通道（#858 PR-A）：首批 weeklyDocs 经 Go batch-apply 物化。
   * master_plan 行要等 admin apply 才存在，故 handler 先生成**前瞻计划 id**
   * 归链 weekly 行并写进 content/result——rolling job 从 content 读回同一 id，
   * list/batch-apply 全程用它；admin apply 时 Go 侧 ApplyStructuredMasterPlan
   * 会**收养** content 的前瞻 id（合法 UUID 且库内无撞号），收养后
   * master_plan.plan_id == weekly_plan.master_plan_id == content.master_plan_id
   * 三方对齐；收养失败的窄化场景（撞号回退）仅影响按行 plan_id 的窄化视图，
   * rolling 链路仍以 content id 自洽。
   */
  weeklyPlans: RollingWeeklyChannel;
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
 * content in the job's result_json (#585 — no draft insert; the admin reviews
 * the artifact and applies it through the existing admin endpoint). #858 PR-A:
 * the first-batch weekly docs are materialized through the Go rolling channel
 * right after generation and summarized as `weekly_weeks` in the result.
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
    content.policy = kernelResult.policy;
    content.skeleton = kernelResult.skeleton;
    content.anchor = kernelResult.anchor;
    content.audit = kernelResult.audit;
    content.warnings = kernelResult.warnings;
    // #858 首批物化：weeklyDocs（首批门控后的周，全是未来周，无追赶冻结）经 Go
    // 批量落库，同 master_plan_id 重投=期望替换 revision+1（at-least-once 安全）。
    let weeklyWeeks: Array<{ week_start: string; revision: number; replaced: boolean }> = [];
    if (kernelResult.weeklyDocs.length > 0) {
      const applied = await deps.weeklyPlans.batchApplyWeeklyPlans(job.userId, masterPlanId, kernelResult.weeklyDocs);
      weeklyWeeks = applied.map((row) => ({ week_start: row.week_start, revision: row.revision, replaced: row.replaced }));
    }
    return {
      result: JSON.stringify({
        content,
        revision: kernelResult.revision,
        master_plan_id: masterPlanId,
        weekly_weeks: weeklyWeeks,
        generated_by: "plan-job",
      }),
    };
  };
}
