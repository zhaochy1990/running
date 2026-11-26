import { z } from "zod/v4";
import type { ClaimResponse, GenerateReceipt, GenerateResult } from "./protocol.js";

const identifier = z.string().min(1);

/** 租约已失效（被接管或已过期且易主）：当前结果不得再回传。 */
export class StaleLeaseError extends Error {
  constructor(
    readonly snapshotExecutionId: string,
    readonly action: "renew" | "submit",
  ) {
    super(`stale lease on ${action} for snapshot execution ${snapshotExecutionId}`);
    this.name = "StaleLeaseError";
  }
}

/** 执行项已不存在：没有任何可回传的对象，调用方丢弃这条消息（不重投）。 */
export class MissingExecutionError extends Error {
  constructor(readonly snapshotExecutionId: string) {
    super(`snapshot execution ${snapshotExecutionId} no longer exists`);
    this.name = "MissingExecutionError";
  }
}

export class EvalApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string,
  ) {
    super(`plan-eval api ${status} ${code}: ${detail}`);
    this.name = "EvalApiError";
  }
}

const receiptSchema = z.object({
  receipt_id: identifier,
  snapshot_execution_id: identifier,
  generate_status: z.enum(["done", "failed"]),
  artifact_id: z.string().nullable(),
  evaluate_status: identifier,
  received_at: identifier,
});

export interface EvalLease {
  agent_version: string;
  worker_id: string;
  lease_epoch: number;
}

export class EvalApiClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async claim(snapshotExecutionId: string, agentVersion: string, workerId: string, claimRequestId: string): Promise<ClaimResponse> {
    const response = await this.call("POST", "/api/internal/plan-eval/executions/claim", {
      snapshot_execution_id: snapshotExecutionId,
      agent_version: agentVersion,
      worker_id: workerId,
      claim_request_id: claimRequestId,
    });
    if (response.status === 404) return { status: "missing" };
    if (response.status === 409) throw new EvalApiError(409, await errorCode(response), "claim rejected");
    if (response.status !== 200) throw new EvalApiError(response.status, await errorCode(response), "claim failed");
    return claimSchema.parse(await response.json());
  }

  async renew(snapshotExecutionId: string, lease: EvalLease): Promise<void> {
    const response = await this.call("POST", `/api/internal/plan-eval/executions/${encodeURIComponent(snapshotExecutionId)}/renew`, {
      ...lease,
    });
    if (response.status === 409) throw new StaleLeaseError(snapshotExecutionId, "renew");
    if (response.status !== 200) throw new EvalApiError(response.status, await errorCode(response), "renew failed");
  }

  /** 返回持久化收据；拿到即代表 Generate 终态已落库，调用方可以 ACK。 */
  async submit(snapshotExecutionId: string, lease: EvalLease, result: GenerateResult, submitId: string): Promise<GenerateReceipt> {
    const response = await this.call("POST", `/api/internal/plan-eval/executions/${encodeURIComponent(snapshotExecutionId)}/result`, {
      ...lease,
      submit_id: submitId,
      result,
    });
    if (response.status === 404) throw new MissingExecutionError(snapshotExecutionId);
    if (response.status === 409) throw new StaleLeaseError(snapshotExecutionId, "submit");
    if (response.status !== 200) throw new EvalApiError(response.status, await errorCode(response), "submit failed");
    return receiptSchema.parse(await response.json());
  }

  private async call(method: string, path: string, body: unknown): Promise<Response> {
    // Retry one transport failure with the same claim/submit IDs and bytes.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          signal: AbortSignal.timeout(30_000),
          headers: { "content-type": "application/json", "x-plan-eval-token": this.token },
          body: JSON.stringify(body),
        });
      } catch (error) {
        if (attempt > 0 || !(error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError"))) throw error;
      }
    }
  }
}

const inputSchema = z.object({
  artifact_type: z.enum(["master_plan", "weekly_plan_batch"]),
  request: z.unknown(),
  snapshot: z.unknown(),
  as_of: z.string().datetime({ offset: true }),
});

const claimSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("leased"),
    lease_epoch: z.number().int().positive(),
    lease_expires_at: z.string().datetime({ offset: true }),
    input: inputSchema,
  }),
  z.object({ status: z.literal("busy"), retry_after_ms: z.number().nonnegative() }),
  z.object({
    status: z.literal("terminal"),
    generate_status: z.enum(["done", "failed"]),
    artifact_id: z.string().nullable(),
  }),
]);

async function errorCode(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : "unknown";
  } catch {
    return "unknown";
  }
}
