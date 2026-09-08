/**
 * Plan Job domain model — the durable record of one async training-plan task.
 *
 * Mirrors the Go async-job worker's domain (`src/go/internal/job/job.go`): the
 * broker carries only a pointer message; the full state lives in the coach
 * persistence DB (see `storage/planJobs.ts`).
 */

export const PLAN_JOB_STATUSES = ["queued", "running", "done", "failed"] as const;
export type PlanJobStatus = (typeof PLAN_JOB_STATUSES)[number];

/** 生成/结构调整 × 赛季训练计划/本周课表。本期仅 `generate_master_plan` 接入 kernel。 */
export const PLAN_JOB_TYPES = ["generate_master_plan", "generate_weekly_plan", "adjust_master_plan", "adjust_weekly_plan"] as const;
export type PlanJobType = (typeof PLAN_JOB_TYPES)[number];

/**
 * Estimated duration surfaced by the enqueue endpoint so the client can show
 * "预计 X 分钟". Single source shared with the coach chat service.
 */
export const PLAN_JOB_ESTIMATED_DURATIONS_SECONDS: Record<PlanJobType, number> = {
  generate_master_plan: 300,
  generate_weekly_plan: 120,
  adjust_master_plan: 300,
  adjust_weekly_plan: 120,
};

export interface PlanJob {
  jobId: string;
  /** JWT sub of the athlete this job belongs to; also the plan-draft owner. */
  userId: string;
  jobType: PlanJobType;
  status: PlanJobStatus;
  attempts: number;
  stage: string;
  progressPct: number;
  inputJson: string;
  resultJson: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** Deduplicates client-driven enqueue: at most one job per (user, key). */
  idempotencyKey: string | null;
  /** Last time the handler reported progress; the stale-running reconcile key. */
  heartbeatAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export function isTerminal(status: PlanJobStatus): boolean {
  return status === "done" || status === "failed";
}

/** Pointer message published to the broker (mirrors Go `job.Message`). */
export interface PlanJobMessage {
  jobId: string;
  /** Rides along only for log context — auth/ownership lives on the job row. */
  userId: string;
}
