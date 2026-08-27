import type { Hono } from "hono";

export function registerHealthRoutes(app: Hono): void {
  app.get("/health", (context) => context.json({ status: "ok" }));
}
