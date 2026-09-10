/**
 * SSE adapter for the Coach chat endpoint.
 *
 * Maps a deepagents v3 `streamEvents` run into the SSE event contract the
 * client consumes:
 *
 * - `status` — phases the coach entered (`in_subagent`, `running_tool`,
 *   `analyzing`). `running_tool` is emitted once when a tool starts and once
 *   when it leaves `running`, so every invocation has a matching start and end
 *   event. `analyzing` marks the switch from fetching data to composing the
 *   reply: it is emitted when the last of the root agent's tool calls lands
 *   (see {@link toolPhases}), and for a turn that calls no tool at all when the
 *   reply text starts.
 * - `text_delta` — successive chunks of the final reply text (L1), which the
 *   client concatenates to the message in `done`.
 * - `done` — the same public response as the sync path (full message, usage),
 *   emitted once the run reaches its final state.
 *
 * The adapter drives the run to completion while emitting events; `run.output`
 * is authoritative, so a hung or rejecting iterable must not fail the turn nor
 * delay `done` past the drain bound.
 */
import type {
  CoachStreamMessage,
  CoachStreamNode,
  CoachStreamSource,
  CoachStreamSubagent,
  CoachStreamToolCall,
  ToolCallStatus,
} from "../coach/coachInvoker.js";
import { toPublicResponse } from "../publicResponse.js";

/** Phase labels a `status` event can carry. */
export type CoachStatusPhase = "in_subagent" | "running_tool" | "analyzing";

/** A single event the adapter emits: either a phase status or a text delta. */
export type CoachStreamEvent =
  | { kind: "status"; phase: CoachStatusPhase; subagent?: string; tool?: string; toolStatus?: ToolCallStatus }
  | { kind: "text_delta"; delta: string };

export type CoachStreamEmitter = (event: CoachStreamEvent) => Promise<void>;

/** Per-subtree tool call status emitter (see {@link toolPhases}). */
interface StatusPhases {
  readonly started: (tool: string) => Promise<void>;
  readonly finished: (tool: string, toolStatus: ToolCallStatus) => Promise<void>;
  readonly analyzing: () => Promise<void>;
}

/**
 * How long to wait for nested status / text events to drain after the run has
 * produced its final state before emitting `done`. Real runs drain in
 * milliseconds; the bound only guards against a hung iterable so the connection
 * is never left open without a terminal event.
 */
const DRAIN_TIMEOUT_MS = 5_000;

/**
 * Drive a v3 run to completion while emitting status and text_delta events, and
 * return the public response for the `done` event.
 */
export async function collectCoachStream(run: CoachStreamSource, emit: CoachStreamEmitter): Promise<Record<string, unknown>> {
  // The drain is raced against the bound below, and the run's channels can
  // close under it, so events that resolve afterwards must never land after
  // `done` (a late write would either trail the terminal event or throw on the
  // closed SSE stream).
  let settled = false;
  const safeEmit: CoachStreamEmitter = (event) => (settled ? Promise.resolve() : emit(event));

  // Emit L2 statuses (tools, subagents) and the L1 reply text, then flush.
  // Rejecting or hung iterables must not fail the turn (run.output is
  // authoritative) nor delay `done` past the drain bound.
  const drain = drainRoot(run, safeEmit).catch(() => {});
  const output = await run.output;
  await Promise.race([drain, sleep(DRAIN_TIMEOUT_MS)]);
  settled = true;
  return withUsage(toPublicResponse(output), output);
}

/**
 * Drive the root run: its subagent / tool statuses and the reply text from
 * `run.messages` — the outer agent's final message — merge into one event
 * stream as the run progresses. A subagent's own messages are an intermediate
 * tool result (surfaced as L3 tool detail later), never the reply, so only its
 * subagents and tools are drained for L2 status.
 */
async function drainRoot(run: CoachStreamSource, emit: CoachStreamEmitter): Promise<void> {
  // Status and text must drain concurrently. The run's `toolCalls` / `subagents`
  // projections are channels that only close when the whole run ends, so
  // awaiting status first would keep `run.messages` unconsumed until the reply
  // had already been generated — every `text_delta` would then be replayed in a
  // single burst right before `done` (the stream looks non-streaming).
  const phases = toolPhases(emit, true);
  await Promise.all([drainStatus(run, emit, phases), drainText(run.messages, emit, phases)]);
}

