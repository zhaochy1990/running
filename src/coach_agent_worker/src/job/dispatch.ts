import { getLogger } from "@stride/common";
import { asPermanent, ERROR_CODES, type Handler, type HandlerResult } from "./errors.js";
import type { PlanJob, PlanJobMessage } from "./model.js";
import { isTerminal } from "./model.js";
import type { Heartbeat, PlanJobStore, QueuePublisher, RetryPolicy } from "./ports.js";
import { decideFailure } from "./retry.js";

const logger = getLogger("plan-job/dispatch");

/**
 * Dispatcher processes one pointer message end to end: load the job, run its
 * handler, and drive the terminal/retry/poison transition (mirrors Go's
 * `job.Dispatcher`). It owns no transport loop — a Consumer feeds it messages
 * and acks after `dispatch` resolves. A rejected promise is an infrastructure
 * fault the consumer must nack with requeue (redelivery for when it clears).
 */
export class PlanJobDispatcher {
  constructor(
    private readonly store: PlanJobStore,
    private readonly registry: Map<string, Handler>,
    private readonly publisher: QueuePublisher,
    private readonly policy: RetryPolicy,
    private readonly options: {
      now: () => Date;
    },
  ) {}

  /** Handle one message. Resolves (ack) when handled; rejects (nack/requeue) on infra fault. */
  async dispatch(message: PlanJobMessage): Promise<void> {
    const job = await this.store.get(message.jobId);
    if (job === null) {
      // Orphan pointer (row never written / already cleaned): drop it.
      logger.warn({ jobId: message.jobId }, "dropping orphan plan-job message");
      return;
    }
    if (isTerminal(job.status)) {
      logger.debug({ jobId: job.jobId, status: job.status }, "job already terminal, dropping duplicate");
      return;
    }

    // A claim is a compare-and-swap in the durable store. Duplicate broker
    // pointers observe terminal state above, lose this claim below, or reclaim
    // a stale-running row (crashed worker) so redelivery never loses a task.
    const claimed = await this.claim(job);
    if (!claimed) return;

    const handler = this.registry.get(job.jobType);
    if (handler === undefined) {
      logger.error({ jobId: job.jobId, jobType: job.jobType }, "no handler for plan-job type");
      await this.finishFailed(job, ERROR_CODES.NO_HANDLER, `no handler registered for job type ${job.jobType}`);
      return;
    }

    logger.info({ jobId: job.jobId, jobType: job.jobType, userId: job.userId, attempt: job.attempts }, "processing plan-job");
    try {
      const result = await handler(job, this.heartbeat(job));
      await this.finishDone(job, result);
    } catch (error) {
      await this.handleFailure(job, message, error);
    }
  }

  private async claim(job: PlanJob): Promise<boolean> {
    const now = this.options.now();
    if (job.status === "running") {
      // Redelivered pointer for a running job: the previous holder released it
      // (crash or a nacked infra fault), so resume it — bounded by the retry
      // budget. An exhausted job is left to the stale-running reconcile to fail.
      if (job.attempts >= this.policy.maxAttempts) {
        logger.warn({ jobId: job.jobId, attempts: job.attempts }, "dropping redelivered pointer beyond the attempts budget");
        return false;
      }
      const reclaim = await this.store.reclaimRunning(job.jobId, now, this.policy.maxAttempts);
      if (!reclaim.claimed) return false;
      Object.assign(job, reclaim.job);
      logger.warn({ jobId: job.jobId, attempt: job.attempts }, "reclaimed running plan-job after redelivery (worker crash)");
      return true;
    }
    const claim = await this.store.claim(job.jobId, now);
    if (!claim.claimed) return false;
    Object.assign(job, claim.job);
    return true;
  }

  /** Enforces the monotonic stage/progress contract (poll + card depend on it). */
  private heartbeat(job: PlanJob): Heartbeat {
    let lastPct = job.progressPct;
    return async (stage, progressPct) => {
      if (progressPct < lastPct) {
        logger.debug({ jobId: job.jobId, stage, progressPct }, "ignoring regressive progress update");
        return;
      }
      lastPct = progressPct;
      job.stage = stage;
      job.progressPct = progressPct;
      job.heartbeatAt = this.options.now();
      job.updatedAt = this.options.now();
      await this.store.update(job);
    };
  }

  private async finishDone(job: PlanJob, result: HandlerResult): Promise<void> {
    const now = this.options.now();
    job.status = "done";
    job.progressPct = 100;
    job.stage = "outputting";
    job.resultJson = result.result;
    job.errorCode = null;
    job.errorMessage = null;
    job.completedAt = now;
    job.updatedAt = now;
    await this.store.update(job);
    logger.info({ jobId: job.jobId, jobType: job.jobType, draftId: result.draftId ?? null }, "plan-job done");
  }

  private async handleFailure(job: PlanJob, message: PlanJobMessage, error: unknown): Promise<void> {
    const permanent = asPermanent(error);
    if (permanent !== null) {
      await this.finishFailed(job, permanent.code, permanent.message);
      return;
    }
    const decision = decideFailure(job.attempts, this.policy.maxAttempts, this.policy.baseBackoffMs, this.policy.maxBackoffMs);
    if (decision.outcome === "retry") {
      job.status = "queued";
      job.errorCode = "retryable";
      job.errorMessage = errorMessage(error);
      job.updatedAt = this.options.now();
      await this.store.update(job);
      await this.publisher.publishRetry(message, decision.delayMs);
      logger.warn({ jobId: job.jobId, attempts: job.attempts, delayMs: decision.delayMs, error: errorMessage(error) }, "plan-job failed, scheduled retry");
      return;
    }
    logger.error({ jobId: job.jobId, attempts: job.attempts, error: errorMessage(error) }, "plan-job poisoned");
    await this.finishFailed(job, "poison", errorMessage(error));
    await this.publisher.publishPoison(message);
  }

  private async finishFailed(job: PlanJob, code: string, message: string): Promise<void> {
    const now = this.options.now();
    job.status = "failed";
    job.errorCode = code;
    job.errorMessage = message;
    job.completedAt = now;
    job.updatedAt = now;
    await this.store.update(job);
    logger.info({ jobId: job.jobId, jobType: job.jobType, errorCode: code }, "plan-job failed");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
