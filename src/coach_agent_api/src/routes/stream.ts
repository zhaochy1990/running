/**
 * SSE adapter for the Coach chat endpoint.
 *
 * Maps a deepagents v3 `streamEvents` run into the small status-snapshot
 * contract the client polls: `status` events as the run enters phases, then a
 * `done` event carried out of the turn coordinator (same public response as
 * the sync path). The client correlates retries via `turn_id`, always the
 * request's client_turn_id.
 */
import type { SSEMessage } from "hono/streaming";
import type { CoachStreamSource } from "../coach/coachInvoker.js";
import { toPublicResponse } from "../publicResponse.js";

export type CoachStreamEmitter = (event: CoachStatusEvent) => Promise<void>;

/** One `status` event: a phase the coach entered. */
export interface CoachStatusEvent {
  phase: "analyzing_intent" | "in_subagent";
  subagent?: string;
}

/**
 * Drive a v3 run to completion while emitting status events, and return the
 * public response for the `done` event. `analyzing_intent` is emitted before
 * any subagent is discovered so every stream carries at least one status event.
 */
export async function collectCoachStream(run: CoachStreamSource, emit: CoachStreamEmitter): Promise<Record<string, unknown>> {
  await emit({ phase: "analyzing_intent" });
  const subagentStatuses = consumeSubagentStatuses(run, emit);
  try {
    const output = await run.output;
    // A subagent discovered near the end may still be queued; drain it so
    // `done` is always the last event.
    await subagentStatuses;
    return toPublicResponse(output);
  } finally {
    // The run already failed or finished; let the subagent consumer settle in
    // the background rather than await it, so a stuck iterable cannot delay
    // emitting the `error` event (or closing the connection).
    subagentStatuses.catch(() => {});
  }
}

async function consumeSubagentStatuses(run: CoachStreamSource, emit: CoachStreamEmitter): Promise<void> {
  for await (const subagent of run.subagents) {
    await emit({ phase: "in_subagent", subagent: subagent.name });
  }
}

/** Build one wire message; `data` is serialized per SSE (single line JSON). */
export function sseMessage(event: string, data: Record<string, unknown>): SSEMessage {
  return { event, data: JSON.stringify(data) };
}
