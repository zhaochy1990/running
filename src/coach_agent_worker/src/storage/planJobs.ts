import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { PlanJob, PlanJobStatus } from "../job/model.js";
import { type ClaimResult, IdempotencyConflictError, type PlanJobStore } from "../job/ports.js";

interface PlanJobRow extends RowDataPacket {
  job_id: string;
  user_id: string;
  job_type: string;
  status: PlanJobStatus;
  attempts: number;
  stage: string;
  progress_pct: number;
  input_json: string;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  idempotency_key: string | null;
  heartbeat_at: Date | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

const SETUP_SQL = `
  CREATE TABLE IF NOT EXISTS plan_jobs (
    job_id VARCHAR(36) CHARACTER SET ascii NOT NULL,
    user_id VARCHAR(64) CHARACTER SET ascii NOT NULL,
    job_type VARCHAR(32) CHARACTER SET ascii NOT NULL,
    status ENUM('queued','running','done','failed') NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    stage VARCHAR(32) CHARACTER SET ascii NOT NULL DEFAULT '',
    progress_pct INT NOT NULL DEFAULT 0,
    input_json LONGTEXT NOT NULL,
    result_json LONGTEXT NULL,
    error_code VARCHAR(64) CHARACTER SET ascii NULL,
    error_message TEXT NULL,
    idempotency_key VARCHAR(128) CHARACTER SET ascii NULL,
    heartbeat_at TIMESTAMP(6) NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    completed_at TIMESTAMP(6) NULL,
    PRIMARY KEY (job_id),
    UNIQUE KEY uq_plan_jobs_user_idem (user_id, idempotency_key),
    INDEX idx_plan_jobs_recent (user_id, created_at)
  ) ENGINE=InnoDB
`;

/**
 * MySQL store for the plan_jobs table in the coach persistence DB. The plan-job
 * table is worker-owned (AGENTS.md SQL ownership); the coach chat service
 * enqueues through this same class so there is a single implementation.
 */
export class MySqlPlanJobStore implements PlanJobStore {
  constructor(private readonly pool: Pool) {}

  /** Idempotent schema creation. */
  async setup(): Promise<void> {
    await this.pool.query(SETUP_SQL);
  }

  async create(job: PlanJob): Promise<void> {
    try {
      await this.pool.execute(
        `INSERT INTO plan_jobs
          (job_id, user_id, job_type, status, attempts, stage, progress_pct,
           input_json, result_json, error_code, error_message, idempotency_key,
           heartbeat_at, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          job.jobId,
          job.userId,
          job.jobType,
          job.status,
          job.attempts,
          job.stage,
          job.progressPct,
          job.inputJson,
          job.resultJson,
          job.errorCode,
          job.errorMessage,
          job.idempotencyKey,
          job.heartbeatAt,
          job.createdAt,
          job.updatedAt,
          job.completedAt,
        ],
      );
    } catch (error) {
      const duplicate = isDuplicateEntry(error);
      if (duplicate && job.idempotencyKey !== null) {
        const existing = await this.findByIdempotency(job.userId, job.idempotencyKey);
        if (existing !== null) {
          throw new IdempotencyConflictError(existing.jobId);
        }
      }
      throw error;
    }
  }

  async get(jobId: string): Promise<PlanJob | null> {
    const [rows] = await this.pool.query<PlanJobRow[]>(`SELECT * FROM plan_jobs WHERE job_id = ?`, [jobId]);
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async update(job: PlanJob): Promise<void> {
    await this.pool.execute(
      `UPDATE plan_jobs SET
         status=?, attempts=?, stage=?, progress_pct=?, result_json=?,
         error_code=?, error_message=?, heartbeat_at=?, updated_at=?, completed_at=?
       WHERE job_id=?`,
      [
        job.status,
        job.attempts,
        job.stage,
        job.progressPct,
        job.resultJson,
        job.errorCode,
        job.errorMessage,
        job.heartbeatAt,
        job.updatedAt,
        job.completedAt,
        job.jobId,
      ],
    );
  }

  async claim(jobId: string, now: Date): Promise<ClaimResult> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE plan_jobs SET status='running', attempts=attempts+1, heartbeat_at=?,
         updated_at=?, error_code=NULL, error_message=NULL
       WHERE job_id=? AND status='queued'`,
      [now, now, jobId],
    );
    if (result.affectedRows === 0) {
      return { claimed: false };
    }
    return { claimed: true, job: await this.claimedRow(jobId) };
  }

  async reclaimRunning(jobId: string, now: Date, maxAttempts: number): Promise<ClaimResult> {
    // `attempts < ?` is the CAS guard: two concurrent redeliveries serialize on
    // the row lock, and the second finds the budget exhausted. It is also the
    // redelivery bound — once attempts reach max, only the reconcile can retire
    // the job (terminal failed), never an endless reclaim loop.
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE plan_jobs SET attempts=attempts+1, heartbeat_at=?, updated_at=?
       WHERE job_id=? AND status='running' AND attempts < ?`,
      [now, jobId, maxAttempts],
    );
    if (result.affectedRows === 0) {
      return { claimed: false };
    }
    return { claimed: true, job: await this.claimedRow(jobId) };
  }

  async failStaleRunning(olderThan: Date, now: Date, errorCode: string): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE plan_jobs SET status='failed', error_code=?, error_message=?, completed_at=?, updated_at=?
       WHERE status='running' AND heartbeat_at IS NOT NULL AND heartbeat_at < ?`,
      [errorCode, `no heartbeat since ${olderThan.toISOString()}`, now, now, olderThan],
    );
    return result.affectedRows;
  }

  private async claimedRow(jobId: string): Promise<PlanJob> {
    const job = await this.get(jobId);
    if (job === null) {
      throw new Error(`claimed plan-job row disappeared: ${jobId}`);
    }
    return job;
  }

  private async findByIdempotency(userId: string, idempotencyKey: string): Promise<PlanJob | null> {
    const [rows] = await this.pool.query<PlanJobRow[]>(`SELECT * FROM plan_jobs WHERE user_id=? AND idempotency_key=? LIMIT 1`, [userId, idempotencyKey]);
    return rows[0] ? toDomain(rows[0]) : null;
  }
}

function toDomain(row: PlanJobRow): PlanJob {
  return {
    jobId: row.job_id,
    userId: row.user_id,
    jobType: row.job_type as PlanJob["jobType"],
    status: row.status,
    attempts: row.attempts,
    stage: row.stage,
    progressPct: row.progress_pct,
    inputJson: row.input_json,
    resultJson: row.result_json,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    idempotencyKey: row.idempotency_key,
    heartbeatAt: asDate(row.heartbeat_at),
    createdAt: asDate(row.created_at) ?? new Date(0),
    updatedAt: asDate(row.updated_at) ?? new Date(0),
    completedAt: asDate(row.completed_at),
  };
}

/** mysql2 returns TIMESTAMP(6) rows as Date objects. */
function asDate(value: Date | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

function isDuplicateEntry(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ER_DUP_ENTRY";
}
