import { getLogger } from "@stride/common";
import { ERROR_CODES } from "../job/errors.js";
import type { PlanJobStore } from "../job/ports.js";

const logger = getLogger("plan-job/reconcile");

/** Anything with a health probe (structurally satisfied by queue + publisher). */
interface Healthy {
  isHealthy(): boolean;
}

export interface ReconcileDeps {
  store: PlanJobStore;
  queue: Healthy;
  publisher: Healthy;
  staleRunningMs: number;
  reconcileIntervalMs: number;
}

/**
 * Reconcile backstop + worker heartbeat: periodically fail running plan-jobs
 * whose heartbeat is stale, and log broker health. Extracted from `main.ts` so
 * the entry point stays thin orchestration.
 */
export function startReconcileTimer(deps: ReconcileDeps): NodeJS.Timeout {
  const timer = setInterval(() => {
    const now = new Date();
    void deps.store
      .failStaleRunning(new Date(now.getTime() - deps.staleRunningMs), now, ERROR_CODES.HEARTBEAT_TIMEOUT)
      .then((failed) => {
        if (failed > 0) logger.warn({ failed }, "reconciled stale running plan-jobs to failed");
        logger.info({ queueHealthy: deps.queue.isHealthy(), publisherHealthy: deps.publisher.isHealthy() }, "plan-job worker heartbeat");
      })
      .catch((error: unknown) => logger.error({ error }, "plan-job reconcile/heartbeat failed"));
  }, deps.reconcileIntervalMs);
  return timer;
}
