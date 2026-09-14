import type { JobTransition, PlanJob, PlanJobMessage } from "./model.js";

/**
 * Durable plan-job state. Implemented by `goClient/jobClient.ts`, which reports
 * every change to the Go API — Go owns the `jobs` table and is its single
 * writer (ADR 0006/0033), so this port has no SQL of its own.
 */
export interface PlanJobStore {
  /**
   * Persist a queued job row without publishing. Idempotent on
   * (userId, idempotencyKey): a replayed key returns the existing row with
   * `created: false`, and the caller must not publish a second pointer.
   */
  create(job: PlanJob): Promise<{ jobId: string; created: boolean }>;
  get(jobId: string): Promise<PlanJob | null>;
  /**
   * Apply a compare-and-set state change and return the updated row. Throws
   * `JobStateChangedError` when a guard (`from` / `attemptsLt`) fails — the
   * caller lost the race and must not treat its write as applied.
   */
  transition(jobId: string, change: JobTransition): Promise<PlanJob>;
  /**
   * Reconcile backstop: fail running jobs whose heartbeat is older than
   * `olderThan`, tagged with `errorCode`. Only jobs that have stamped a
   * heartbeat are eligible — Go's pipeline step jobs share the table and never
   * stamp one, so this must not reach them. Returns how many were failed.
   */
  failStaleRunning(olderThan: Date, now: Date, errorCode: string): Promise<number>;
}

/**
 * Raised by `transition` when a guard failed: the row is no longer in the state
 * the caller expected (another delivery claimed it, or a reconcile retired it).
 */
export class JobStateChangedError extends Error {
  constructor(readonly jobId: string) {
    super(`conflict: plan-job state changed under us (${jobId})`);
    this.name = "JobStateChangedError";
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
