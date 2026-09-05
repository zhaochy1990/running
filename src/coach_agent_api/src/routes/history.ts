import type { CheckpointTuple } from "@stride/coach-agent";
import type { Hono } from "hono";
import type { AuthEnv } from "../auth.js";
import { toPublicHistory } from "../publicResponse.js";

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Narrow checkpointer surface the history route needs; `MySqlSaver` satisfies it. */
export interface ThreadHistoryReader {
  getTuple(config: { configurable: { thread_id: string } }): Promise<CheckpointTuple | undefined>;
}

/**
 * GET /api/users/me/coach/sessions/{session_id}/messages.
 * The client passes only `session_id`; the thread is derived from the JWT as
 * `{sub}:coach:{session_id}` so a client can't reach another user's thread.
 */
export function registerHistoryRoutes(app: Hono<AuthEnv>, dependencies: { checkpointer: ThreadHistoryReader }): void {
  app.get("/api/users/me/coach/sessions/:sessionId/messages", async (context) => {
    const userId = context.get("userId");
    const sessionId = context.req.param("sessionId");
    if (!SESSION_ID_RE.test(sessionId)) {
      return context.json({ error: "invalid_session_id" }, 400);
    }
    const threadId = `${userId}:coach:${sessionId}`;
    const tuple = await dependencies.checkpointer.getTuple({ configurable: { thread_id: threadId } });
    const channelValues = (tuple?.checkpoint?.channel_values ?? {}) as { messages?: unknown[] };
    const messages = channelValues.messages ?? [];
    return context.json({
      session_id: sessionId,
      thread_id: threadId,
      messages: toPublicHistory(messages),
    });
  });
}
