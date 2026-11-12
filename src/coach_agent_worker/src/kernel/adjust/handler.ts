import {
  type ActiveMasterPlanMetadata,
  type ActivityRef,
  type AdjustOutcome,
  type AskReason,
  assessWeek,
  fromStoredContent,
  type MasterPlanContextProvider,
  type MasterPlanLlmModels,
  type RollingDeps,
  runAdjustProjection,
  storedWeeklyDocOf,
  type WeekDeviation,
} from "@stride/coach-agent";
import { AdjustJobRequest, type RollingMasterInput, shanghaiDay, type WeeklyPlan } from "@stride/contract";
import { AdjustmentEventClosedError, type RollingWeeklyChannel } from "../../goClient/weeklyPlanClient.js";
import { ERROR_CODES, type Handler, newPermanentError } from "../../job/errors.js";
import type { PlanJob } from "../../job/model.js";
import type { Heartbeat } from "../../job/ports.js";
import { rollingMasterIdOf } from "../rolling/handler.js";

/** 夜检建行的固定问句（检测证据在 payload.evidence 里，弹窗另行展示）。 */
export const ADJUST_PENDING_QUESTION = "上周完成得不理想，主要是？";

/** 调整 job 的存量读档面（与 rolling handler 同源）。 */
export interface AdjustMasterPlanSource {
  getMasterPlanMetadataForDate(userId: string, day: string): Promise<ActiveMasterPlanMetadata | null>;
}

/** 事件周课文档 + 该 master 全部已落库周文档（diff 基准）。 */
export interface AdjustWeeklyDocSource {
  /** 返回 weekly_plan 行 content（MySqlDataProvider 的宽松 Record 形状）。 */
  getWeeklyPlan(userId: string, weekStart: string): Promise<unknown | null>;
}

/** 宽松行 content → 周文档（Go 落库剥掉 schema/week_name——storedWeeklyDocOf 按行身份回填后严格 parse）。 */
async function weeklyDocOf(source: AdjustWeeklyDocSource, userId: string, weekStart: string): Promise<WeeklyPlan | null> {
  const raw = await source.getWeeklyPlan(userId, weekStart);
  return raw === null ? null : storedWeeklyDocOf(raw, weekStart);
}

/** 调整投影入口签名（=runAdjustProjection；测试注入 fake）。 */
export type AdjustProjection = (deps: RollingDeps, input: Parameters<typeof runAdjustProjection>[1]) => Promise<AdjustOutcome>;

export interface AdjustHandlerDeps {
  contextProvider: MasterPlanContextProvider;
  models: Pick<MasterPlanLlmModels, "phasingModel" | "contentModel">;
  masterPlans: AdjustMasterPlanSource;
  weeklyPlans: RollingWeeklyChannel;
  weeklyDocs: AdjustWeeklyDocSource;
  /** 测试缝：缺省=runAdjustProjection。 */
  projection?: AdjustProjection;
}

/** 心跳锚点（与 rolling handler 同一组 stage 名，单调护栏）。 */
const STAGE_READING = { stage: "reading_history", progressPct: 10 };
const STAGE_L1_START = { stage: "evaluating", progressPct: 25 };
const STAGE_L3 = { stage: "planning_phases", progressPct: 45 };
const STAGE_L4 = { stage: "planning_phases", progressPct: 75 };
const STAGE_OUTPUT = { stage: "outputting", progressPct: 95 };

class StageHeartbeats {
  private pct = 0;
  constructor(private readonly hb: Heartbeat) {}
  async report(anchor: { stage: string; progressPct: number }): Promise<void> {
    if (anchor.progressPct < this.pct) return;
    this.pct = anchor.progressPct;
    await this.hb(anchor.stage, anchor.progressPct);
  }
}

/**
 * `generate_adjustment` job handler（#858 PR-C 换因重生成通道）：定位用户的
 * pending 调整行（choose 异因时 payload 已清空）→ 对事件周跑偏差检测 →
 * runAdjustProjection（按最终原因的配方重生成当前批次剩余周）→ 经内部端点
 * 回填 pending 行 payload（mp 轮询到 payload 恢复即出方案）。
 *
 * 夜检通道（create_pending=true，PR-C 下半）：无匹配 pending 行时不 no-op，
 * 而是**建行**——先跑检测+投影，再经内部 upsert 端点落 pending 行（payload=
 * 投影产物、question=固定问句）；Go 返回 409 事件已关闭 = no-op 成功
 * （用户答过的事件永不重问）。
 *
 * 语义：无 pending 行（被拒后的竞态）且非 create_pending = no-op 成功；
 * injured 不走本引擎（permanent error，伤病模式 PR-D 接管）；最新数据显示
 * 事件周已恢复正常 = permanent error（mp 提示无需调整）；infeasible（L3 门挂）
 * = permanent error（PR-C 夜检升级为重排建议）。
 */
