import { getLogger } from "@stride/common";
import { shanghaiDay } from "@stride/contract";
import { CoachTurnScope, Command } from "coach_agent";
import type { Hono } from "hono";
import type { CoachInvoker } from "../coach/coachInvoker.js";
import type { AuthEnv } from "../auth.js";
import type { ChatRequest } from "../dto/chat.js";
import { toPublicResponse } from "../publicResponse.js";
import type { TurnCoordinator } from "../turn/coordinator.js";
import { ThreadBusyError, TurnConflictError } from "../turn/errors.js";

const logger = getLogger("routes/chat");
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function registerChatRoutes(
  app: Hono<AuthEnv>,
  dependencies: {
    coach: CoachInvoker;
    turnCoordinator: TurnCoordinator;
  },
): void {
  app.post("/api/users/me/coach/chat", async (context) => {
    const userId = context.get("userId");
    const body = await readChatRequest(context.req.raw);
    logger.info(body, `chat request from user ${userId}`);

    if (!body.ok) return context.json({ error: body.error }, 400);
    const threadId = `${userId}:coach:${body.value.sessionId}`;
    try {
      const fingerprint = dependencies.turnCoordinator.getFingerprint(body.value);
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
              userId,
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
      return context.json({ ...response, session_id: body.value.sessionId, client_turn_id: body.value.clientTurnId });
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
