import { timingSafeEqual } from "node:crypto";
import { getLogger } from "@stride/common";
import type { MiddlewareHandler } from "hono";
import { verify } from "hono/jwt";

const logger = getLogger("auth");

export interface JwtIdentity {
  userId: string;
  /**
   * True when the token carries the admin audience AND `role=admin`. Mirrors
   * the Go API's TierAdmin rule (`internal/api/auth.go`) so both services agree
   * on who the admin-dashboard token belongs to.
   */
  isAdmin: boolean;
}

export interface JwtVerifier {
  verify(authorization: string | undefined): Promise<JwtIdentity>;
}

export class AuthError extends Error {}

/** Context variables available to routes behind the auth middleware. */
export type AuthEnv = {
  Variables: {
    userId: string;
    isAdmin: boolean;
    /** Set by the requestId middleware in app.ts; correlates request logs. */
    requestId: string;
  };
};

/**
 * Hono middleware that verifies the bearer token before the handler runs.
 * On success it stores the authenticated `userId` on the context. On failure it
 * responds 401 with `WWW-Authenticate: Bearer` and short-circuits, so the
 * route handler never runs without a valid identity.
 */
export function createAuthMiddleware(jwtVerifier: JwtVerifier): MiddlewareHandler<AuthEnv> {
  return async (context, next) => {
    try {
      const identity = await jwtVerifier.verify(context.req.header("authorization"));
      context.set("userId", identity.userId);
      context.set("isAdmin", identity.isAdmin);
    } catch (error) {
      if (error instanceof AuthError) {
        context.header("WWW-Authenticate", "Bearer");
        return context.json({ error: "unauthorized" }, 401);
      }
      throw error;
    }
    await next();
  };
}

/**
 * Admin-only gate for the cross-user plan-job surface the Admin Dashboard uses.
 * Runs after createAuthMiddleware, so an unauthenticated request is already a
 * 401; anything that is not a verified admin token is a 403.
 */
export function createAdminMiddleware(): MiddlewareHandler<AuthEnv> {
  return async (context, next) => {
    if (!context.get("isAdmin")) {
      return context.json({ error: "forbidden" }, 403);
    }
    await next();
  };
}

/**
 * 入站内部端点鉴权（#858 夜检扫描）：X-Internal-Token 与配置常量比较（镜像 Go
 * ADR 0033 的 x-internal-token 模式；timingSafeEqual 防时序侧信道）。空 token
 * 时不该被挂载（route 注册前判空）；防御性地拒绝一切请求。
 */
export function createInternalTokenMiddleware(internalToken: string): MiddlewareHandler<AuthEnv> {
  return async (context, next) => {
    const provided = context.req.header("x-internal-token") ?? "";
    const expected = internalToken;
    const matches = provided.length === expected.length && timingSafeEqual(Buffer.from(provided, "utf8"), Buffer.from(expected, "utf8"));
    if (!matches) {
      context.header("WWW-Authenticate", "Internal-Token");
      return context.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}

/**
 * Best-effort identity for public endpoints that still want user attribution
 * when a token happens to be present (#867 lottery funnel pings): a valid
 * bearer sets the identity, a missing or invalid one continues anonymously.
 * Unlike createAuthMiddleware this never rejects — the endpoint itself is
 * public; the identity is analytics metadata, not authorization.
 */
export function createOptionalAuthMiddleware(jwtVerifier: JwtVerifier): MiddlewareHandler<AuthEnv> {
  return async (context, next) => {
    const authorization = context.req.header("authorization");
    if (authorization !== undefined) {
      try {
        const identity = await jwtVerifier.verify(authorization);
        context.set("userId", identity.userId);
        context.set("isAdmin", identity.isAdmin);
      } catch (error) {
        if (!(error instanceof AuthError)) throw error;
      }
    }
    await next();
  };
}

export function createJwtVerifier(options: { publicKeyPem: string; issuer: string; audience?: string | string[]; adminAudience?: string }): JwtVerifier {
  return {
    async verify(authorization) {
      const token = bearerToken(authorization);
      try {
        const payload = await verify(token, options.publicKeyPem, {
          alg: "RS256",
          iss: options.issuer,
          ...(options.audience ? { aud: options.audience } : {}),
        });
        if (typeof payload.sub !== "string" || payload.sub.length === 0) {
          throw new AuthError("token is missing sub");
        }
        return { userId: payload.sub, isAdmin: isAdminPayload(payload, options.adminAudience) };
      } catch (error: unknown) {
        logger.info("invalid bearer token: %s", (error as Error).name);
        if (error instanceof AuthError) {
          throw error;
        }
        throw new AuthError("invalid bearer token");
      }
    },
  };
}

/** Mirrors the Go verifier: admin audience without `role=admin` is rejected. */
function isAdminPayload(payload: Record<string, unknown>, adminAudience: string | undefined): boolean {
  if (!adminAudience) return false;
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(adminAudience)) return false;
  if (payload.role !== "admin") {
    throw new AuthError("admin audience requires admin role");
  }
  return true;
}

/**
 * Fetch the Auth service's RS256 public key (PEM, PKIX) at startup. The key is
 * published at `/api/system/public-key` so any service can verify JWTs without
 * sharing a file or secret.
 */
export async function fetchAuthPublicKey(authServiceUrl: string): Promise<string> {
  const url = new URL("/api/system/public-key", authServiceUrl).toString();
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`auth-service public key fetch failed (${response.status})`);
  }
  const body = (await response.json()) as { publickey?: string };
  const key = body.publickey;
  if (!key?.startsWith("-----BEGIN")) {
    throw new Error("auth-service returned an unexpected public-key payload");
  }
  return key;
}

function bearerToken(authorization: string | undefined): string {
  if (!authorization?.toLowerCase().startsWith("bearer ")) {
    throw new AuthError("missing bearer token");
  }
  const token = authorization.slice(7).trim();
  if (!token) throw new AuthError("missing bearer token");
  return token;
}
