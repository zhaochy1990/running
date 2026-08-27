import { getLogger } from "@stride/common";
import type { MiddlewareHandler } from "hono";
import { verify } from "hono/jwt";

const logger = getLogger("auth");

export interface JwtVerifier {
  verify(authorization: string | undefined): Promise<{ userId: string }>;
}

export class AuthError extends Error {}

/** Context variables available to routes behind the auth middleware. */
export type AuthEnv = {
  Variables: {
    userId: string;
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

export function createJwtVerifier(options: { publicKeyPem: string; issuer: string; audience?: string | string[] }): JwtVerifier {
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
        return { userId: payload.sub };
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

function bearerToken(authorization: string | undefined): string {
  if (!authorization?.toLowerCase().startsWith("bearer ")) {
    throw new AuthError("missing bearer token");
  }
  const token = authorization.slice(7).trim();
  if (!token) throw new AuthError("missing bearer token");
  return token;
}
