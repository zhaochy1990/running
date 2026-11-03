/**
 * Post-draw full-sync trigger (#865, epic #862「同步 job 自动启动」).
 *
 * A successful draw means a freshly-bound watch whose owner skipped onboarding
 * on-site; the server starts the ~24-minute full pipeline for them right away
 * (watch_sync 全量 → calibration → compute → ability) instead of waiting for
 * the daily sync job. Contract:
 *
 *   - fail-soft: every failure is logged and swallowed — the draw result is
 *     already committed and must never be affected (the daily sync job is the
 *     backstop);
 *   - 存量用户 guard: users who already have any pipeline run skip the trigger
 *     (no redundant full pipeline for existing athletes);
 *   - idempotent by key `lottery-sync-{activityId}-{userId}` — Go's
 *     POST /api/{uuid}/sync returns the existing run (200) on a repeat key.
 *
 * Same X-Internal-Token dependency shape as activityFeelWriter / GoJobClient.
 */
import { getLogger } from "@stride/common";
import type { ApiConfig } from "../dto/config.js";

const logger = getLogger("coachApi:lotterySync");

const REQUEST_TIMEOUT_MS = 10_000;

/** Fail-soft by contract: resolves (never throws) whatever the Go API answers. */
export interface LotterySyncTrigger {
  triggerFullSyncIfNewUser(activityId: number, userId: string): Promise<void>;
}

export function createLotterySyncTrigger(goApi: ApiConfig["goApi"], fetchImpl: typeof fetch = fetch): LotterySyncTrigger {
  return {
    async triggerFullSyncIfNewUser(activityId, userId) {
      try {
        // Guard first: an existing pipeline run marks a stock user — skip.
        const guard = await fetchImpl(`${goApi.baseUrl}/api/users/${encodeURIComponent(userId)}/pipelines`, {
          headers: { "x-internal-token": goApi.internalToken },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!guard.ok) {
          logger.warn({ userId, activityId, status: guard.status }, "lottery sync guard lookup failed; sync not triggered");
          return;
        }
        const guardBody = (await guard.json()) as { pipelines?: unknown[] };
        if (Array.isArray(guardBody.pipelines) && guardBody.pipelines.length > 0) {
          logger.info({ userId, activityId, runs: guardBody.pipelines.length }, "lottery sync skipped: user already has pipeline runs");
          return;
        }

        const response = await fetchImpl(`${goApi.baseUrl}/api/${encodeURIComponent(userId)}/sync`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-internal-token": goApi.internalToken,
            "idempotency-key": `lottery-sync-${activityId}-${userId}`,
          },
          body: JSON.stringify({ mode: "full" }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) {
          logger.warn({ userId, activityId, status: response.status }, "lottery full-sync trigger failed; daily sync job is the backstop");
          return;
        }
        // 202 = started, 200 = deduplicated by the idempotency key — both fine.
        logger.info({ userId, activityId, status: response.status }, "lottery full sync triggered after draw");
      } catch (error) {
        logger.warn({ userId, activityId, error: String(error) }, "lottery sync trigger error; draw result unaffected");
      }
    },
  };
}
