import { randomUUID } from "node:crypto";
import type { PlanJob, PlanJobType } from "./model.js";
import { IdempotencyConflictError, type PlanJobStore, type QueuePublisher } from "./ports.js";

export interface EnqueueSpec {
  jobType: PlanJobType;
  /** JWT sub of the athlete the job belongs to. */
  userId: string;
  /** Serialized kernel request (already server-revalidated by the caller). */
  inputJson: string;
  /** Dedupes client-driven enqueue: at most one job per (userId, key). */
  idempotencyKey?: string;
}

export interface EnqueueResult {
  jobId: string;
  estimatedDurationSeconds: number;
}

/**
 * Store-first enqueuer: the job row is durably `queued` before the pointer is
 * published (mirrors Go `store.Enqueuer`). A failed publish fail-closes the
 * row to `failed` so an ambiguous broker delivery can never execute it later.
 */
export class PlanJobEnqueuer {
  constructor(
    private readonly store: PlanJobStore,
    private readonly publisher: QueuePublisher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async enqueue(spec: EnqueueSpec, estimatedDurationSeconds: number): Promise<EnqueueResult> {
    const now = this.now();
    const jobId = randomUUID();
    const job: PlanJob = {
      jobId,
      userId: spec.userId,
      jobType: spec.jobType,
      status: "queued",
      attempts: 0,
      stage: "",
      progressPct: 0,
      inputJson: spec.inputJson,
      resultJson: null,
      errorCode: null,
      errorMessage: null,
      idempotencyKey: spec.idempotencyKey ?? null,
      heartbeatAt: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    try {
      await this.store.create(job);
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return { jobId: error.jobId, estimatedDurationSeconds };
      }
      throw error;
    }
    try {
      await this.publisher.publishWork({ jobId, userId: spec.userId });
    } catch (error) {
      await this.failClosed(job, error);
    }
    return { jobId, estimatedDurationSeconds };
  }

  /** Publish failure: durably mark the row failed so the pointer cannot execute. */
  private async failClosed(job: PlanJob, publishError: unknown): Promise<void> {
    const now = this.now();
    job.status = "failed";
    job.errorCode = "publish_failed";
    job.errorMessage = publishError instanceof Error ? publishError.message : String(publishError);
    job.completedAt = now;
    job.updatedAt = now;
    try {
      await this.store.update(job);
    } catch (updateError) {
      throw new Error(
        `job publish failure could not be durably closed: ${publishError instanceof Error ? publishError.message : String(publishError)}; ${updateError instanceof Error ? updateError.message : String(updateError)}`,
      );
    }
    throw new Error(`plan-job publish failed: ${job.jobId}`);
  }
}
