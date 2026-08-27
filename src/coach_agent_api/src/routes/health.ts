import type { Env, Hono } from "hono";

export function registerHealthRoutes<E extends Env>(app: Hono<E>): void {
  app.get("/health", (context) => context.json({ status: "ok" }));
}
