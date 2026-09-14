import type { JobTransition, PlanJob, PlanJobMessage } from "../../src/job/model.js";
import { isTerminal } from "../../src/job/model.js";
import { JobStateChangedError, type PlanJobStore, type QueuePublisher } from "../../src/job/ports.js";

/** In-memory PlanJobStore test double (mirrors Go's compare-and-set semantics). */
export class FakePlanJobStore implements PlanJobStore {
  rows = new Map<string, PlanJob>();
  /** Every transition applied, in order — assertions read guards from here. */
  transitions: Array<{ jobId: string; change: JobTransition }> = [];
  /** When set, transitions throw (infra fault). */
  faultClaim = false;

  async create(job: PlanJob): Promise<{ jobId: string; created: boolean }> {
    if (job.idempotencyKey !== null) {
      for (const existing of this.rows.values()) {
        if (existing.userId === job.userId && existing.idempotencyKey === job.idempotencyKey) {
          return { jobId: existing.jobId, created: false };
        }
      }
    }
    this.rows.set(job.jobId, structuredClone(job));
    return { jobId: job.jobId, created: true };
  }

  async get(jobId: string): Promise<PlanJob | null> {
    const row = this.rows.get(jobId);
    return row ? structuredClone(row) : null;
  }

  async transition(jobId: string, change: JobTransition): Promise<PlanJob> {
    if (this.faultClaim) throw new Error("store unavailable");
    this.transitions.push({ jobId, change: structuredClone(change) });
    const row = this.rows.get(jobId);
    if (!row) throw new JobStateChangedError(jobId);
    if (change.from !== undefined && row.status !== change.from) throw new JobStateChangedError(jobId);
    if (change.attemptsLt !== undefined && row.attempts >= change.attemptsLt) throw new JobStateChangedError(jobId);

    row.status = change.to;
    if (change.attemptsDelta !== undefined) row.attempts += change.attemptsDelta;
    if (change.clearError === true) {
      row.errorCode = null;
      row.errorMessage = null;
    }
    if (change.stage !== undefined) row.stage = change.stage;
    if (change.progressPct !== undefined) row.progressPct = change.progressPct;
    if (change.errorCode !== undefined && change.clearError !== true) row.errorCode = change.errorCode;
    if (change.errorMessage !== undefined && change.clearError !== true) row.errorMessage = change.errorMessage;
    if (change.resultJson !== undefined) row.resultJson = change.resultJson;
    if (change.heartbeatAt !== undefined) row.heartbeatAt = change.heartbeatAt;
    row.updatedAt = change.heartbeatAt ?? new Date("2026-09-01T00:00:01.000Z");
    if (isTerminal(change.to)) row.completedAt = change.completedAt ?? row.updatedAt;

    this.rows.set(jobId, structuredClone(row));
    return structuredClone(row);
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
