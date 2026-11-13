import type { MasterPlanContextProvider, MasterPlanLlmModels } from "@stride/coach-agent";
import type { MySqlDataProvider } from "../data/mysqlDataProvider.js";
import type { RollingWeeklyChannel } from "../goClient/weeklyPlanClient.js";
import type { Handler } from "../job/errors.js";
import type { PlanJobType } from "../job/model.js";
import { createAdjustJobHandler } from "../kernel/adjust/handler.js";
import { createMaintenanceJobHandler } from "../kernel/maintenance/handler.js";
import { createMasterPlanJobHandler } from "../kernel/master/handler.js";
import type { MasterPlanGraphShim } from "../kernel/master/kernel.js";
import { createRollingJobHandler } from "../kernel/rolling/handler.js";

export interface PlanJobHandlerDeps {
  masterGraph: MasterPlanGraphShim;
  dataProvider: MySqlDataProvider;
  /** 滚动 job 装配（与 master 图同款 provider + LLM models 的 Pick）。 */
  rolling: {
    contextProvider: MasterPlanContextProvider;
    models: Pick<MasterPlanLlmModels, "phasingModel" | "contentModel">;
  };
  /** 滚动周课落库通道，Go internal 端点。 */
  weeklyPlans: RollingWeeklyChannel;
}

/**
 * Build the job-type → handler registry. Each entry pairs a compiled kernel
 * graph with its artifact path; the dispatcher looks handlers up by
 * `job.jobType`. #585: handlers only report artifacts through the job's
 * result_json — the plan tables are written exclusively by the apply endpoints.
 * #858 PR-A 例外：weekly 课表行经 Go internal 滚动通道 batch-apply 物化（Go 仍是
 * 唯一写者，weekly_plan/workout 表不开放给 TS 直写）。
 */
export function createPlanJobHandlers(deps: PlanJobHandlerDeps): Map<PlanJobType, Handler> {
  return new Map<PlanJobType, Handler>([
    [
      "generate_master_plan",
      createMasterPlanJobHandler({
        graph: deps.masterGraph,
        // The plan's goal_id references the athlete's active race_goal row.
        resolveGoalId: async (userId) => (await deps.dataProvider.getRaceTarget(userId))?.goal_id ?? null,
      }),
    ],
    [
      "generate_rolling_block",
      createRollingJobHandler({
        contextProvider: deps.rolling.contextProvider,
        models: deps.rolling.models,
        masterPlans: deps.dataProvider,
        weeklyPlans: deps.weeklyPlans,
      }),
    ],
    [
      "generate_adjustment",
      createAdjustJobHandler({
        contextProvider: deps.rolling.contextProvider,
        models: deps.rolling.models,
        masterPlans: deps.dataProvider,
        weeklyPlans: deps.weeklyPlans,
        weeklyDocs: deps.dataProvider,
      }),
    ],
    [
      // #858 PR-D 伤病维持课：零 LLM（确定性构造），仅需活动取数面（重估锚）。
      "generate_maintenance",
      createMaintenanceJobHandler({
        contextProvider: deps.rolling.contextProvider,
        masterPlans: deps.dataProvider,
        weeklyPlans: deps.weeklyPlans,
        weeklyDocs: deps.dataProvider,
      }),
    ],
  ]);
}
