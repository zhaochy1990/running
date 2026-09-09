import { AIMessage, MasterPlanGraphRequest } from "@stride/coach-agent";
import { PLAN_JOB_TYPES, type PlanJobType } from "@stride/coach-agent-worker";
import { PLAN_JOB_CONFIRMATION_KIND } from "@stride/contract";
import type { Hono, MiddlewareHandler } from "hono";
import type { AuthEnv } from "../auth.js";
import type { CoachInvoker } from "../coach/coachInvoker.js";
import type { TurnCoordinator } from "../turn/coordinator.js";
import type { PlanJobsService } from "./planJobs.js";

/**
 * Proposal-confirmation surface (ADR 0030, Pattern X): the athlete confirms a
 * drafted plan proposal and this deterministic endpoint enqueues the plan job
 * and appends a confirmation message (job_id + job_type) to the conversation
 * thread — under the existing per-thread lock with the existing idempotency
 * receipt, so the card round-trips across reopen / other devices.
 */
export interface PlanProposalConfirmService {
  confirm(input: {
    userId: string;
    sessionId: string;
    jobType: PlanJobType;
    request: unknown;
    clientTurnId: string;
  }): Promise<{ jobId: string; jobType: PlanJobType }>;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function registerPlanProposalConfirmRoutes(
  app: Hono<AuthEnv>,
  dependencies: {
    confirm: PlanProposalConfirmService;
    auth: MiddlewareHandler<AuthEnv>;
  },
): void {
  app.post("/api/users/me/coach/plan-proposals/confirm", dependencies.auth, async (context) => {
    const userId = context.get("userId");
    const body = await readConfirmRequest(context.req.raw);
    if (!body.ok) return context.json({ error: body.error }, 400);
    const result = await dependencies.confirm.confirm({
      userId,
      sessionId: body.value.sessionId,
      jobType: body.value.jobType,
      request: body.value.request,
      clientTurnId: body.value.clientTurnId,
    });
    return context.json({ job_id: result.jobId, job_type: result.jobType }, 201);
  });
}

/**
 * Compose the confirmation service from the enqueuer, the coach invoker (for
 * the thread append) and the turn coordinator (lock + idempotency receipt).
 */
export function createPlanProposalConfirmService(dependencies: {
  planJobs: PlanJobsService;
  coach: CoachInvoker;
  turnCoordinator: TurnCoordinator;
}): PlanProposalConfirmService {
  return {
    async confirm({ userId, sessionId, jobType, request, clientTurnId }) {
      const threadId = `${userId}:coach:${sessionId}`;
      const fingerprint = dependencies.turnCoordinator.getFingerprint({ jobType, request });
      return dependencies.turnCoordinator.run({ threadId, clientTurnId, fingerprint }, async () => {
        const { jobId } = await dependencies.planJobs.enqueue({
          userId,
          jobType,
          inputJson: JSON.stringify(request),
          idempotencyKey: clientTurnId,
        });
        await dependencies.coach.appendThreadMessage(
          threadId,
          new AIMessage({ content: JSON.stringify({ kind: PLAN_JOB_CONFIRMATION_KIND, job_id: jobId, job_type: jobType }) }),
        );
        return { jobId, jobType };
      });
    },
  };
}

async function readConfirmRequest(
  request: Request,
): Promise<{ ok: true; value: { sessionId: string; jobType: PlanJobType; request: unknown; clientTurnId: string } } | { ok: false; error: string }> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  if (!isRecord(value)) return { ok: false, error: "invalid_request" };

  const sessionId = value.session_id;
  const clientTurnId = value.client_turn_id;
  if (typeof sessionId !== "string" || !ID_RE.test(sessionId)) return { ok: false, error: "invalid_session_id" };
  if (typeof clientTurnId !== "string" || !ID_RE.test(clientTurnId)) return { ok: false, error: "invalid_client_turn_id" };

  const jobType = value.job_type;
  if (typeof jobType !== "string" || !(PLAN_JOB_TYPES as readonly string[]).includes(jobType)) {
    return { ok: false, error: "invalid_job_type" };
  }

  // Server-side re-validation: never trust the client's kernel request.
  const parsed = MasterPlanGraphRequest.safeParse(value.request);
  if (!parsed.success) return { ok: false, error: "invalid_request" };

  return { ok: true, value: { sessionId, jobType: jobType as PlanJobType, request: parsed.data, clientTurnId } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
