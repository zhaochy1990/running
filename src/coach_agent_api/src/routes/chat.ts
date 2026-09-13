import { CoachTurnScope, Command } from "@stride/coach-agent";
import { getLogger } from "@stride/common";
import { shanghaiDay, shanghaiIso } from "@stride/contract";
import type { Hono } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import type { AuthEnv } from "../auth.js";
import type { CoachInvoker } from "../coach/coachInvoker.js";
import type { ChatRequest } from "../dto/chat.js";
import type { TurnRequest } from "../dto/turn.js";
import { toPublicResponse } from "../publicResponse.js";
import type { TurnCoordinator } from "../turn/coordinator.js";
import { ThreadBusyError, TurnConflictError } from "../turn/errors.js";
import { type CoachStreamEmitter, collectCoachStream } from "./stream.js";

const logger = getLogger("routes/chat");
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

interface ChatDependencies {
  coach: CoachInvoker;
  turnCoordinator: TurnCoordinator;
}

export function registerChatRoutes(app: Hono<AuthEnv>, dependencies: ChatDependencies): void {
  app.post("/api/users/me/coach/chat", async (context) => {
    const userId = context.get("userId");
    const body = await readChatRequest(context.req.raw);
    logger.info(body, `chat request from user ${userId}`);

    if (!body.ok) return context.json({ error: body.error }, 400);

    const threadId = `${userId}:coach:${body.value.sessionId}`;
    if (acceptsStream(context.req.raw)) {
      return streamSSE(context, async (stream) => {
        await streamChat(dependencies, stream, body.value, userId, threadId);
      });
    }

    try {
      const response = await runTurn(dependencies, body.value, threadId, async (resumeFromCheckpoint, turn) => {
        const input = buildInput(body.value, resumeFromCheckpoint);
        const config = buildConfig(body.value, userId, threadId, turn.fingerprint);
        const result = await dependencies.coach.invoke(input, config);
        return toPublicResponse(result);
      });
      return context.json({ ...response, session_id: body.value.sessionId, client_turn_id: body.value.clientTurnId });
    } catch (error) {
      const { kind } = classifyTurnError(error);
      if (kind === "client_turn_id_conflict") {
        return context.json({ error: kind }, 409);
      }
      if (kind === "coach_thread_busy") {
        context.header("Retry-After", "5");
        return context.json({ error: kind }, 429);
      }
      throw error;
    }
  });
}

function acceptsStream(request: Request): boolean {
  return request.headers.get("accept")?.toLowerCase().includes("text/event-stream") ?? false;
}

/**
 * Run one turn under the per-thread lock with the given invocation. Shared by
 * the sync and streaming paths so both keep identical lock / idempotency /
 * receipt semantics from the turn coordinator.
 */
async function runTurn(
  dependencies: ChatDependencies,
  body: ChatRequest,
  threadId: string,
  work: (resumeFromCheckpoint: boolean, turn: TurnRequest) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const turn: TurnRequest = {
    threadId,
    clientTurnId: body.clientTurnId,
    fingerprint: dependencies.turnCoordinator.getFingerprint(body),
  };
  return dependencies.turnCoordinator.run(turn, (resumeFromCheckpoint) => work(resumeFromCheckpoint, turn));
}

/** SSE variant: emit status events during the run, then a single `done` event. */
async function streamChat(dependencies: ChatDependencies, stream: SSEStreamingApi, body: ChatRequest, userId: string, threadId: string): Promise<void> {
  const turnId = body.clientTurnId;
  const emit = async (event: "status" | "text_delta" | "done" | "error", data: Record<string, unknown>) => {
    await stream.writeSSE({ event, data: JSON.stringify(data) });
  };
  // Map each adapter event to its SSE wire form; every event carries the
  // client turn id so the front end can correlate retries.
  const emitStreamEvent: CoachStreamEmitter = (streamEvent) => {
    if (streamEvent.kind === "text_delta") {
      return emit("text_delta", { turn_id: turnId, delta: streamEvent.delta });
    }
    const { phase, tool, toolStatus } = streamEvent;
    return emit("status", {
      turn_id: turnId,
      phase,
      ...(tool !== undefined ? { tool } : {}),
      ...(toolStatus !== undefined ? { tool_status: toolStatus } : {}),
    });
  };

  try {
    const response = await runTurn(dependencies, body, threadId, async (resumeFromCheckpoint, turn) => {
      const input = buildInput(body, resumeFromCheckpoint);
      const config = buildConfig(body, userId, threadId, turn.fingerprint);
      const run = await dependencies.coach.streamEvents(input, config);
      return await collectCoachStream(run, emitStreamEvent);
    });
    await emit("done", { turn_id: turnId, ...response });
  } catch (error) {
    const { kind, message } = classifyTurnError(error);
    logger.error({ error, threadId }, "coach streaming turn failed");
    await emit("error", { turn_id: turnId, code: kind, message });
  }
}