export function createAdjustJobHandler(deps: AdjustHandlerDeps): Handler {
  return async (job: PlanJob, hb) => {
    let request: AdjustJobRequest;
    try {
      request = AdjustJobRequest.parse(JSON.parse(job.inputJson));
    } catch (error) {
      throw newPermanentError(ERROR_CODES.CONTRACT_VIOLATION, error);
    }
    const stages = new StageHeartbeats(hb);
    const asOfDay = shanghaiDay(request.as_of ?? new Date().toISOString());

    if (request.reason === "injured") {
      throw newPermanentError("kernel_adjust_injured_unsupported", new Error("受伤不走调整提案引擎（伤病模式另行接管）"));
    }

    // ① 定位 pending 调整行：无行=用户已拒绝（竞态），no-op 成功——夜检
    // create_pending 模式例外（继续跑检测+投影后经 upsert 建行）。
    await stages.report(STAGE_READING);
    let pending = await deps.weeklyPlans.getPendingAdjustment(job.userId);
    if (pending !== null && pending.event_week_start !== request.event_week_start) {
      // 他事件的 pending：夜检建行路径照走（Go upsert 会先 supersede 它）；
      // mp 换因链路维持 no-op（不越权动用户的弹窗）。
      if (!request.create_pending) {
        return { result: JSON.stringify({ decision: "no_op", reason: "pending 调整行不存在或事件周不匹配（可能已被用户处理）" }) };
      }
      pending = null;
    }
    if (pending === null && !request.create_pending) {
      return { result: JSON.stringify({ decision: "no_op", reason: "pending 调整行不存在或事件周不匹配（可能已被用户处理）" }) };
    }
    if (pending !== null && pending.reason !== request.reason) {
      throw newPermanentError("kernel_adjust_reason_mismatch", new Error(`pending 行 reason=${pending.reason} 与请求 ${request.reason} 不一致`));
    }

    // ② 读档：active master content + 已落库周行/周文档。
    const active = await deps.masterPlans.getMasterPlanMetadataForDate(job.userId, asOfDay);
    if (active === null || active.status !== "active") {
      throw newPermanentError("kernel_adjust_no_active_master_plan", new Error("调整需要 active master plan"));
    }
    const masterId = rollingMasterIdOf(active.content, active.planId);
    if (request.master_plan_id !== undefined && request.master_plan_id !== active.planId && request.master_plan_id !== masterId) {
      throw newPermanentError("kernel_adjust_master_plan_mismatch", new Error(`请求期望 ${request.master_plan_id}，active 是 ${active.planId}`));
    }
    const weekRows = await deps.weeklyPlans.listWeeklyPlanWeeks(job.userId, masterId);

    // ③ 事件周偏差检测：周文档（已落库）+ 当周活动（provider 拉取）。
    const eventDoc = await weeklyDocOf(deps.weeklyDocs, job.userId, request.event_week_start);
    if (eventDoc === null) {
      throw newPermanentError("kernel_adjust_event_week_missing", new Error(`事件周 ${request.event_week_start} 无已落库周课`));
    }
    const activityRefs = await loadWeekActivityRefs(deps, job.userId, request.event_week_start);
    const deviation: WeekDeviation = assessWeek({ weekDoc: eventDoc, activities: activityRefs });
    if (deviation.class === "within_tolerance") {
      throw newPermanentError("kernel_adjust_no_deviation", new Error(`最新数据显示事件周已恢复正常（${deviation.evidence}），无需调整`));
    }

    // ④ 组装投影输入：existingWeeks=已落库周行+各自 target km（diff 基准）。
    const planStartMonday = typeof active.content.start_date === "string" ? active.content.start_date : null;
    if (planStartMonday === null) {
      throw newPermanentError("kernel_adjust_content_invalid", new Error("content 缺 start_date"));
    }
    const existingWeeks: Array<{ weekStart: string; week: number; km: number }> = [];
    const existingDocs: WeeklyPlan[] = [];
    for (const row of weekRows) {
      const week = weekNumberOf(planStartMonday, row.week_start);
      if (week === null) continue;
      const doc = await weeklyDocOf(deps.weeklyDocs, job.userId, row.week_start);
      existingWeeks.push({ weekStart: row.week_start, week, km: doc?.target_weekly_km_low ?? 0 });
      if (doc !== null) existingDocs.push(doc);
    }
    let master: RollingMasterInput;
    try {
      master = fromStoredContent({
        content: active.content,
        masterPlanId: masterId,
        lastGeneratedWeek: Math.max(...existingWeeks.map((week) => week.week), 0),
      });
    } catch (error) {
      throw newPermanentError("kernel_adjust_content_invalid", error);
    }

    // ⑤ 调整投影（观测 provider/models 心跳，内核逻辑零改动）。
    const observedProvider: MasterPlanContextProvider = {
      loadSnapshot: async (userId, asOf) => {
        await stages.report(STAGE_L1_START);
        const snapshot = await deps.contextProvider.loadSnapshot(userId, asOf);
        await stages.report(STAGE_L3);
        return snapshot;
      },
      loadActivities: async (userId, startDay, endDay) => {
        await stages.report(STAGE_L1_START);
        const activities = await deps.contextProvider.loadActivities(userId, startDay, endDay);
        await stages.report(STAGE_L3);
        return activities;
      },
    };
    const observedModels: Pick<MasterPlanLlmModels, "phasingModel" | "contentModel"> = {
      phasingModel: deps.models.phasingModel,
      contentModel: {
        invoke: async (input, retry) => {
          await stages.report(STAGE_L4);
          return deps.models.contentModel.invoke(input, retry);
        },
      },
    };
    const outcome = await (deps.projection ?? runAdjustProjection)(
      { contextProvider: observedProvider, models: observedModels },
      {
        userId: job.userId,
        master,
        asOf: request.as_of ?? new Date().toISOString(),
        deviation,
        reason: request.reason as AskReason,
        existingWeeks,
        existingDocs,
      },
    );
    if (outcome.decision === "infeasible") {
      throw newPermanentError("kernel_adjust_infeasible", new Error(`${outcome.reason}；failedChecks=${JSON.stringify(outcome.failedChecks)}`));
    }
    if (outcome.decision === "no_op") {
      return { result: JSON.stringify({ decision: "no_op", reason: outcome.reason }) };
    }

    // ⑥ 落 payload（mp 轮询恢复即出方案）：已有 pending 行=回填；夜检
    // create_pending 无行=upsert 建行（payload=投影产物；事件已关闭 409 降级
    // no-op 成功——用户答过的事件永不重问）。
    await stages.report(STAGE_OUTPUT);
    const payload = JSON.stringify({
      reason: outcome.reason,
      window: { start_week: outcome.window.startWeek, end_week: outcome.window.endWeek },
      weekly_docs: outcome.weeklyDocs,
      diff: outcome.diff.map((row) => ({ week: row.week, old_km: row.oldKm, new_km: row.newKm })),
      evidence: outcome.evidence,
      audit_summary: outcome.audit.summary,
    });
    let adjustmentId: string;
    let created = false;
    if (pending !== null) {
      await deps.weeklyPlans.completeAdjustmentPayload(job.userId, pending.id, request.reason, payload);
      adjustmentId = pending.id;
    } else {
      try {
        const row = await deps.weeklyPlans.upsertAdjustment(job.userId, {
          masterPlanId: masterId,
          eventWeekStart: request.event_week_start,
          reason: request.reason,
          question: ADJUST_PENDING_QUESTION,
          payload,
        });
        adjustmentId = row.id;
        created = true;
      } catch (error) {
        if (error instanceof AdjustmentEventClosedError) {
          return { result: JSON.stringify({ decision: "no_op", reason: "调整事件已关闭（用户已答过），不重复建提案" }) };
        }
        throw error;
      }
    }
    return {
      result: JSON.stringify({
        decision: "completed",
        adjustment_id: adjustmentId,
        ...(created ? { created_pending: true } : {}),
        reason: outcome.reason,
        window: outcome.window,
        diff: outcome.diff,
        audit_summary: outcome.audit.summary,
        generated_by: "plan-job",
      }),
    };
  };
}

