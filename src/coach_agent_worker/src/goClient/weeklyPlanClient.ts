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

/** handler 依赖的周课通道面（GoWeeklyPlanClient 即其实现，测试用 fake）。 */
export interface RollingWeeklyChannel {
  batchApplyWeeklyPlans(userId: string, masterPlanId: string, weeks: unknown[]): Promise<WeeklyPlanAppliedWeek[]>;
  listWeeklyPlanWeeks(userId: string, masterPlanId: string): Promise<WeeklyPlanWeekRow[]>;
}

interface BatchApplyResponse {
  results?: Array<{ week_start?: unknown; plan_id?: unknown; revision?: unknown; replaced?: unknown }>;
}

interface ListWeeksResponse {
  weeks?: Array<{ week_start?: unknown; master_plan_id?: unknown; revision?: unknown }>;
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
