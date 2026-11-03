/**
 * Staff-openid resolution for the #866 lottery verify domain.
 *
 * The verify endpoints authorize on the mini-program openid whitelist
 * (`lottery_staff`), but the coach JWT carries only the user id and the
 * mini-program itself never learns its openid (code2session is server-side,
 * in the auth service). So the verify page passes a fresh `wx.login()` code
 * and this client resolves it to the requester's openid through an
 * auth-service internal endpoint (X-Internal-Token, same dependency shape as
 * the wxacode client). The endpoint URL is fully configurable so wiring a new
 * auth-service route is a config change, not a re-release.
 *
 * Contract: resolve never throws — `{ status: "unavailable" }` means
 * unconfigured, unreachable or an unusable answer, and the routes translate
 * that to a 503 (the verify domain is disabled rather than leaking access).
 */
import { getLogger } from "@stride/common";

const logger = getLogger("coachApi:lotteryOpenid");

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_OPENID_CHARS = 128;

export type OpenidResolution = { status: "ok"; openid: string } | { status: "unavailable" };

export interface LotteryOpenidResolver {
  resolve(wxCode: string): Promise<OpenidResolution>;
}

export function createAuthOpenidResolver(options: { endpoint: string; internalToken: string }, fetchImpl: typeof fetch = fetch): LotteryOpenidResolver {
  return {
    async resolve(wxCode) {
      try {
        const response = await fetchImpl(options.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", "X-Internal-Token": options.internalToken },
          body: JSON.stringify({ code: wxCode }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) {
          logger.warn({ status: response.status }, "staff openid endpoint returned an error");
          return { status: "unavailable" };
        }
        const body = (await response.json()) as { openid?: unknown };
        if (typeof body.openid !== "string" || body.openid.length === 0 || body.openid.length > MAX_OPENID_CHARS) {
          logger.warn({ status: response.status }, "staff openid endpoint returned no usable openid");
          return { status: "unavailable" };
        }
        return { status: "ok", openid: body.openid };
      } catch (error) {
        logger.warn({ error: String(error) }, "staff openid resolution failed");
        return { status: "unavailable" };
      }
    },
  };
}
