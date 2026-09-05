import { Hono } from "hono";
import { logger } from "hono/logger";
import { requestId } from "hono/request-id";
import { type AuthEnv, createAuthMiddleware, type JwtVerifier } from "./auth.js";
import type { CoachInvoker } from "./coach/coachInvoker.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerHistoryRoutes, type ThreadHistoryReader } from "./routes/history.js";
import { registerSwaggerRoutes } from "./routes/swagger.js";
import type { TurnCoordinator } from "./turn/coordinator.js";
import { createInMemoryTurnCoordinator } from "./turn/index.js";

export interface AppDependencies {
  jwtVerifier: JwtVerifier;
  coachInvoker: CoachInvoker;
  turnCoordinator?: TurnCoordinator;
  /** When provided, exposes per-session conversation history (GET .../sessions/{id}/messages). */
  checkpointer?: ThreadHistoryReader;
}

export function createApp(dependencies: AppDependencies): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("*", logger());
  app.use("*", requestId());

  const turnCoordinator = dependencies.turnCoordinator ?? createInMemoryTurnCoordinator();

  registerHealthRoutes(app);
  registerSwaggerRoutes(app);

  app.use("/api/users/me/coach/chat", createAuthMiddleware(dependencies.jwtVerifier));

  registerChatRoutes(app, {
    coach: dependencies.coachInvoker,
    turnCoordinator,
  });

  if (dependencies.checkpointer) {
    app.use("/api/users/me/coach/sessions/*", createAuthMiddleware(dependencies.jwtVerifier));
    registerHistoryRoutes(app, { checkpointer: dependencies.checkpointer });
  }

  return app;
}
