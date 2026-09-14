import { randomUUID } from "node:crypto";
import type { PlanJob, PlanJobType } from "./model.js";
import type { PlanJobStore, QueuePublisher } from "./ports.js";

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
    const created = await this.store.create(job);
    if (!created.created) {
      // A repeated idempotency key already has a row and, in the normal case, a
      // pointer in flight or done: publishing again would double-run the kernel.
      return { jobId: created.jobId, estimatedDurationSeconds };
    }
    try {
      await this.publisher.publishWork({ jobId: created.jobId, userId: spec.userId });
    } catch (error) {
      await this.failClosed(created.jobId, error);
    }
    return { jobId: created.jobId, estimatedDurationSeconds };
  }

  /** Publish failure: durably mark the row failed so the pointer cannot execute. */
  private async failClosed(jobId: string, publishError: unknown): Promise<void> {
    const reason = publishError instanceof Error ? publishError.message : String(publishError);
    try {
      await this.store.transition(jobId, { from: "queued", to: "failed", errorCode: "publish_failed", errorMessage: reason });
    } catch (closeError) {
      throw new Error(`job publish failure could not be durably closed: ${reason}; ${closeError instanceof Error ? closeError.message : String(closeError)}`);
    }
    throw new Error(`plan-job publish failed: ${jobId}`);
  }
}
