import { getLogger } from "@stride/common";

const logger = getLogger("publicResponse");

/** Convert a LangGraph Coach result into the API's intentionally small contract. */
export function toPublicResponse(result: unknown): Record<string, unknown> {
  const response = tryToPublicResponse(result);
  if (response !== undefined) return response;
  if (!isRecord(result)) throw new Error("coach returned an invalid result");
  if (!Array.isArray(result.messages)) {
    throw new Error("coach result has no messages");
  }
  throw new Error("coach result has no public message");
}

/**
 * Best-effort form used by checkpoint recovery. `undefined` means the tagged
 * turn was checkpointed but has not reached a public terminal result yet.
 */
export function tryToPublicResponse(result: unknown): Record<string, unknown> | undefined {
  if (!isRecord(result)) return undefined;
  const interrupts = result.__interrupt__;
  if (Array.isArray(interrupts) && interrupts.length > 0) {
    const first = interrupts[0];
    return {
      status: "needs_input",
      interrupt: isRecord(first) ? first.value : first,
    };
  }
  const message = lastReplyMessage(result.messages);
  if (message === undefined) return undefined;
  const text = textContent(message.content);
  return text !== undefined ? { status: "completed", message: text } : undefined;
}

/** The assistant message that carries the reply: the last one with no tool calls. */
function lastReplyMessage(messages: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isAssistantMessage(message)) continue;
    // An AI tool-call message is an intermediate graph step, not a reply.
    if (hasToolCalls(message)) return undefined;
    return message;
  }
  return undefined;
}

/** Why a turn's reply is unusable even though the run itself completed. */
export type DegradedReplyReason = "empty_reply" | "output_budget_exhausted";

/**
 * Warn when a completed turn produced no usable reply, or when the model spent
 * its entire output budget.
 *
 * A turn can finish "successfully" with empty text: reasoning tokens are billed
 * against `max_tokens`, so `reasoning_effort: max` can consume the whole budget
 * and leave `content` empty (observed: 16384/16384 output tokens were reasoning,
 * 45k chars of thinking, zero reply). Nothing else in the pipeline treats that
 * as a failure, so without this warning it is indistinguishable from a normal
 * turn — the checkpoint is the only place the cause is visible.
 *
 * Returns the reason so callers (and tests) can act on it, and logs it.
 */
export function warnOnDegradedReply(result: unknown, maxOutputTokens: number, context: Record<string, unknown> = {}): DegradedReplyReason | null {
  if (!isRecord(result)) return null;
  const message = lastReplyMessage(result.messages);
  if (message === undefined) return null;
  const usage = isRecord(message.usage_metadata) ? message.usage_metadata : {};
  const details = isRecord(usage.output_token_details) ? usage.output_token_details : {};
  const fields = {
    ...context,
    outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : null,
    reasoningTokens: typeof details.reasoning === "number" ? details.reasoning : null,
    maxOutputTokens,
  };

  const text = textContent(message.content);
  if (text === undefined || text.trim().length === 0) {
    logger.warn({ ...fields, reason: "empty_reply" }, "coach turn produced an empty reply");
    return "empty_reply";
  }
  if (maxOutputTokens > 0 && typeof usage.output_tokens === "number" && usage.output_tokens >= maxOutputTokens) {
    logger.warn({ ...fields, reason: "output_budget_exhausted" }, "coach turn exhausted its output token budget");
    return "output_budget_exhausted";
  }
  return null;
}

function hasToolCalls(message: Record<string, unknown>): boolean {
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
  const additional = message.additional_kwargs;
  return isRecord(additional) && Array.isArray(additional.tool_calls) && additional.tool_calls.length > 0;
}

function textContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts = content.flatMap((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []));
  return texts.length ? texts.join("\n") : undefined;
}

function isAssistantMessage(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (value.type === "ai") return true;
  const getType = value._getType;
  return typeof getType === "function" && getType.call(value) === "ai";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── Session history ──────────────────────────────────────────────────────────

/** One renderable turn in a session history: user bubbles + assistant replies. */
export interface SessionHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Flatten a thread's LangChain messages into a minified user/assistant history
 * suitable for a chat client. Tool / system / reasoning messages are dropped;
 * assistant messages that still carry tool calls are intermediate graph steps
 * and are skipped. User messages were stored JSON-wrapped
 * (`{ timestamp, message }`, see routes/chat.ts), so we unwrap to the raw text.
 */
export function toPublicHistory(messages: unknown[]): SessionHistoryMessage[] {
  const out: SessionHistoryMessage[] = [];
  for (const message of messages) {
    if (isHumanMessage(message)) {
      out.push({ role: "user", content: decodeUserMessage(message) });
      continue;
    }
    if (isAssistantMessage(message) && !hasToolCalls(message)) {
      const text = textContent(message.content);
      if (text !== undefined) out.push({ role: "assistant", content: text });
    }
  }
  return out;
}

function isHumanMessage(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (value.type === "human") return true;
  const getType = value._getType;
  return typeof getType === "function" && getType.call(value) === "human";
}

function decodeUserMessage(value: Record<string, unknown>): string {
  const text = textContent(value.content) ?? "";
  try {
    const parsed = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed.message === "string") return parsed.message;
  } catch {
    // not the wrapped JSON shape; return raw text
  }
  return text;
}
