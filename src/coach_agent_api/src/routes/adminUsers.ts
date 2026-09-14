import type { Hono, MiddlewareHandler } from "hono";
import type { AuthEnv } from "../auth.js";
import type { CoachDataDeleter } from "../persistence/deletion.js";

/**
 * Administrator / self account-erasure surface. The stride-api orchestrator
 * calls this with either an administrator's bearer (to delete any user) or the
 * user's own bearer (self-deletion). The guard is therefore "admin or self":
 * a regular user token for another user is rejected.
 */
export function registerAdminUserRoutes(app: Hono<AuthEnv>, dependencies: { deleter: CoachDataDeleter; auth: MiddlewareHandler<AuthEnv> }): void {
  app.delete("/api/admin/users/:user_id/coach-data", dependencies.auth, async (context) => {
    const target = context.req.param("user_id");
    const caller = context.get("userId");
    const isAdmin = context.get("isAdmin");
    if (!isAdmin && caller !== target) {
      return context.json({ error: "forbidden" }, 403);
    }
    if (target.length === 0 || target.length > 128) {
      return context.json({ error: "invalid_user" }, 400);
    }
    const deleted = await dependencies.deleter.deleteForUser(target);
    return context.json({ user_id: target, deleted });
  });
}
