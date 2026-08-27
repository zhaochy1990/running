import { Hono } from "hono";
import type { JwtVerifier } from "./auth.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerSwaggerRoutes } from "./routes/swagger.js";
import { createInMemoryTurnCoordinator, type TurnCoordinator } from "./turns.js";
import { logger } from "hono/logger";

export interface CoachInvoker {
  invoke(input: unknown, config: Record<string, unknown>): Promise<unknown>;
}

export interface AppDependencies {
  jwtVerifier: JwtVerifier;
  coach: CoachInvoker;
  turnCoordinator?: TurnCoordinator;
}

export function createApp(dependencies: AppDependencies): Hono {
  const app = new Hono();
  app.use("*", logger());
  
  const turnCoordinator = dependencies.turnCoordinator ?? createInMemoryTurnCoordinator();

  registerHealthRoutes(app);
  registerSwaggerRoutes(app);
  registerChatRoutes(app, {
    jwtVerifier: dependencies.jwtVerifier,
    coach: dependencies.coach,
    turnCoordinator,
  });

  return app;
}