/** 事件周活动 → ActivityRef（detect 层输入；跑步行过滤同 test_deviation 口径）。 */
async function loadWeekActivityRefs(deps: AdjustHandlerDeps, userId: string, weekStart: string): Promise<ActivityRef[]> {
  const [year, month, day] = weekStart.split("-").map(Number);
  const sunday = new Date(Date.UTC(year!, month! - 1, day! + 6)).toISOString().slice(0, 10);
  const activities = await deps.contextProvider.loadActivities(userId, weekStart, sunday);
  return activities
    .filter((activity) => activity.distanceM != null && activity.distanceM > 2000)
    .map((activity) => {
      const km = (activity.distanceM ?? 0) / 1000;
      return {
        day: activity.shanghaiDay,
        name: activity.name ?? "(未命名)",
        distanceKm: Math.round(km * 100) / 100,
        durationS: activity.durationS ?? 0,
        avgPaceSKm: activity.durationS != null && km > 0 ? Math.round((activity.durationS / km) * 10) / 10 : null,
        sessionClass: activity.strideSessionClass ?? null,
      };
    });
}

function weekNumberOf(planStartMonday: string, weekStart: string): number | null {
  const week = Math.floor((Date.parse(`${weekStart}T00:00:00Z`) - Date.parse(`${planStartMonday}T00:00:00Z`)) / (7 * 86_400_000)) + 1;
  return week >= 1 ? week : null;
}
