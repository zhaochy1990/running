import type { PlanJob } from "./model.js";
import type { Heartbeat } from "./ports.js";

/**
 * Error classification for a plan-job failure.
 *
 * - `PermanentError` (via `NewPermanentError`) → terminal `failed` with a
 *   stable error code, never retried: contract violations and the kernel's
 *   non-completed decisions belong here (ADR 0030).
 * - any other error → retryable (transient infra), bounded by the retry policy.
 */
export class PermanentError extends Error {
  readonly code: string;
  constructor(code: string, err: unknown) {
    super(err instanceof Error ? err.message : String(err));
    this.name = "PermanentError";
    this.code = code;
  }
}

export function newPermanentError(code: string, err: unknown): PermanentError {
  return new PermanentError(code, err);
}

/** Reports whether `err` (or anything it wraps) is a PermanentError. */
export function asPermanent(err: unknown): PermanentError | null {
  if (err instanceof PermanentError) return err;
  if (err instanceof Error) {
    let cursor: unknown = err;
    while (cursor instanceof Error && cursor.cause !== undefined && cursor.cause !== null) {
      cursor = cursor.cause;
      if (cursor instanceof PermanentError) return cursor;
    }
  }
  return null;
}

/** A kernel run reported a terminal outcome that is not a completed plan draft. */
export class KernelDecisionError extends PermanentError {}

/**
 * Stable error codes. `error_code` must be stable so the frontend can map a
 * known failure to actionable Chinese copy without parsing prose.
 */
export const ERROR_CODES = {
  /** Job type has no registered handler. */
  NO_HANDLER: "no_handler",
  /** The enqueued kernel request failed server-side zod revalidation. */
  CONTRACT_VIOLATION: "contract_violation",
  /** Kernel did not reach a completed plan (goal conflict / quality gate / ...). */
  KERNEL_NOT_COMPLETED: "kernel_not_completed",
  /** Athlete has no active race goal to attach the generated plan to. */
  NO_ACTIVE_RACE_GOAL: "no_active_race_goal",
  /** Weekly kernel produced a week other than the current/next Shanghai week. */
  WEEK_NOT_SUPPORTED: "week_not_supported",
  /** Go draft insert endpoint rejected the generated content. */
  DRAFT_REJECTED: "draft_rejected",
  /** Stale-running reconcile: no heartbeat for too long. */
  HEARTBEAT_TIMEOUT: "heartbeat_timeout",
} as const;

export type HandlerResult = {
  /** Serialized as `result_json` when the job finishes done (e.g. draft JSON). */
  result: string;
  /** The Go plan draft id, surfaced on the poll endpoint once done. */
  draftId?: string;
};
export type Handler = (job: PlanJob, hb: Heartbeat) => Promise<HandlerResult>;
