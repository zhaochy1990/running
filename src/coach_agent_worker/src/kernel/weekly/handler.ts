import { randomUUID } from "node:crypto";
import { addDays, mondayOnOrBefore, shanghaiDay, WeeklyPlanGeneratorRequest } from "@stride/contract";
import { ERROR_CODES, type Handler, newPermanentError } from "../../job/errors.js";
import type { PlanJob } from "../../job/model.js";
import { weeklyPlanToDraftContent } from "./contentTransform.js";
import { runWeeklyKernel, type WeeklyPlanGraphShim } from "./kernel.js";

export interface WeeklyPlanHandlerDeps {
  graph: WeeklyPlanGraphShim;
  /** Insert the plan draft through the Go internal endpoint; returns the draft id. */
  insertDraft(userId: string, weekName: string, draftId: string, content: unknown): Promise<string>;
}

/**
 * `generate_weekly_plan` job handler: re-validates the enqueued kernel request,
 * runs the weekly kernel (streaming progress), guards that the target week is
 * the current or next Asia/Shanghai week, then lands a plan draft through the
 * Go internal insert endpoint (Go stays the single plan-table writer).
 */
export function createWeeklyPlanJobHandler(deps: WeeklyPlanHandlerDeps): Handler {
  return async (job: PlanJob, hb) => {
    let request: WeeklyPlanGeneratorRequest;
    try {
      request = WeeklyPlanGeneratorRequest.parse(JSON.parse(job.inputJson));
    } catch (error) {
      throw newPermanentError(ERROR_CODES.CONTRACT_VIOLATION, error);
    }
    const { weeklyPlan, phase, generationAttempts } = await runWeeklyKernel(
      deps.graph,
      request,
      { userId: job.userId, generationId: `plan-job-${job.jobId}` },
      hb,
    );
    assertSupportedWeek(weeklyPlan.week_name);
    const content = weeklyPlanToDraftContent(weeklyPlan);
    const draftId = await deps.insertDraft(job.userId, weeklyPlan.week_name, randomUUID(), content);
    return {
      result: JSON.stringify({
        draft_id: draftId,
        week_name: weeklyPlan.week_name,
        phase,
        generation_attempts: generationAttempts,
        generated_by: "plan-job",
      }),
      draftId,
    };
  };
}

/**
 * The graph structurally targets the current or next Shanghai week (via
 * `planningStartDate`), but a misbehaving kernel could still emit a stale week;
 * guard so a draft never lands for a week the client did not ask for.
 */
function assertSupportedWeek(weekName: string): void {
  const weekStart = weekName.slice(0, 10);
  const today = shanghaiDay(new Date().toISOString());
  const thisMonday = mondayOnOrBefore(today);
  const nextMonday = addDays(thisMonday, 7);
  if (weekStart !== thisMonday && weekStart !== nextMonday) {
    throw newPermanentError(ERROR_CODES.WEEK_NOT_SUPPORTED, new Error(`generated week ${weekStart} is not the current or next Shanghai week`));
  }
}
