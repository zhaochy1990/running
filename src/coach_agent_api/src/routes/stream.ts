/**
 * SSE adapter for the Coach chat endpoint.
 *
 * Maps a deepagents v3 `streamEvents` run into the small status-snapshot
 * contract the client polls: `status` events as the run enters phases, then a
 * `done` event carried out of the turn coordinator (same public response as
 * the sync path). The client correlates retries via `turn_id`, always the
 * request's client_turn_id.
 */
import type { CoachStreamSource } from "../coach/coachInvoker.js";
import { toPublicResponse } from "../publicResponse.js";

export type CoachStreamEmitter = (event: CoachStatusEvent) => Promise<void>;

/** One `status` event: a phase the coach entered. */
export interface CoachStatusEvent {
  phase: "analyzing_intent" | "in_subagent";
  subagent?: string;
}

/**
 * How long to wait for subagent status events to flush after the run has
 * produced its final state before emitting `done`. Real runs drain in
 * milliseconds; the bound only guards against a hung subagent iterable so the
 * connection is never left open without a terminal event.
 */
const SUBAGENT_STATUS_DRAIN_TIMEOUT_MS = 5_000;

/**
 * Drive a v3 run to completion while emitting status events, and return the
 * public response for the `done` event. `analyzing_intent` is emitted before
 * any subagent is discovered so every stream carries at least one status event.
 */
export async function collectCoachStream(run: CoachStreamSource, emit: CoachStreamEmitter): Promise<Record<string, unknown>> {
  await emit({ phase: "analyzing_intent" });
  // Status events are best-effort: a subagent iterable that rejects or hangs
  // must not fail the turn (run.output is authoritative) nor delay `done`. The
  // swallow also keeps a rejection from surfacing as an unhandled rejection.
  const subagentStatuses = drainSubagentStatuses(run, emit).catch(() => {});
  const output = await run.output;
  // A subagent discovered near the end may still be queued; drain it so `done`
  // is always the last event — but only wait up to the timeout, so a stuck
  // iterable cannot delay the error event or the connection close.
  await Promise.race([subagentStatuses, sleep(SUBAGENT_STATUS_DRAIN_TIMEOUT_MS)]);
  return toPublicResponse(output);
}

async function drainSubagentStatuses(run: CoachStreamSource, emit: CoachStreamEmitter): Promise<void> {
  for await (const subagent of run.subagents) {
    await emit({ phase: "in_subagent", subagent: subagent.name });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
