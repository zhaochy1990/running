import { ERROR_CODES, newPermanentError } from "../job/errors.js";
import type { JobTransition, PlanJob, PlanJobStatus, PlanJobType } from "../job/model.js";
import { JobStateChangedError, type PlanJobStore } from "../job/ports.js";

/** Wire shape of Go's `jobStateResponse` (api/dto.go). */
interface JobRowDto {
  job_id: string;
  user_id?: string;
  job_type: string;
  status: string;
  attempts?: number;
  stage?: string;
  progress_pct?: number;
  input_json?: string;
  result_json?: string;
  error_code?: string;
  error_message?: string;
  idempotency_key?: string;
  heartbeat_at?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

interface CreateJobDto {
  job_id: string;
  created: boolean;
}

/**
 * Plan-job state over the Go internal API (ADR 0033). Go owns the `jobs` table
 * and is its only writer, so the worker never opens a connection to it: it
 * creates the row before publishing the pointer, reports every stage/progress/
 * terminal change as a compare-and-set transition, and asks Go to retire stale
 * running rows. Same dependency class as `GoDraftClient` (X-Internal-Token).
 */
export class GoJobClient implements PlanJobStore {
  constructor(
    private readonly baseUrl: string,
    private readonly internalToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async create(job: PlanJob): Promise<{ jobId: string; created: boolean }> {
    const response = await this.call("POST", "/api/internal/jobs", {
      job_id: job.jobId,
      user_id: job.userId,
      job_type: job.jobType,
      input_json: job.inputJson,
      ...(job.idempotencyKey !== null ? { idempotency_key: job.idempotencyKey } : {}),
    });
    // 201 = created; 200 = a repeated idempotency key resolved to the existing row.
    if (response.status !== 201 && response.status !== 200) {
      throw this.describe("job create", response, await safeText(response));
    }
    const body = (await response.json()) as Partial<CreateJobDto>;
    if (typeof body.job_id !== "string" || body.job_id.length === 0) {
      throw new Error("go job create returned no job_id");
    }
    return { jobId: body.job_id, created: response.status === 201 };
  }

  async get(jobId: string): Promise<PlanJob | null> {
    const response = await this.call("GET", `/api/internal/jobs/${encodeURIComponent(jobId)}`);
    if (response.status === 404) return null;
    if (response.status !== 200) {
      throw this.describe("job get", response, await safeText(response));
    }
    return toDomain((await response.json()) as JobRowDto);
  }

  async transition(jobId: string, change: JobTransition): Promise<PlanJob> {
    const response = await this.call("POST", `/api/internal/jobs/${encodeURIComponent(jobId)}/transition`, toWire(change));
    if (response.status === 409) {
      throw new JobStateChangedError(jobId);
    }
    if (response.status === 404) {
      // The row is gone: nothing can be transitioned, and retrying cannot help.
      throw newPermanentError(ERROR_CODES.JOB_NOT_FOUND, new Error(`go job transition 404: job ${jobId} no longer exists`));
    }
    if (response.status !== 200) {
      throw this.describe("job transition", response, await safeText(response));
    }
    return toDomain((await response.json()) as JobRowDto);
  }

  async failStaleRunning(olderThan: Date, _now: Date, errorCode: string): Promise<number> {
    const response = await this.call("POST", "/api/internal/jobs/stale-running", {
      older_than: olderThan.toISOString(),
      error_code: errorCode,
    });
    if (response.status !== 200) {
      throw this.describe("stale-running reconcile", response, await safeText(response));
    }
    const body = (await response.json()) as { failed?: number };
    return typeof body.failed === "number" ? body.failed : 0;
  }

  private call(method: string, path: string, body?: unknown): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-internal-token": this.internalToken,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  /**
   * A 400/403 is deterministic on the request we built, so re-running the job
   * cannot fix it — permanent. 401 (bad/rotating token) and 5xx are infra that a
   * later attempt or an operator fix can clear, so they stay transient and fall
   * through to the retry policy.
   */
  private describe(action: string, response: Response, detail: string): Error {
    const message = `go ${action} failed (${response.status}): ${detail}`;
    if (response.status === 400 || response.status === 403) {
      return newPermanentError(ERROR_CODES.JOB_STATE_REJECTED, new Error(message));
    }
    return new Error(message);
  }
}

function toWire(change: JobTransition): Record<string, unknown> {
  const wire: Record<string, unknown> = { to: change.to };
  if (change.from !== undefined) wire.from = change.from;
  if (change.attemptsDelta !== undefined) wire.attempts_delta = change.attemptsDelta;
  if (change.attemptsLt !== undefined) wire.attempts_lt = change.attemptsLt;
  if (change.stage !== undefined) wire.stage = change.stage;
  if (change.progressPct !== undefined) wire.progress_pct = change.progressPct;
  if (change.errorCode !== undefined) wire.error_code = change.errorCode;
  if (change.errorMessage !== undefined) wire.error_message = change.errorMessage;
  if (change.clearError === true) wire.clear_error = true;
  if (change.resultJson !== undefined) wire.result_json = change.resultJson;
  if (change.heartbeatAt !== undefined) wire.heartbeat_at = change.heartbeatAt.toISOString();
  if (change.completedAt !== undefined) wire.completed_at = change.completedAt.toISOString();
  return wire;
}

function toDomain(row: JobRowDto): PlanJob {
  return {
    jobId: row.job_id,
    userId: row.user_id ?? "",
    jobType: row.job_type as PlanJobType,
    status: row.status as PlanJobStatus,
    attempts: row.attempts ?? 0,
    stage: row.stage ?? "",
    progressPct: row.progress_pct ?? 0,
    inputJson: row.input_json ?? "",
    resultJson: row.result_json ? row.result_json : null,
    errorCode: row.error_code ? row.error_code : null,
    errorMessage: row.error_message ? row.error_message : null,
    idempotencyKey: row.idempotency_key ? row.idempotency_key : null,
    heartbeatAt: parseTime(row.heartbeat_at),
    createdAt: parseTime(row.created_at) ?? new Date(0),
    updatedAt: parseTime(row.updated_at) ?? new Date(0),
    completedAt: parseTime(row.completed_at),
  };
}

function parseTime(value: string | undefined): Date | null {
  if (value === undefined || value === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return "<unreadable body>";
  }
}
