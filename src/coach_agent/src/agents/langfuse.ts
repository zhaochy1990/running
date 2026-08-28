/**
 * Langfuse tracing for the coach agent.
 *
 * This module wires Langfuse into the deep-agent runtime using the *current*
 * Langfuse JS SDK generation (@langfuse/* v5, OpenTelemetry-based), which is
 * the officially recommended integration for LangChain / LangGraph:
 *
 *   - `@langfuse/langchain` `CallbackHandler` is passed as a LangGraph
 *     `callbacks` entry on the top-level invoke config. LangGraph propagates
 *     callbacks into subgraph invocations (deep-agent subagents dispatch via
 *     the `task` tool with `...config`), so the orchestrator AND every
 *     subagent (qa, weekly_plan, master_plan, …) are traced under one trace.
 *   - `@langfuse/otel` `LangfuseSpanProcessor` exports the OpenTelemetry
 *     spans to Langfuse. We register it once at startup.
 *
 * Privacy: content-blocking observation input/output/metadata are captured by
 * default, so traces are debuggable end-to-end (the intended use of a tracing
 * platform). To redact prompts/responses to structural metadata only (matching
 * the coach-agent logging convention of "metadata only"), set
 * `LANGFUSE_REDACT_CONTENT=true` — the span processor's `mask` then keeps span
 * names, hierarchy, observation types, model names, token usage and tool names,
 * while stripping the actual text.
 *
 * The whole setup is a no-op unless Langfuse credentials are present, so
 * local runs without `LANGFUSE_*` env vars keep working untouched.
 */

import { CallbackHandler } from "@langfuse/langchain";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes } from "@langfuse/tracing";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { getLogger } from "@stride/common";

const logger = getLogger("langfuse");

/** The trace name for a coach-orchestrator turn (top-level deep agent). */
const ORCHESTRATOR_TRACE_NAME = "coach-orchestrator";

/** Tag applied to every coach trace; distinguishes them from other apps. */
const COACH_TAG = "coach-agent";

/** Max recursion depth for the privacy redaction (bounds object walking). */
const MAX_REDACT_DEPTH = 4;
/** Max array items kept per level before collapsing into a count. */
const MAX_REDACT_ITEMS = 200;

/**
 * Keys whose values are short, structural identifiers and are safe to keep
 * verbatim. Everything else (message content, prompt text, tool args/results,
 * model responses) is redacted to a length placeholder.
 */
const SAFE_KEYS = new Set([
  "role",
  "type",
  "name",
  "model",
  "tool",
  "id",
  "status",
  "level",
  "kind",
  "format",
  "unit",
  "agent",
  "subagent_type",
  "session_id",
  "run_id",
  "intent",
  "className",
  "direction",
  "available",
]);

/** Whether Langfuse tracing should be active for this process. */
export function isLangfuseEnabled(): boolean {
  if (process.env.LANGFUSE_TRACING === "false" || process.env.LANGFUSE_TRACING === "0") {
    return false;
  }
  return Boolean(process.env.LANGFUSE_PUBLIC_KEY?.trim() && process.env.LANGFUSE_SECRET_KEY?.trim() && process.env.LANGFUSE_BASE_URL?.trim());
}

/**
 * Redact content-bearing span data for Langfuse export.
 *
 * Content is captured by default. When `LANGFUSE_REDACT_CONTENT=true` is set,
 * this recursively walks the value, preserves object keys and a small
 * allowlist of structural keys, and replaces every other string with a
 * `[redacted:N chars]` placeholder. Numbers/booleans are kept. Array length and
 * depth are bounded.
 */
export function maskSensitiveData(params: { data: unknown }): unknown {
  if (process.env.LANGFUSE_REDACT_CONTENT !== "true") {
    return params.data;
  }
  return redact(params.data, 0);
}

function redact(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return value.length === 0 ? value : `[redacted:${value.length} chars]`;
  }
  if (typeof value !== "object") {
    // number / boolean / bigint are safe to keep
    return value;
  }
  if (depth >= MAX_REDACT_DEPTH) {
    return "[redacted]";
  }
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_REDACT_ITEMS).map((item) => redact(item, depth + 1));
    if (value.length > MAX_REDACT_ITEMS) {
      kept.push(`[+${value.length - MAX_REDACT_ITEMS} more]`);
    }
    return kept;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SAFE_KEYS.has(key)) {
      out[key] = item;
    } else {
      out[key] = redact(item, depth + 1);
    }
  }
  return out;
}

let tracerProvider: NodeTracerProvider | undefined;
let langfuseSpanProcessor: LangfuseSpanProcessor | undefined;

