import { type MasterPlan, MasterPlanGraphOutcome, type MasterPlanGraphRequest } from "@stride/contract";
import { newPermanentError } from "../job/errors.js";
import type { Heartbeat } from "../job/ports.js";
import { MonotonicProgress } from "./progress.js";

/**
 * Shape of the compiled master-plan graph the runner depends on. A real graph
 * is `ReturnType<typeof createMasterPlanGraph>` (from `@stride/coach-agent`);
 * tests inject a fake with the same stream contract.
 */
export interface MasterPlanGraphShim {
  stream(
    input: unknown,
    options: { context: { userId: string; generationId: string }; streamMode: readonly string[] },
  ): Promise<AsyncIterable<Record<string, unknown>>>;
}

/**
 * Structural cast from the compiled kernel: it satisfies this runtime shape,
 * but its generic `stream` signature is not assignable to the non-generic shim.
 */
export function toMasterPlanGraphShim(graph: unknown): MasterPlanGraphShim {
  return graph as MasterPlanGraphShim;
}

/**
 * Run the master kernel with per-node streaming updates and return the
 * completed plan. Non-completed terminal decisions (goal conflict, quality
 * gate, needs-baseline, …) throw a permanent `KernelDecisionError` with a
 * stable code; the kernel's own `infrastructure_failure` decision throws a
 * plain (retryable) error so the dispatcher's retry policy applies.
 */
export async function runMasterKernel(
  graph: MasterPlanGraphShim,
  request: MasterPlanGraphRequest,
  runtime: { userId: string; generationId: string },
  hb: Heartbeat,
): Promise<{ plan: MasterPlan; revision: number }> {
  const stream = await graph.stream({ request }, { context: runtime, streamMode: ["updates"] });
  const progress = new MonotonicProgress();
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
  const outcome = MasterPlanGraphOutcome.parse(outcomeRaw);
  if (outcome.decision === "infrastructure_failure") {
    // Retryable transient infra (e.g. context snapshot DB blip) — the dispatcher's
    // retry queue decides (ADR 0030: retry ≤2, business failures never retried).
    throw new Error(`master kernel infrastructure failure: ${outcome.code}`);
  }
  if (outcome.decision !== "completed") {
    throw kernelDecisionError(outcome);
  }
  return { plan: outcome.artifact.plan, revision: outcome.artifact.artifact_revision };
}

function kernelDecisionError(outcome: { decision: string }): Error {
  const code = DECISION_CODES[outcome.decision] ?? "kernel_not_completed";
  return newPermanentError(code, new Error(`kernel returned ${outcome.decision}`));
}

/** Stable error codes per kernel non-completed decision (never retried). */
const DECISION_CODES: Record<string, string> = {
  review_completed: "kernel_review_not_plan",
  preview_completed: "kernel_preview_not_plan",
  needs_clarification: "kernel_needs_clarification",
  needs_baseline: "kernel_needs_baseline",
  goal_conflict: "kernel_goal_conflict",
  multi_cycle_required: "kernel_multi_cycle_required",
  blocked_for_safety: "kernel_blocked_for_safety",
  unsupported: "kernel_unsupported_mode",
  failed_quality_gate: "kernel_quality_gate_failed",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
