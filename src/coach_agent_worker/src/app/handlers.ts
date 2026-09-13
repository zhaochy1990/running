import type { MySqlDataProvider } from "../data/mysqlDataProvider.js";
import type { GoDraftClient } from "../goClient/draftClient.js";
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
  draftClient: GoDraftClient;
}

/**
 * Build the job-type → handler registry. Each entry pairs a compiled kernel
 * graph with its Go draft-insert path; the dispatcher looks handlers up by
 * `job.jobType` (ADR 0030 — one state machine, per-type kernels).
 */
export function createPlanJobHandlers(deps: PlanJobHandlerDeps): Map<PlanJobType, Handler> {
  return new Map<PlanJobType, Handler>([
    [
      "generate_master_plan",
      createMasterPlanJobHandler({
        graph: deps.masterGraph,
        // The draft's goal_id references the athlete's active race_goal row.
        resolveGoalId: async (userId) => (await deps.dataProvider.getRaceTarget(userId))?.goal_id ?? null,
        insertDraft: (userId, draftId, content) => deps.draftClient.insertMasterPlanDraft(userId, draftId, content),
      }),
    ],
    [
      "generate_weekly_plan",
      createWeeklyPlanJobHandler({
        graph: deps.weeklyGraph,
        insertDraft: (userId, weekName, draftId, content) => deps.draftClient.insertWeeklyPlanDraft(userId, weekName, draftId, content),
      }),
    ],
  ]);
}
