import { MasterPlanGraphRequest, PLAN_JOB_TYPES, type PlanJob, type PlanJobType, WeeklyPlanGeneratorRequest } from "@stride/coach-agent-worker";
import type { Hono, MiddlewareHandler } from "hono";
import type { AuthEnv } from "../auth.js";

/**
 * Deterministic plan-job surface (ADR 0030): enqueue a directly-submitted
 * kernel request (server-side zod re-validation — the client payload is never
 * trusted) and poll the job. Idempotent by (user, idempotency_key).
 */
export interface PlanJobsService {
  enqueue(input: {
    userId: string;
    jobType: PlanJobType;
    inputJson: string;
    idempotencyKey?: string;
  }): Promise<{ jobId: string; estimatedDurationSeconds: number }>;
  get(userId: string, jobId: string): Promise<PlanJob | null>;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function registerPlanJobRoutes(app: Hono<AuthEnv>, dependencies: { planJobs: PlanJobsService; auth: MiddlewareHandler<AuthEnv> }): void {
  app.post("/api/users/me/coach/plan-jobs", dependencies.auth, async (context) => {
    const userId = context.get("userId");
    const body = await readEnqueueRequest(context.req.raw);
    if (!body.ok) return context.json({ error: body.error }, 400);
    const { jobType, inputJson, idempotencyKey } = body.value;
    const { jobId, estimatedDurationSeconds } = await dependencies.planJobs.enqueue({
      userId,
      jobType,
      inputJson,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });
    return context.json({ job_id: jobId, job_type: jobType, estimated_duration_seconds: estimatedDurationSeconds }, 201);
  });

  app.get("/api/users/me/coach/plan-jobs/:job_id", dependencies.auth, async (context) => {
    const userId = context.get("userId");
    const jobId = context.req.param("job_id");
    if (!ID_RE.test(jobId)) return context.json({ error: "invalid_job_id" }, 400);
    const job = await dependencies.planJobs.get(userId, jobId);
    if (job === null) return context.json({ error: "plan_job_not_found" }, 404);
    return context.json(toPollResponse(job));
  });
}

function toPollResponse(job: PlanJob): Record<string, unknown> {
  return {
    job_id: job.jobId,
    job_type: job.jobType,
    status: job.status,
    stage: job.stage,
    progress_pct: job.progressPct,
    error_code: job.errorCode,
    result_draft_id: draftIdOf(job),
  };
}

function draftIdOf(job: PlanJob): string | null {
  if (job.status !== "done" || job.resultJson === null) return null;
  try {
    const result = JSON.parse(job.resultJson) as { draft_id?: unknown };
    return typeof result.draft_id === "string" ? result.draft_id : null;
  } catch {
    return null;
  }
}

async function readEnqueueRequest(
  request: Request,
): Promise<{ ok: true; value: { jobType: PlanJobType; inputJson: string; idempotencyKey?: string } } | { ok: false; error: string }> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  if (!isRecord(value)) return { ok: false, error: "invalid_request" };

  const jobType = value.job_type;
  if (typeof jobType !== "string" || !(PLAN_JOB_TYPES as readonly string[]).includes(jobType)) {
    return { ok: false, error: "invalid_job_type" };
  }
  const idempotencyKey = value.idempotency_key;
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || idempotencyKey.length === 0 || idempotencyKey.length > 128)) {
    return { ok: false, error: "invalid_idempotency_key" };
  }
  // Server-side re-validation: never trust the client's kernel request. The
  // request schema depends on the job type (per-type gate — a `generate_weekly_plan`
  // job is re-validated against `WeeklyPlanGeneratorRequest`).
  const schema = jobType === "generate_master_plan" ? MasterPlanGraphRequest : WeeklyPlanGeneratorRequest;
  const parsed = schema.safeParse(value.request);
  if (!parsed.success) {
    return { ok: false, error: "invalid_request" };
  }
  return {
    ok: true,
    value: {
      jobType: jobType as PlanJobType,
      inputJson: JSON.stringify(parsed.data),
      ...(typeof idempotencyKey === "string" ? { idempotencyKey } : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
