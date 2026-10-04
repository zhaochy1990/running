import { getLogger } from "@stride/common";
import { Hono } from "hono";
import { requestId } from "hono/request-id";
import { type AuthEnv, createAuthMiddleware, type JwtVerifier } from "./auth.js";
import type { CoachInvoker } from "./coach/coachInvoker.js";
import type { CoachDataDeleter } from "./persistence/deletion.js";
import { registerAdminUserRoutes } from "./routes/adminUsers.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerHistoryRoutes, registerSessionListRoutes, type ThreadHistoryReader, type ThreadSessionReader } from "./routes/history.js";
import { type PlanJobsService, registerPlanJobRoutes } from "./routes/planJobs.js";
import { registerSwaggerRoutes } from "./routes/swagger.js";
import type { TurnCoordinator } from "./turn/coordinator.js";
import { createInMemoryTurnCoordinator } from "./turn/index.js";

export interface AppDependencies {
  jwtVerifier: JwtVerifier;
  coachInvoker: CoachInvoker;
  turnCoordinator?: TurnCoordinator;
  /** When provided, exposes per-session conversation history (GET .../sessions/{id}/messages). */
  checkpointer?: ThreadHistoryReader;
  /** When provided, exposes the deterministic plan-job enqueue/poll endpoints. */
  planJobs?: PlanJobsService;
  /** When provided, exposes the admin/self coach-data erasure endpoint. */
  coachDataDeleter?: CoachDataDeleter;
}

const httpLogger = getLogger("http");

export function createApp(dependencies: AppDependencies): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("*", requestId());
  app.use("*", async (c, next) => {
    const startedAt = performance.now();
    const fields = () => ({
      requestId: c.get("requestId"),
      method: c.req.method,
      path: c.req.path,
      durationMs: Math.round(performance.now() - startedAt),
    });
    try {
      await next();
      httpLogger.info({ ...fields(), status: c.res.status }, "request");
    } catch (error) {
      // Hono's onError composes the error response (500 by default) only after
      // this middleware unwinds, so the status is not on c.res yet.
      httpLogger.error({ ...fields(), status: 500 }, "request failed");
      throw error;
    }
  });

  const turnCoordinator = dependencies.turnCoordinator ?? createInMemoryTurnCoordinator();

  registerHealthRoutes(app);
  registerSwaggerRoutes(app);

  app.use("/api/users/me/coach/chat", createAuthMiddleware(dependencies.jwtVerifier));

  registerChatRoutes(app, {
    coach: dependencies.coachInvoker,
    turnCoordinator,
  });

  if (dependencies.planJobs) {
    registerPlanJobRoutes(app, {
      planJobs: dependencies.planJobs,
      auth: createAuthMiddleware(dependencies.jwtVerifier),
    });
  }

  if (dependencies.checkpointer) {
    app.use("/api/users/me/coach/sessions/*", createAuthMiddleware(dependencies.jwtVerifier));
    app.use("/api/users/me/coach/sessions", createAuthMiddleware(dependencies.jwtVerifier));
    registerSessionListRoutes(app, { checkpointer: dependencies.checkpointer as unknown as ThreadSessionReader });
    registerHistoryRoutes(app, { checkpointer: dependencies.checkpointer });
  }

  if (dependencies.coachDataDeleter) {
    registerAdminUserRoutes(app, {
      deleter: dependencies.coachDataDeleter,
      auth: createAuthMiddleware(dependencies.jwtVerifier),
    });
  }

  return app;
}
