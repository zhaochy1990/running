/**
 * SSE adapter for the Coach chat endpoint.
 *
 * Drives a single-pass LangGraph stream (`stream_mode: ["messages", "values"]`)
 * into the SSE event contract the client consumes:
 *
 * - `status` — phases the coach entered. `running_tool` is emitted once when a
 *   tool starts and once when it finishes (each invocation has a matching
 *   start/end). `analyzing` marks the switch from fetching data to composing the
 *   reply: it fires when the last in-flight tool lands, or — for a turn that
 *   calls no tool — when the reply text starts.
 * - `text_delta` — successive chunks of the final reply text, which the client
 *   concatenates to the message in `done`.
 * - `done` — the same public response as the sync path (full message, usage),
 *   emitted once the run reaches its final state.
 *
 * The graph is a plain intent-router (no deepagents subagents), so there is no
 * `subagents` projection and no `in_subagent` phase. `run.output` is
 * authoritative, so a hung or rejecting iterable must not fail the turn nor
 * delay `done` past the drain bound.
 */
import type { CoachStreamSource } from "../coach/coachInvoker.js";
import { toPublicResponse } from "../publicResponse.js";

/** Phase labels a `status` event can carry. */
export type CoachStatusPhase = "running_tool" | "analyzing";

export type ToolCallStatus = "running" | "finished" | "error";

/** A single event the adapter emits: either a phase status or a text delta. */
export type CoachStreamEvent = { kind: "status"; phase: CoachStatusPhase; tool?: string; toolStatus?: ToolCallStatus } | { kind: "text_delta"; delta: string };

export type CoachStreamEmitter = (event: CoachStreamEvent) => Promise<void>;

/** Structural view of a LangChain message chunk — avoids a `@langchain/core` dep. */
interface MessageLike {
  _getType?: () => string;
  content?: unknown;
  tool_calls?: Array<{ id?: string; name?: string }>;
  tool_call_id?: string;
  status?: string;
}

interface StatusPhases {
  readonly started: (tool: string) => Promise<void>;
  readonly finished: (tool: string, toolStatus: ToolCallStatus) => Promise<void>;
  readonly analyzing: () => Promise<void>;
}

/**
 * How long to wait for the stream to drain after the run has produced its final
 * state before emitting `done`. Real runs drain in milliseconds; the bound only
 * guards against a hung iterable so the connection is never left open without a
 * terminal event.
 */
const DRAIN_TIMEOUT_MS = 5_000;

/**
 * Drive a single-pass graph stream to completion while emitting status and
 * text_delta events, and return the public response for the `done` event.
 */
export async function collectCoachStream(run: CoachStreamSource, emit: CoachStreamEmitter): Promise<Record<string, unknown>> {
  // The drain is raced against the bound below; events that resolve afterwards
  // must never land after `done` (a late write would trail the terminal event).
  let settled = false;
  const safeEmit: CoachStreamEmitter = (event) => (settled ? Promise.resolve() : emit(event));

  const phases = toolPhases(safeEmit);
  const pendingTools = new Map<string, string>();
  let output: unknown;

  const drain = (async () => {
    for await (const chunk of run.events) {
      const [mode, payload] = chunk;
      if (mode === "messages") {
        await handleMessage(payload, safeEmit, phases, pendingTools);
      } else if (mode === "values") {
        output = payload;
      }
    }
  })().catch(() => {});

  await Promise.race([drain, sleep(DRAIN_TIMEOUT_MS)]);
  settled = true;
  return withUsage(toPublicResponse(output), output);
}

/** Emit running_tool / analyzing / text_delta for one `messages` chunk. */
async function handleMessage(payload: unknown, emit: CoachStreamEmitter, phases: StatusPhases, pendingTools: Map<string, string>): Promise<void> {
  const [message] = payload as [MessageLike, ...unknown[]];
  const type = message?._getType?.();

  // Tool call start: an AI message carrying `tool_calls`.
  const toolCalls = message?.tool_calls ?? [];
  for (const call of toolCalls) {
    if (!call?.name) continue;
    await phases.started(call.name);
    if (call.id !== undefined) pendingTools.set(call.id, call.name);
  }

  // Tool result end: a Tool message carrying `tool_call_id`.
  if (type === "tool") {
    const toolCallId = message?.tool_call_id;
    if (toolCallId !== undefined) {
      const name = pendingTools.get(toolCallId);
      if (name !== undefined) {
        const status = message?.status === "error" ? ("error" as const) : ("finished" as const);
        await phases.finished(name, status);
      }
      pendingTools.delete(toolCallId);
    }
  }

  // Reply text: an AI message's text content.
  if (type === "ai") {
    const text = textContent(message?.content);
    if (text.length > 0) {
      await phases.analyzing();
      await emit({ kind: "text_delta", delta: text });
    }
  }
}

/**
 * Track tool-call in-flight count and the `analyzing` transition. `running_tool`
 * start/end keep the count balanced; `analyzing` fires once — either when the
 * last tool lands or when the reply text starts (a no-tool turn).
 */
function toolPhases(emit: CoachStreamEmitter): StatusPhases {
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
      if (inFlight === 0) await analyzingStatus();
    },
  };
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("\n");
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
  // (orchestrator, business node, reply) and users want the total spend. This is
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
