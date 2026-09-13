import { type PhaseName, type WeeklyPlan, WeeklyPlanGeneratorOutcome, type WeeklyPlanGeneratorRequest } from "@stride/contract";
import { newPermanentError } from "../../job/errors.js";
import type { Heartbeat } from "../../job/ports.js";
import { MonotonicProgress, type StageProgress } from "../progress.js";

/** Weekly-plan kernel nodes → stage/progress anchors (in graph execution order). */
export const WEEKLY_PLAN_NODES: Record<string, StageProgress> = {
  loadWeeklyPlanContext: { stage: "reading_history", progressPct: 10 },
  getTargetTrainingLoad: { stage: "evaluating", progressPct: 25 },
  phase_base: { stage: "planning_phases", progressPct: 55 },
  phase_build: { stage: "planning_phases", progressPct: 55 },
  phase_speed: { stage: "planning_phases", progressPct: 55 },
  phase_marathon: { stage: "planning_phases", progressPct: 55 },
  phase_taper: { stage: "planning_phases", progressPct: 55 },
  phase_recovery: { stage: "planning_phases", progressPct: 55 },
  simulate_load: { stage: "rule_filter", progressPct: 75 },
  finalize: { stage: "outputting", progressPct: 99 },
};

/**
 * Shape of the compiled weekly-plan graph the runner depends on. A real graph
 * is `ReturnType<typeof createWeeklyPlanGeneratorGraph>` (from
 * `@stride/coach-agent`); tests inject a fake with the same stream contract.
 */
export interface WeeklyPlanGraphShim {
  stream(
    input: unknown,
    options: { context: { userId: string; generationId: string }; streamMode: readonly string[] },
  ): Promise<AsyncIterable<Record<string, unknown>>>;
}

/**
 * Structural cast from the compiled kernel: it satisfies this runtime shape,
 * but its generic `stream` signature is not assignable to the non-generic shim.
 */
export function toWeeklyPlanGraphShim(graph: unknown): WeeklyPlanGraphShim {
  return graph as WeeklyPlanGraphShim;
}

/**
 * Run the weekly kernel with per-node streaming updates and return the
 * completed plan. Non-completed terminal decisions (`quality_failure` reasons)
 * throw a permanent `KernelDecisionError` with a stable code; the kernel's own
 * `infrastructure_failure` decision throws a plain (retryable) error so the
 * dispatcher's retry policy applies.
 */
export async function runWeeklyKernel(
  graph: WeeklyPlanGraphShim,
  request: WeeklyPlanGeneratorRequest,
  runtime: { userId: string; generationId: string },
  hb: Heartbeat,
): Promise<{ weeklyPlan: WeeklyPlan; phase: PhaseName; generationAttempts: number }> {
  const stream = await graph.stream({ request }, { context: runtime, streamMode: ["updates"] });
  const progress = new MonotonicProgress(WEEKLY_PLAN_NODES);
  let outcomeRaw: unknown = null;

  for await (const rawChunk of stream) {
    // With an array streamMode langgraph yields ["updates", {node: update}]
    // tuples; with a single mode it yields the update map directly.
    const chunk = Array.isArray(rawChunk) ? (rawChunk[rawChunk.length - 1] as Record<string, unknown>) : (rawChunk as Record<string, unknown>);
    for (const [nodeKey, update] of Object.entries(chunk)) {
      const mapped = progress.observe(nodeKey);
      if (mapped !== null) {
        await hb(mapped.stage, mapped.progressPct);
      }
      if (isRecord(update) && "outcome" in update) {
        outcomeRaw = update.outcome;
      }
    }
  }

  if (outcomeRaw === null) {
    throw newPermanentError("kernel_no_outcome", new Error("kernel stream ended without a terminal outcome"));
  }
  const outcome = WeeklyPlanGeneratorOutcome.parse(outcomeRaw);
  if (outcome.decision === "infrastructure_failure") {
    // Retryable transient infra (e.g. context snapshot DB blip) — the dispatcher's
    // retry queue decides (ADR 0030: retry ≤2, business failures never retried).
    throw new Error(`weekly kernel infrastructure failure: ${outcome.reason}`);
  }
  if (outcome.decision !== "completed") {
    throw weeklyDecisionError(outcome);
  }
  return { weeklyPlan: outcome.weekly_plan, phase: outcome.phase, generationAttempts: outcome.generation_attempts };
}

function weeklyDecisionError(outcome: { reason: string }): Error {
  const code = DECISION_CODES[outcome.reason] ?? "kernel_weekly_not_completed";
  return newPermanentError(code, new Error(`weekly kernel returned quality_failure: ${outcome.reason}`));
}

/** Stable error codes per weekly `quality_failure` reason (never retried). */
const DECISION_CODES: Record<string, string> = {
  phase_unresolvable: "kernel_weekly_phase_unresolvable",
  generation_failed: "kernel_weekly_generation_failed",
  load_mismatch_unresolved: "kernel_weekly_load_mismatch_unresolved",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