/** Same turn input for the sync and streaming invocations (shared lock/idempotency semantics). */
function buildInput(body: ChatRequest, resumeFromCheckpoint: boolean): unknown {
  if (resumeFromCheckpoint) return null;
  if (body.resume !== undefined) return new Command({ resume: body.resume });
  return {
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          timestamp: body.timestamp ?? shanghaiIso(),
          message: body.message as string,
        }),
      },
    ],
  };
}

function buildConfig(body: ChatRequest, userId: string, threadId: string, fingerprint: string): Record<string, unknown> {
  return {
    context: {
      userId,
      asof: shanghaiDay(new Date().toISOString()),
      ...(body.target ? { target: body.target } : {}),
      ...(body.reviewContext ? { reviewContext: body.reviewContext } : {}),
    },
    configurable: {
      thread_id: threadId,
      client_turn_id: body.clientTurnId,
    },
    metadata: {
      client_turn_id: body.clientTurnId,
      turn_fingerprint: fingerprint,
    },
  };
}

/** The two public failure surfaces share one classification of turn errors. */
function classifyTurnError(error: unknown): { kind: string; message: string } {
  if (error instanceof TurnConflictError) return { kind: "client_turn_id_conflict", message: error.message };
  if (error instanceof ThreadBusyError) return { kind: "coach_thread_busy", message: error.message };
  return { kind: "coach_turn_failed", message: error instanceof Error ? error.message : "coach turn failed" };
}

async function readChatRequest(request: Request): Promise<{ ok: true; value: ChatRequest } | { ok: false; error: string }> {
  let value: unknown;
  try {
    value = await request.json();
  } catch (e) {
    logger.info("invalid json in request body, error: %s", (e as Error).name);
    return { ok: false, error: "invalid_json" };
  }

  if (!isRecord(value)) return { ok: false, error: "invalid_request" };

  const sessionId = value.session_id;
  const clientTurnId = value.client_turn_id;
  const message = value.message;
  const timestamp = value.timestamp;
  const resume = value.resume;
  const scope = CoachTurnScope.safeParse({
    target: value.target,
    reviewContext: value.review_context,
  });
  if (typeof sessionId !== "string" || !ID_RE.test(sessionId)) return { ok: false, error: "invalid_session_id" };
  if (typeof clientTurnId !== "string" || !ID_RE.test(clientTurnId)) return { ok: false, error: "invalid_client_turn_id" };
  if (message !== undefined && (typeof message !== "string" || message.trim().length === 0 || message.length > 20_000))
    return { ok: false, error: "invalid_message" };
  if (timestamp !== undefined && (typeof timestamp !== "string" || !ISO_TIMESTAMP_RE.test(timestamp) || Number.isNaN(new Date(timestamp).valueOf())))
    return { ok: false, error: "invalid_timestamp" };
  if (resume !== undefined && !isValidResume(resume)) return { ok: false, error: "invalid_resume" };
  if ((message === undefined) === (resume === undefined)) {
    return { ok: false, error: "message_or_resume_required" };
  }
  if (!scope.success) return { ok: false, error: "invalid_turn_scope" };
  return {
    ok: true,
    value: {
      sessionId,
      clientTurnId,
      ...(typeof message === "string" ? { message } : {}),
      ...(typeof timestamp === "string" ? { timestamp } : {}),
      ...(resume !== undefined ? { resume } : {}),
      ...(scope.data.target ? { target: scope.data.target } : {}),
      ...(scope.data.reviewContext ? { reviewContext: scope.data.reviewContext } : {}),
    },
  };
}

function isValidResume(value: unknown): value is string | string[] {
  if (typeof value === "string") return value.trim().length > 0 && value.length <= 20_000;
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 50 &&
    value.every((answer) => typeof answer === "string" && answer.trim().length > 0 && answer.length <= 2_000) &&
    value.reduce((length, answer) => length + answer.length, 0) <= 20_000
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
