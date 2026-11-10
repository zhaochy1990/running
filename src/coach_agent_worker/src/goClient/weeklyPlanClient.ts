import { newPermanentError } from "../job/errors.js";

/**
 * 周课落库内部通道（#858 PR-A）的领域形状：batch-apply 逐周结果 + list 周行。
 * master/rolling 两个 handler 共用（接口放这里，测试注入 fake）。
 */
export interface WeeklyPlanAppliedWeek {
  week_start: string;
  plan_id: string;
  revision: number;
  replaced: boolean;
}

export interface WeeklyPlanWeekRow {
  week_start: string;
  master_plan_id: string | null;
  revision: number;
}

/** 调整提案内部通道（#858 PR-C）：同意流存储的 worker 侧形状。 */
export interface PendingAdjustmentRow {
  id: string;
  master_plan_id: string;
  event_week_start: string;
  reason: string;
  status: string;
  payload: string | null;
  question: string;
}

export interface AdjustmentChannel {
  /** 夜检/换因后回填 pending 行 payload（Go：POST /plan-adjustments/:id/payload）。 */
  completeAdjustmentPayload(userId: string, adjustmentId: string, reason: string, payload: string): Promise<PendingAdjustmentRow>;
  /** 读用户当前 pending 行（换因 job 定位目标行；无行=null）。 */
  getPendingAdjustment(userId: string): Promise<PendingAdjustmentRow | null>;
}

/** handler 依赖的周课通道面（GoWeeklyPlanClient 即其实现，测试用 fake）。 */
export interface RollingWeeklyChannel extends AdjustmentChannel {
  batchApplyWeeklyPlans(userId: string, masterPlanId: string, weeks: unknown[]): Promise<WeeklyPlanAppliedWeek[]>;
  listWeeklyPlanWeeks(userId: string, masterPlanId: string): Promise<WeeklyPlanWeekRow[]>;
}

interface BatchApplyResponse {
  results?: Array<{ week_start?: unknown; plan_id?: unknown; revision?: unknown; replaced?: unknown }>;
}

interface ListWeeksResponse {
  weeks?: Array<{ week_start?: unknown; master_plan_id?: unknown; revision?: unknown }>;
}

interface AdjustmentResponseShape {
  adjustment?: {
    id?: unknown;
    master_plan_id?: unknown;
    event_week_start?: unknown;
    reason?: unknown;
    status?: unknown;
    payload?: unknown;
    question?: unknown;
  };
}

function parseAdjustmentRow(raw: AdjustmentResponseShape): PendingAdjustmentRow {
  const row = raw.adjustment ?? {};
  return {
    id: String(row.id ?? ""),
    master_plan_id: String(row.master_plan_id ?? ""),
    event_week_start: String(row.event_week_start ?? ""),
    reason: String(row.reason ?? ""),
    status: String(row.status ?? ""),
    payload: typeof row.payload === "string" ? row.payload : null,
    question: String(row.question ?? ""),
  };
}

/**
 * Go 周课内部端点客户端（#858）：镜像 jobClient 的 fetch + x-internal-token 模式。
 * - `POST /api/internal/users/:user_id/plan/weeks/batch-apply`：滚动/首批周课文档批量落库
 *   （同 master_plan 周=期望替换 revision+1；异 master_plan 周=409）。
 * - `GET /api/internal/users/:user_id/plan/weeks?master_plan_id=...`：已落库周行列表。
 *
 * 错误分级同 jobClient：4xx（除 401）是对本次请求的确定性拒绝 → permanent；401/5xx
 * 是基础设施瞬态 → 抛普通错误走重试。
 */
export class GoWeeklyPlanClient implements RollingWeeklyChannel {
  constructor(
    private readonly baseUrl: string,
    private readonly internalToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async batchApplyWeeklyPlans(userId: string, masterPlanId: string, weeks: unknown[]): Promise<WeeklyPlanAppliedWeek[]> {
    const response = await this.call("POST", `/api/internal/users/${encodeURIComponent(userId)}/plan/weeks/batch-apply`, {
      master_plan_id: masterPlanId,
      weeks,
    });
    if (response.status !== 201) {
      throw await this.describe("weekly batch apply", response);
    }
    const body = (await response.json()) as BatchApplyResponse;
    if (!Array.isArray(body.results)) throw new Error("go weekly batch apply returned no results array");
    return body.results.map((row) => ({
      week_start: String(row.week_start ?? ""),
      plan_id: String(row.plan_id ?? ""),
      revision: Number(row.revision ?? 0),
      replaced: row.replaced === true,
    }));
  }

  async listWeeklyPlanWeeks(userId: string, masterPlanId: string): Promise<WeeklyPlanWeekRow[]> {
    const response = await this.call(
      "GET",
      `/api/internal/users/${encodeURIComponent(userId)}/plan/weeks?master_plan_id=${encodeURIComponent(masterPlanId)}`,
    );
    if (response.status === 404) return [];
    if (response.status !== 200) {
      throw await this.describe("weekly list weeks", response);
    }
    const body = (await response.json()) as ListWeeksResponse;
    if (!Array.isArray(body.weeks)) throw new Error("go weekly list returned no weeks array");
    return body.weeks.map((row) => ({
      week_start: String(row.week_start ?? ""),
      master_plan_id: typeof row.master_plan_id === "string" ? row.master_plan_id : null,
      revision: Number(row.revision ?? 0),
    }));
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

  /** #858 PR-C：回填 pending 提案 payload（换因重生成完成的落点）。 */
  async completeAdjustmentPayload(userId: string, adjustmentId: string, reason: string, payload: string): Promise<PendingAdjustmentRow> {
    const response = await this.call("POST", `/api/internal/users/${encodeURIComponent(userId)}/plan-adjustments/${encodeURIComponent(adjustmentId)}/payload`, {
      reason,
      payload,
    });
    return parseAdjustmentRow((await response.json()) as AdjustmentResponseShape);
  }

  /** #858 PR-C：读当前 pending 提案行（无=null；404 归一为 null）。 */
  async getPendingAdjustment(userId: string): Promise<PendingAdjustmentRow | null> {
    let response: Response;
    try {
      response = await this.call("GET", `/api/internal/users/${encodeURIComponent(userId)}/plan-adjustments/pending`);
    } catch (error) {
      // Go 用户端点 404 → 内部端点不存在；这里打的是内部前缀，恒 200——防御性归一。
      throw error;
    }
    if (response.status === 404) return null;
    return parseAdjustmentRow((await response.json()) as AdjustmentResponseShape);
  }

  /** 4xx（除 401）确定性 → permanent（重投救不了）；401/5xx 瞬态 → 可重试。 */
  private async describe(action: string, response: Response): Promise<Error> {
    let detail = "<unreadable body>";
    try {
      detail = (await response.text()).slice(0, 200);
    } catch {
      // keep placeholder
    }
    const message = `go ${action} failed (${response.status}): ${detail}`;
    if (response.status >= 400 && response.status < 500 && response.status !== 401) {
      return newPermanentError("weekly_plan_apply_rejected", new Error(message));
    }
    return new Error(message);
  }
}
