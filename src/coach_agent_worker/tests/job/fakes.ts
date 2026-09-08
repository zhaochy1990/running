import type { PlanJob, PlanJobMessage } from "../../src/job/model.js";
import { isTerminal } from "../../src/job/model.js";
import { type ClaimResult, IdempotencyConflictError, type PlanJobStore, type QueuePublisher } from "../../src/job/ports.js";

/** In-memory PlanJobStore test double (mirrors Go's fake store seam). */
export class FakePlanJobStore implements PlanJobStore {
  rows = new Map<string, PlanJob>();
  claims: string[] = [];
  reclaims: string[] = [];
  /** When set, claim/reclaim throw (infra fault). */
  faultClaim = false;

  async create(job: PlanJob): Promise<void> {
    if (job.idempotencyKey !== null) {
      for (const existing of this.rows.values()) {
        if (existing.userId === job.userId && existing.idempotencyKey === job.idempotencyKey) {
          throw new IdempotencyConflictError(existing.jobId);
        }
      }
    }
    this.rows.set(job.jobId, structuredClone(job));
  }

  async get(jobId: string): Promise<PlanJob | null> {
    const row = this.rows.get(jobId);
    return row ? structuredClone(row) : null;
  }

  async update(job: PlanJob): Promise<void> {
    this.rows.set(job.jobId, structuredClone(job));
  }

  async claim(jobId: string, now: Date): Promise<ClaimResult> {
    if (this.faultClaim) throw new Error("store unavailable");
    this.claims.push(jobId);
    const row = this.rows.get(jobId);
    if (!row || row.status !== "queued") return { claimed: false };
    row.status = "running";
    row.attempts += 1;
    row.heartbeatAt = now;
    row.updatedAt = now;
    this.rows.set(jobId, structuredClone(row));
    return { claimed: true, job: structuredClone(row) };
  }

  async reclaimRunning(jobId: string, now: Date, maxAttempts: number): Promise<ClaimResult> {
    if (this.faultClaim) throw new Error("store unavailable");
    this.reclaims.push(jobId);
    const row = this.rows.get(jobId);
    if (!row || row.status !== "running" || row.attempts >= maxAttempts) {
      return { claimed: false };
    }
    row.attempts += 1;
    row.heartbeatAt = now;
    row.updatedAt = now;
    this.rows.set(jobId, structuredClone(row));
    return { claimed: true, job: structuredClone(row) };
  }

  async failStaleRunning(olderThan: Date, now: Date, errorCode: string): Promise<number> {
    let failed = 0;
    for (const row of this.rows.values()) {
      if (row.status === "running" && row.heartbeatAt !== null && row.heartbeatAt.getTime() < olderThan.getTime()) {
        row.status = "failed";
        row.errorCode = errorCode;
        row.errorMessage = `no heartbeat since ${row.heartbeatAt.toISOString()}`;
        row.completedAt = now;
        row.updatedAt = now;
        this.rows.set(row.jobId, structuredClone(row));
        failed += 1;
      }
    }
    return failed;
  }

  static fixture(overrides: Partial<PlanJob> = {}): PlanJob {
    const base: PlanJob = {
      jobId: "job-1",
      userId: "user-1",
      jobType: "generate_master_plan",
      status: "queued",
      attempts: 0,
      stage: "",
      progressPct: 0,
      inputJson: "{}",
      resultJson: null,
      errorCode: null,
      errorMessage: null,
      idempotencyKey: null,
      heartbeatAt: null,
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      updatedAt: new Date("2026-09-01T00:00:00.000Z"),
      completedAt: null,
    };
    return { ...base, ...overrides };
  }
}

/** Records every publish for assertions; `failPublish` simulates a broker outage. */
export class FakePublisher implements QueuePublisher {
  work: PlanJobMessage[] = [];
  retries: Array<{ message: PlanJobMessage; delayMs: number }> = [];
  poisons: PlanJobMessage[] = [];
  failPublish = false;

  async publishWork(message: PlanJobMessage): Promise<void> {
    if (this.failPublish) throw new Error("broker unavailable");
    this.work.push(structuredClone(message));
  }

  async publishRetry(message: PlanJobMessage, delayMs: number): Promise<void> {
    if (this.failPublish) throw new Error("broker unavailable");
    this.retries.push({ message: structuredClone(message), delayMs });
  }

  async publishPoison(message: PlanJobMessage): Promise<void> {
    if (this.failPublish) throw new Error("broker unavailable");
    this.poisons.push(structuredClone(message));
  }
}

export function isDone(row: PlanJob): boolean {
  return isTerminal(row.status);
}
