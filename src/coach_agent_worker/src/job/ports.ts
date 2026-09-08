import type { PlanJob, PlanJobMessage } from "./model.js";

/** Result of a claim/reclaim: `job` is only present when the claim succeeded. */
export type ClaimResult = { claimed: true; job: PlanJob } | { claimed: false };

/**
 * Durable plan-job state. Implemented by `storage/planJobs.ts` over MySQL;
 * the dispatcher/enqueuer only depend on this port (mirrors Go `job.Store`).
 */
export interface PlanJobStore {
  create(job: PlanJob): Promise<void>;
  get(jobId: string): Promise<PlanJob | null>;
  update(job: PlanJob): Promise<void>;
  /**
   * Atomically transition a queued job to running (attempts + 1) and return
   * false when another delivery already claimed or terminated it.
   */
  claim(jobId: string, now: Date): Promise<ClaimResult>;
  /**
   * Reclaim a running job whose message was redelivered after a crash (or a
   * nacked infra fault): the previous holder is gone, so this pointer takes it
   * over (attempts + 1). CAS-guarded by the attempts budget — `maxAttempts` is
   * the redelivery bound (Spec/ADR 0030 "重投上限 2 次").
   */
  reclaimRunning(jobId: string, now: Date, maxAttempts: number): Promise<ClaimResult>;
  /**
   * Reconcile backstop: fail every running job whose heartbeat is older than
   * `olderThan`, tagged with `errorCode`. Returns how many were failed.
   */
  failStaleRunning(olderThan: Date, now: Date, errorCode: string): Promise<number>;
}

/** Raised by `create` when (user_id, idempotency_key) already exists. */
export class IdempotencyConflictError extends Error {
  readonly jobId: string;
  constructor(jobId: string) {
    super("conflict: duplicate plan-job idempotency key");
    this.name = "IdempotencyConflictError";
    this.jobId = jobId;
  }
}

/** Broker publisher for the three queues (mirrors Go `job.Publisher`). */
export interface QueuePublisher {
  publishWork(message: PlanJobMessage): Promise<void>;
  publishRetry(message: PlanJobMessage, delayMs: number): Promise<void>;
  publishPoison(message: PlanJobMessage): Promise<void>;
}

/**
 * Progress heartbeat a handler reports mid-run. Stage and progress must be
 * monotonic (the poll contract and the frontend card both rely on it).
 * The consumer holds the unacked broker message, so unlike the old Azure
 * design there is no lease to renew — but we stamp `heartbeatAt` so the
 * stale-running reconcile can recover a crashed worker's job.
 */
export type Heartbeat = (stage: string, progressPct: number) => Promise<void>;

/** How many attempts a transient infra error may make before being poisoned. */
export interface RetryPolicy {
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}
