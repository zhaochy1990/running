import type { Hono, MiddlewareHandler } from "hono";
import type { AuthEnv } from "../auth.js";
import type { RollingScanRunner } from "../coach/rollingScan.js";

/**
 * #858 PR-C 下半——夜检扫描内部端点：`POST /api/internal/coach/rolling-scan`。
 * X-Internal-Token 鉴权（照 Go ADR 0033 内部端点模式；token 未配置时整个端点
 * 不挂载）。daily-sync workflow 在用户数据同步完成后触发；响应带每用户判定
 * 摘要，便于夜检值班排查。body 可选 `as_of`（ISO instant）——缺省=现在，
 * 供补扫/排查回放指定时点。
 */
export function registerRollingScanRoutes(app: Hono<AuthEnv>, dependencies: { scan: RollingScanRunner; internalAuth: MiddlewareHandler<AuthEnv> }): void {
  app.post("/api/internal/coach/rolling-scan", dependencies.internalAuth, async (context) => {
    let asOf: string | undefined;
    try {
      const body = (await context.req.json()) as { as_of?: unknown };
      if (body.as_of !== undefined) {
        if (typeof body.as_of !== "string" || Number.isNaN(Date.parse(body.as_of))) {
          return context.json({ error: "invalid_as_of" }, 400);
        }
        asOf = body.as_of;
      }
    } catch {
      // 空 body 合法（缺省=现在）
    }
    const summary = await dependencies.scan.runRollingScan({ dispatch: true, ...(asOf !== undefined ? { asOf } : {}) });
    return context.json(summary, 200);
  });
}
