import type { MySqlDataProvider } from "../data/mysqlDataProvider.js";
import type { Handler } from "../job/errors.js";
import type { PlanJobType } from "../job/model.js";
import { createMasterPlanJobHandler } from "../kernel/master/handler.js";
import type { MasterPlanGraphShim } from "../kernel/master/kernel.js";
import { createWeeklyPlanJobHandler } from "../kernel/weekly/handler.js";
import type { WeeklyPlanGraphShim } from "../kernel/weekly/kernel.js";

export interface PlanJobHandlerDeps {
  masterGraph: MasterPlanGraphShim;
  weeklyGraph: WeeklyPlanGraphShim;
  dataProvider: MySqlDataProvider;
}

/**
 * Build the job-type → handler registry. Each entry pairs a compiled kernel
 * graph with its artifact path; the dispatcher looks handlers up by
 * `job.jobType`. #585: handlers only report artifacts through the job's
 * result_json — the plan tables are written exclusively by the apply endpoints.
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
      "generate_weekly_plan",
      createWeeklyPlanJobHandler({
        graph: deps.weeklyGraph,
      }),
    ],
  ]);
}