/**
 * Emits the `running_tool` status of one subtree's tool calls, and — for the
 * root subtree only — owns the `analyzing` transition.
 *
 * Root tool calls are what "fetching data" means: a `task` call stays in flight
 * for a whole subagent run, so the moment no root tool call is pending is
 * exactly the moment the coach stops gathering data and starts composing the
 * reply — well before the first reply token arrives. Nested tool calls are
 * emitted as L2 detail without driving the phase (they are already covered by
 * the `task` call that spawned them, and a subagent's own projections are less
 * predictable than the root agent's).
 */
function toolPhases(emit: CoachStreamEmitter, drivesPhase: boolean): StatusPhases {
  let inFlight = 0;
  let analyzing = false;
  const analyzingStatus = async (): Promise<void> => {
    if (analyzing) return;
    analyzing = true;
    await emit({ kind: "status", phase: "analyzing" });
  };
  return {
    analyzing: analyzingStatus,
    async started(tool: string): Promise<void> {
      inFlight += 1;
      analyzing = false;
      await emit({ kind: "status", phase: "running_tool", tool, toolStatus: "running" });
    },
    async finished(tool: string, toolStatus: ToolCallStatus): Promise<void> {
      inFlight -= 1;
      await emit({ kind: "status", phase: "running_tool", tool, toolStatus });
      if (drivesPhase && inFlight === 0) await analyzingStatus();
    },
  };
}

/** Emit a node's tool and nested-subagent status events (L2), no text. */
async function drainStatus(node: CoachStreamNode, emit: CoachStreamEmitter, phases: StatusPhases): Promise<void> {
  // Tool calls and subagents are independent projections that both only close
  // with the run, so they must drain concurrently: awaiting the tool channel
  // first would withhold every subagent status until the run was over.
  await Promise.all([drainToolCalls(node.toolCalls, phases), drainSubagents(node.subagents, emit)]);
}

/** Emit each subagent as it is entered, then drain its subtree. */
async function drainSubagents(subagents: AsyncIterable<CoachStreamSubagent>, emit: CoachStreamEmitter): Promise<void> {
  const drains: Promise<void>[] = [];
  for await (const subagent of subagents) {
    await emit({ kind: "status", phase: "in_subagent", subagent: subagent.name });
    // Started but not awaited: sibling subagents may be running concurrently,
    // and each one streams its own status. A failing status iterable is
    // non-fatal (the reply is the run's authoritative output), so it is dropped
    // here rather than surfacing as an unhandled rejection.
    drains.push(drainStatus(subagent, emit, toolPhases(emit, false)).catch(() => {}));
  }
  await Promise.all(drains);
}

/** Emit a start event when a tool begins, then its matching end event. */
async function drainToolCalls(toolCalls: AsyncIterable<CoachStreamToolCall>, phases: StatusPhases): Promise<void> {
  const endings: Promise<void>[] = [];
  for await (const call of toolCalls) {
    await phases.started(call.name);
    // Deliberately not awaited inside the loop: sibling tool calls run in
    // parallel and must report their own end, in their own time. Status
    // emission is best-effort, so a failure is dropped instead of failing the
    // turn (and instead of surfacing as an unhandled rejection here).
    endings.push(
      call.status
        .catch(() => "error" as const)
        .then((status) => phases.finished(call.name, status))
        .catch(() => {}),
    );
  }
  await Promise.all(endings);
}

/**
 * Stream the reply text as `text_delta`, preceded by `analyzing` when the phase
 * has not already flipped there (a turn that calls no tool never does).
 * ponytail: the outer agent produces exactly one text reply (the orchestrator
 * uses structured output, tool calls carry no text), so the sum of these deltas
 * equals `done.message`. If a turn ever emits a second text AI message, restrict
 * this to the final message.
 */
async function drainText(messages: AsyncIterable<CoachStreamMessage>, emit: CoachStreamEmitter, phases: StatusPhases): Promise<void> {
  for await (const message of messages) {
    for await (const delta of message.text) {
      if (delta.length === 0) continue;
      await phases.analyzing();
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
