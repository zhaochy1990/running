import { shanghaiDay } from "@stride/contract";
import { CoachTurnScope, Command } from "coach_agent";
import type { Hono } from "hono";
import type { CoachInvoker } from "../app.js";
import type { JwtVerifier } from "../auth.js";
import { AuthError } from "../auth.js";
import { toPublicResponse } from "../publicResponse.js";
import { fingerprintTurn, ThreadBusyError, TurnConflictError, type TurnCoordinator } from "../turns.js";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function registerChatRoutes(
  app: Hono,
  dependencies: {
    jwtVerifier: JwtVerifier;
    coach: CoachInvoker;
    turnCoordinator: TurnCoordinator;
  },
): void {
  app.post("/api/users/me/coach/chat", async (context) => {
    let identity: { userId: string };
    try {
      identity = await dependencies.jwtVerifier.verify(context.req.header("authorization"));
    } catch (error) {
      if (error instanceof AuthError) {
        context.header("WWW-Authenticate", "Bearer");
        return context.json({ error: "unauthorized" }, 401);
      }
      throw error;
    }

    const body = await readChatRequest(context.req.raw);
    if (!body.ok) return context.json({ error: body.error }, 400);
    const threadId = `${identity.userId}:coach:${body.value.sessionId}`;
    try {
      const fingerprint = fingerprintTurn(body.value);
      const response = await dependencies.turnCoordinator.run(
        {
          threadId,
          clientTurnId: body.value.clientTurnId,
          fingerprint,
        },
        async (resumeFromCheckpoint) => {
          const input = resumeFromCheckpoint
            ? null
            : body.value.resume === undefined
              ? {
                  messages: [{ role: "user", content: body.value.message as string }],
                }
              : new Command({ resume: body.value.resume });
          const result = await dependencies.coach.invoke(input, {
            context: {
              userId: identity.userId,
              asof: shanghaiDay(new Date().toISOString()),
              ...(body.value.target ? { target: body.value.target } : {}),
              ...(body.value.reviewContext ? { reviewContext: body.value.reviewContext } : {}),
            },
            configurable: {
              thread_id: threadId,
              client_turn_id: body.value.clientTurnId,
            },
            metadata: {
              client_turn_id: body.value.clientTurnId,
              turn_fingerprint: fingerprint,
            },
          });
          return toPublicResponse(result);
        },
      );
      return context.json(response);
    } catch (error) {
      if (error instanceof TurnConflictError) {
        return context.json({ error: "client_turn_id_conflict" }, 409);
      }
      if (error instanceof ThreadBusyError) {
        context.header("Retry-After", "5");
        return context.json({ error: "coach_thread_busy" }, 429);
      }
      throw error;
    }
  });
}

type ChatRequest = {
  sessionId: string;
  clientTurnId: string;
  message?: string;
  resume?: string | string[];
  target?: Record<string, unknown>;
  reviewContext?: Record<string, unknown>;
};
async function readChatRequest(request: Request): Promise<{ ok: true; value: ChatRequest } | { ok: false; error: string }> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  if (!isRecord(value)) return { ok: false, error: "invalid_request" };
  const sessionId = value.session_id;
  const clientTurnId = value.client_turn_id;
  const message = value.message;
  const resume = value.resume;
  const scope = CoachTurnScope.safeParse({
    target: value.target,
    reviewContext: value.review_context,
  });
  if (typeof sessionId !== "string" || !ID_RE.test(sessionId)) return { ok: false, error: "invalid_session_id" };
  if (typeof clientTurnId !== "string" || !ID_RE.test(clientTurnId)) return { ok: false, error: "invalid_client_turn_id" };
  if (message !== undefined && (typeof message !== "string" || message.trim().length === 0 || message.length > 20_000))
    return { ok: false, error: "invalid_message" };
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
