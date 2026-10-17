import { addDays, mondayOnOrBefore, shanghaiDay, WeeklyPlanGeneratorRequest } from "@stride/contract";
import { ERROR_CODES, type Handler, newPermanentError } from "../../job/errors.js";
import type { PlanJob } from "../../job/model.js";
import { weeklyPlanToContent } from "./contentTransform.js";
import { runWeeklyKernel, type WeeklyPlanGraphShim } from "./kernel.js";

export interface WeeklyPlanHandlerDeps {
  graph: WeeklyPlanGraphShim;
}

/**
 * `generate_weekly_plan` job handler: re-validates the enqueued kernel request,
 * runs the weekly kernel (streaming progress), guards that the target week is
 * the current or next Asia/Shanghai week, then reports the full v2 weekly
 * content in the job's result_json (#585 — no draft insert; the admin reviews
 * the artifact and applies it through the existing admin endpoint).
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
    const content = weeklyPlanToContent(weeklyPlan);
    return {
      result: JSON.stringify({
        content,
        week_name: weeklyPlan.week_name,
        phase,
        generation_attempts: generationAttempts,
        generated_by: "plan-job",
      }),
    };
  };
}

/**
 * The graph structurally targets the current or next Shanghai week (via
 * `planningStartDate`), but a misbehaving kernel could still emit a stale week;
 * guard so an artifact never lands for a week the client did not ask for.
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
