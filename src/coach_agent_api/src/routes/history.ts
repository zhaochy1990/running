import type { CheckpointTuple } from "@stride/coach-agent";
import type { Hono } from "hono";
import type { AuthEnv } from "../auth.js";
import { toPublicHistory } from "../publicResponse.js";

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Narrow checkpointer surface the history route needs; `MySqlSaver` satisfies it. */
export interface ThreadHistoryReader {
  getTuple(config: { configurable: { thread_id: string } }): Promise<CheckpointTuple | undefined>;
}

/** Narrow checkpointer surface the sessions-list route needs; `MySqlSaver` satisfies it. */
export interface ThreadSessionReader {
  listThreadsForUser(userId: string): Promise<{ sessionId: string; updatedAt: string | null; preview: string }[]>;
}

/**
 * GET /api/users/me/coach/sessions.
 * Lists the caller's coach threads (one entry per session) newest first. This is
 * the source for a chat-history drawer; the client passes the returned
 * `session_id` to the per-session messages route.
 */
export function registerSessionListRoutes(
  app: Hono<AuthEnv>,
  dependencies: { checkpointer: ThreadSessionReader },
): void {
  app.get("/api/users/me/coach/sessions", async (context) => {
    const userId = context.get("userId");
    const threads = await dependencies.checkpointer.listThreadsForUser(userId);
    return context.json({
      sessions: threads.map((thread) => ({
        session_id: thread.sessionId,
        updated_at: thread.updatedAt,
        preview: thread.preview,
      })),
    });
  });
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
