/**
 * SSE adapter for the Coach chat endpoint.
 *
 * Maps a deepagents v3 `streamEvents` run into the SSE event contract the
 * client consumes:
 *
 * - `status` — phases the coach entered (`analyzing_intent`, `in_subagent`,
 *   `running_tool`, `generating_response`). `running_tool` is emitted once
 *   when a tool starts and once when it leaves `running`, so every invocation
 *   has a matching start and end event.
 * - `text_delta` — successive chunks of the final reply text (L1), which the
 *   client concatenates to the message in `done`.
 * - `done` — the same public response as the sync path (full message, usage),
 *   emitted once the run reaches its final state.
 *
 * The adapter drives the run to completion while emitting events; `run.output`
 * is authoritative, so a hung or rejecting iterable must not fail the turn nor
 * delay `done` past the drain bound.
 */
import type { CoachStreamMessage, CoachStreamNode, CoachStreamSource, CoachStreamToolCall, ToolCallStatus } from "../coach/coachInvoker.js";
import { toPublicResponse } from "../publicResponse.js";

/** Phase labels a `status` event can carry. */
export type CoachStatusPhase = "analyzing_intent" | "in_subagent" | "running_tool" | "generating_response";

/** A single event the adapter emits: either a phase status or a text delta. */
export type CoachStreamEvent =
  | { kind: "status"; phase: CoachStatusPhase; subagent?: string; tool?: string; toolStatus?: ToolCallStatus }
  | { kind: "text_delta"; delta: string };

export type CoachStreamEmitter = (event: CoachStreamEvent) => Promise<void>;

/**
 * How long to wait for nested status / text events to drain after the run has
 * produced its final state before emitting `done`. Real runs drain in
 * milliseconds; the bound only guards against a hung iterable so the connection
 * is never left open without a terminal event.
 */
const DRAIN_TIMEOUT_MS = 5_000;

/**
 * Drive a v3 run to completion while emitting status and text_delta events, and
 * return the public response for the `done` event. `analyzing_intent` is emitted
 * before anything else so every stream carries at least one status event.
 */
export async function collectCoachStream(run: CoachStreamSource, emit: CoachStreamEmitter): Promise<Record<string, unknown>> {
  await emit({ kind: "status", phase: "analyzing_intent" });

  // Emit L2 statuses (tools, subagents) and the L1 reply text, then flush.
  // Rejecting or hung iterables must not fail the turn (run.output is
  // authoritative) nor delay `done` past the drain bound.
  const drain = drainRoot(run, emit).catch(() => {});
  const output = await run.output;
  await Promise.race([drain, sleep(DRAIN_TIMEOUT_MS)]);
  return withUsage(toPublicResponse(output), output);
}

/**
 * Drive the root run: its subagent / tool statuses first (they feed the reply),
 * then the reply text from `run.messages` — the outer agent's final message.
 * A subagent's own messages are an intermediate tool result (Surfaced as L3
 * tool detail later), never the reply, so only its subagents and tools are
 * drained for L2 status.
 */
async function drainRoot(run: CoachStreamSource, emit: CoachStreamEmitter): Promise<void> {
  await drainStatus(run, emit);
  await drainText(run.messages, emit);
}

/** Emit a node's tool and nested-subagent status events (L2), no text. */
async function drainStatus(node: CoachStreamNode, emit: CoachStreamEmitter): Promise<void> {
  await drainToolCalls(node.toolCalls, emit);
  for await (const subagent of node.subagents) {
    await emit({ kind: "status", phase: "in_subagent", subagent: subagent.name });
    await drainStatus(subagent, emit);
  }
}

/** Emit a start event when a tool begins, then its matching end event. */
async function drainToolCalls(toolCalls: AsyncIterable<CoachStreamToolCall>, emit: CoachStreamEmitter): Promise<void> {
  for await (const call of toolCalls) {
    await emit({ kind: "status", phase: "running_tool", tool: call.name, toolStatus: "running" });
    const status = await call.status.catch(() => "error" as const);
    await emit({ kind: "status", phase: "running_tool", tool: call.name, toolStatus: status });
  }
}

/**
 * Stream the reply text as `text_delta`, preceded once by `generating_response`.
 * ponytail: the outer agent produces exactly one text reply (the orchestrator
 * uses structured output, tool calls carry no text), so the sum of these deltas
 * equals `done.message`. If a turn ever emits a second text AI message, restrict
 * this to the final message.
 */
async function drainText(messages: AsyncIterable<CoachStreamMessage>, emit: CoachStreamEmitter): Promise<void> {
  let generating = false;
  for await (const message of messages) {
    for await (const delta of message.text) {
      if (delta.length === 0) continue;
      if (!generating) {
        generating = true;
        await emit({ kind: "status", phase: "generating_response" });
      }
      await emit({ kind: "text_delta", delta });
    }
  }
}

/**
 * Attach aggregated token usage to the `done` payload. Both fields come from the
 * same authoritative final state: the reply text from `toPublicResponse`, the
 * usage by summing the AI messages' `usage_metadata` (`undefined` when none were
 * reported, so the client can omit it).
 */
function withUsage(response: Record<string, unknown>, output: unknown): Record<string, unknown> {
  const usage = usageFromOutput(output);
  return usage === undefined ? response : { ...response, usage };
}

function usageFromOutput(output: unknown): Record<string, unknown> | undefined {
  if (!isRecord(output) || !Array.isArray(output.messages)) return undefined;
  // Sum `usage_metadata` across messages: the coach runs several model steps
  // (orchestrator, subagents, reply) and users want the total spend. This is
  // aggregate usage, so `input_tokens` may over-count the shared prompt prefix.
  let input = 0;
  let outputTokens = 0;
  let total = 0;
  let found = false;
  for (const message of output.messages) {
    if (!isRecord(message) || !isRecord(message.usage_metadata)) continue;
    const usage = message.usage_metadata as Record<string, unknown>;
    const i = readCount(usage.input_tokens);
    const o = readCount(usage.output_tokens);
    if (i === undefined && o === undefined) continue;
    found = true;
    input += i ?? 0;
    outputTokens += o ?? 0;
    const t = readCount(usage.total_tokens);
    total += t ?? (i ?? 0) + (o ?? 0);
  }
  return found ? { input_tokens: input, output_tokens: outputTokens, total_tokens: total } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
