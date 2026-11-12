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

/**
 * Go upsert 端点的确定性拒绝（409 adjustment_event_closed）：该（用户,事件周）
 * 已达终态（accepted/dismissed）——用户答过的事件永不重问，调用方降级 no-op
 * 成功而不是报错重试。
 */
export class AdjustmentEventClosedError extends Error {
  constructor() {
    super("adjustment event already closed");
  }
}

export interface AdjustmentChannel {
  /** 夜检/换因后回填 pending 行 payload（Go：POST /plan-adjustments/:id/payload）。 */
  completeAdjustmentPayload(userId: string, adjustmentId: string, reason: string, payload: string): Promise<PendingAdjustmentRow>;
  /** 读用户当前 pending 行（换因 job 定位目标行；无行=null）。 */
  getPendingAdjustment(userId: string): Promise<PendingAdjustmentRow | null>;
  /**
   * #858 PR-C 夜检建行：建（或刷新）pending 提案行（Go：POST
   * /plan-adjustments，payload=投影产物）。事件已关闭时抛
   * AdjustmentEventClosedError。
   */
  upsertAdjustment(
    userId: string,
    input: { masterPlanId: string; eventWeekStart: string; reason: string; question: string; payload: string },
  ): Promise<PendingAdjustmentRow>;
}

/** handler 依赖的周课通道面（GoWeeklyPlanClient 即其实现，测试用 fake）。 */
export interface RollingWeeklyChannel extends AdjustmentChannel, InjuryChannel {
  batchApplyWeeklyPlans(userId: string, masterPlanId: string, weeks: unknown[]): Promise<WeeklyPlanAppliedWeek[]>;
  listWeeklyPlanWeeks(userId: string, masterPlanId: string): Promise<WeeklyPlanWeekRow[]>;
}

// ── #858 PR-D：伤病模式内部通道（plan_injury）────────────────────────────────

/**
 * Go plan_injury_state active 行的 worker 侧形状（无 active 行=null——伤病已
 * 恢复/从未进入）。maintenance_km 是维持周量单值锚（重估真源在 TS，Go 只存值）；
 * needs_verdict=真时用户答了「加重」，等待重新四选一。
 */
export interface InjuryStateRow {
  master_plan_id: string;
  mode: "reduced" | "rest" | "pending_doctor";
  detail: string;
  maintenance_km: number | null;
  needs_verdict: boolean;
  last_checkin_day: string | null;
  last_checkin_answer: string | null;
}

/** 伤病状态内部通道（#858 PR-D）：worker 读 active 态 + 回写重估后的维持周量。 */
export interface InjuryChannel {
  /** Go：GET /api/internal/users/:id/plan-injury（无 active 行=null）。 */
  getInjuryState(userId: string): Promise<InjuryStateRow | null>;
  /** Go：POST /api/internal/users/:id/plan-injury/maintenance {km}（重估单值锚回写）。 */
  updateInjuryMaintenance(userId: string, km: number): Promise<InjuryStateRow>;
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

interface InjuryStateResponseShape {
  injury?: {
    master_plan_id?: unknown;
    mode?: unknown;
    detail?: unknown;
    maintenance_km?: unknown;
    needs_verdict?: unknown;
    last_checkin_day?: unknown;
    last_checkin_answer?: unknown;
  };
}

function parseInjuryRow(raw: InjuryStateResponseShape): InjuryStateRow {
  const row = raw.injury ?? {};
  const mode = String(row.mode ?? "");
  if (mode !== "reduced" && mode !== "rest" && mode !== "pending_doctor") {
    throw new Error(`go injury state returned unknown mode ${mode}`);
  }
  return {
    master_plan_id: String(row.master_plan_id ?? ""),
    mode,
    detail: String(row.detail ?? ""),
    maintenance_km: typeof row.maintenance_km === "number" ? row.maintenance_km : null,
    needs_verdict: row.needs_verdict === true,
    last_checkin_day: typeof row.last_checkin_day === "string" ? row.last_checkin_day : null,
    last_checkin_answer: typeof row.last_checkin_answer === "string" ? row.last_checkin_answer : null,
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
    const response = await this.call("GET", `/api/internal/users/${encodeURIComponent(userId)}/plan/weeks?master_plan_id=${encodeURIComponent(masterPlanId)}`);
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

  /** #858 PR-C 夜检建行：upsert pending 提案（payload=投影产物）；409 事件已关闭 → AdjustmentEventClosedError。 */
  async upsertAdjustment(
    userId: string,
    input: { masterPlanId: string; eventWeekStart: string; reason: string; question: string; payload: string },
  ): Promise<PendingAdjustmentRow> {
    const response = await this.call("POST", `/api/internal/users/${encodeURIComponent(userId)}/plan-adjustments`, {
      master_plan_id: input.masterPlanId,
      event_week_start: input.eventWeekStart,
      reason: input.reason,
      question: input.question,
      payload: input.payload,
    });
    if (response.status === 409) {
      throw new AdjustmentEventClosedError();
    }
    if (response.status !== 201) {
      throw await this.describe("adjustment upsert", response);
    }
    return parseAdjustmentRow((await response.json()) as AdjustmentResponseShape);
  }

  /** #858 PR-C：读当前 pending 提案行（无=null；404 归一为 null）。 */
  async getPendingAdjustment(userId: string): Promise<PendingAdjustmentRow | null> {
    let response: Response;
    try {
      response = await this.call("GET", `/api/internal/users/${encodeURIComponent(userId)}/plan-adjustment/pending`);
    } catch (error) {
      // Go 用户端点 404 → 内部端点不存在；这里打的是内部前缀，恒 200——防御性归一。
      throw error;
    }
    if (response.status === 404) return null;
    return parseAdjustmentRow((await response.json()) as AdjustmentResponseShape);
  }

  /** #858 PR-D：读 active 伤病态（无 active 行=null；404 归一为 null）。 */
  async getInjuryState(userId: string): Promise<InjuryStateRow | null> {
    const response = await this.call("GET", `/api/internal/users/${encodeURIComponent(userId)}/plan-injury`);
    if (response.status === 404) return null;
    if (response.status !== 200) {
      throw await this.describe("injury state read", response);
    }
    return parseInjuryRow((await response.json()) as InjuryStateResponseShape);
  }

  /** #858 PR-D：回写重估后的维持周量（Go 只存值——重估真源在 TS，见 handler 注释）。 */
  async updateInjuryMaintenance(userId: string, km: number): Promise<InjuryStateRow> {
    const response = await this.call("POST", `/api/internal/users/${encodeURIComponent(userId)}/plan-injury/maintenance`, { km });
    if (response.status !== 200) {
      throw await this.describe("injury maintenance write", response);
    }
    return parseInjuryRow((await response.json()) as InjuryStateResponseShape);
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