/**
 * Register the Langfuse OpenTelemetry span processor once per process.
 * Idempotent. Returns `undefined` when Langfuse is not configured/enabled.
 */
function ensureSpanProcessor(): LangfuseSpanProcessor | undefined {
  if (langfuseSpanProcessor) {
    return langfuseSpanProcessor;
  }
  if (!isLangfuseEnabled()) {
    logger.info({ enabled: false }, "langfuse tracing disabled (missing LANGFUSE_* credentials or LANGFUSE_TRACING=false)");
    return undefined;
  }

  const tracingEnvironment = process.env.LANGFUSE_TRACING_ENVIRONMENT ?? process.env.LANGFUSE_ENVIRONMENT;
  const tracingRelease = process.env.LANGFUSE_RELEASE ?? process.env.LANGFUSE_VERSION;
  langfuseSpanProcessor = new LangfuseSpanProcessor({
    // Privacy: redact content-bearing attributes on export (metadata only).
    mask: maskSensitiveData,
    ...(tracingEnvironment ? { environment: tracingEnvironment } : {}),
    ...(tracingRelease ? { release: tracingRelease } : {}),
  });
  tracerProvider = new NodeTracerProvider({ spanProcessors: [langfuseSpanProcessor] });
  tracerProvider.register();
  // Never log the processor object: it holds the Langfuse API keys in its
  // apiClient config (AGENTS.md: credentials/tokens never hit logs).
  logger.info({ enabled: true, environment: tracingEnvironment ?? undefined }, "langfuse span processor registered");
  return langfuseSpanProcessor;
}

export interface LangfuseHandlerOptions {
  userId?: string;
  sessionId?: string;
  tags?: string[];
}

/**
 * Build a LangChain/LangGraph `CallbackHandler` for the current invocation.
 * Returns `undefined` when Langfuse is disabled so callers can skip the
 * callback wiring without special-casing.
 */
export function createLangfuseCallbackHandler(options: LangfuseHandlerOptions = {}): CallbackHandler | undefined {
  if (!ensureSpanProcessor()) {
    return undefined;
  }
  return new CallbackHandler({
    ...(options.userId ? { userId: options.userId } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.tags && options.tags.length > 0 ? { tags: options.tags } : {}),
  });
}

/**
 * Wrap a deep agent's `invoke` so every turn is traced by Langfuse.
 *
 * The orchestrator is the top-level deep agent; subagents (qa, weekly_plan,
 * master_plan, …) are dispatched via the `task` tool, and LangGraph propagates
 * `callbacks` into their subgraph invocations — so one handler at the top-level
 * config captures the whole tree.
 */
export function withLangfuseInvokeTracing<T extends { invoke: (input: unknown, config?: Record<string, unknown>) => unknown }>(agent: T): T {
  if (!isLangfuseEnabled()) {
    return agent;
  }

  // Bind to the agent so a `this`-dependent `invoke` keeps working.
  const originalInvoke = agent.invoke.bind(agent);
  const wrappedInvoke = async (input: unknown, config: Record<string, unknown> = {}) => {
    const context = (config.context ?? {}) as Record<string, unknown>;
    const userId = typeof context.userId === "string" ? context.userId : undefined;
    const configurable = (config.configurable ?? {}) as Record<string, unknown>;
    const threadId = typeof configurable.thread_id === "string" ? configurable.thread_id : undefined;

    const handler = createLangfuseCallbackHandler({
      ...(userId ? { userId } : {}),
      ...(threadId ? { sessionId: threadId } : {}),
      tags: [COACH_TAG],
    });
    if (!handler) {
      return originalInvoke(input as never, config as never);
    }

    const callbacks = [...((config.callbacks as unknown[] | undefined) ?? []), handler];
    const nextConfig = { ...config, callbacks };

    // `traceName` is set here (and at the root chain start by the CallbackHandler
    // for user/session/tags) so traces are named and filterable.
    return propagateAttributes({ traceName: ORCHESTRATOR_TRACE_NAME }, () => originalInvoke(input as never, nextConfig as never));
  };

  // Preserve the agent's other methods by mutating only `invoke`.
  (agent as { invoke: typeof wrappedInvoke }).invoke = wrappedInvoke;
  return agent;
}

/**
 * Flush pending Langfuse spans. Call on process shutdown (or after a batch of
 * work in a short-lived script) so spans are not lost when the process exits.
 */
export async function flushLangfuse(): Promise<void> {
  if (!langfuseSpanProcessor) {
    return;
  }
  await langfuseSpanProcessor.forceFlush();
}
