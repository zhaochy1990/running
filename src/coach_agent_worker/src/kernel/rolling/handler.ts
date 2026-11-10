import {
  type ActiveMasterPlanMetadata,
  fromStoredContent,
  type RollingDeps,
  type RollingOutcome,
  runRollingProjection,
  type MasterPlanContextProvider,
  type MasterPlanLlmModels,
} from "@stride/coach-agent";
import { RollingJobRequest, type RollingMasterInput, shanghaiDay, type WeeklyPlan } from "@stride/contract";
import { ERROR_CODES, type Handler, newPermanentError } from "../../job/errors.js";
import type { PlanJob } from "../../job/model.js";
import type { Heartbeat } from "../../job/ports.js";
import type { RollingWeeklyChannel, WeeklyPlanAppliedWeek } from "../../goClient/weeklyPlanClient.js";

/** rolling job 的 master 存量读档面（MySqlDataProvider 满足，测试注入 fake）。 */
export interface RollingMasterPlanSource {
  getMasterPlanMetadataForDate(userId: string, day: string): Promise<ActiveMasterPlanMetadata | null>;
}

/** 滚动投影入口签名（=runRollingProjection；测试注入 fake outcome）。 */
export type RollingProjection = (deps: RollingDeps, input: { userId: string; master: RollingMasterInput; asOf: string }) => Promise<RollingOutcome>;

export interface RollingHandlerDeps {
  /** 与 master 图同款 provider（滚动内核新鲜 L1 取数）。 */
  contextProvider: MasterPlanContextProvider;
  /** createMasterPlanLlmModels 的 Pick：滚动不重跑 L2，phasingModel 仅为装配兼容保留。 */
  models: Pick<MasterPlanLlmModels, "phasingModel" | "contentModel">;
  masterPlans: RollingMasterPlanSource;
  weeklyPlans: RollingWeeklyChannel;
  /** 测试缝：缺省=runRollingProjection（生产装配不传）。 */
  projection?: RollingProjection;
}

/** 滚动阶段心跳锚点（沿用 legacy 五值 stage 枚举；L1 取数起点→L1 完成→L4 生成→落库）。 */
const STAGE_READING = { stage: "reading_history", progressPct: 10 };
const STAGE_L1_START = { stage: "evaluating", progressPct: 25 };
const STAGE_L3 = { stage: "planning_phases", progressPct: 45 };
const STAGE_L4 = { stage: "planning_phases", progressPct: 75 };
const STAGE_OUTPUT = { stage: "outputting", progressPct: 95 };

/**
 * 单调心跳护栏：滚动内核是整函数（L1→L4 一次调用），阶段边界靠包 provider/
 * contentModel 观测——L3 展开无注入缝，45 锚点由「L1 数据就绪」承接到 L4 之前。
 */
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
 * `generate_rolling_block` job handler（#858 PR-A）：读用户 active master plan
 * content + 已落库 weekly 周行 → fromStoredContent 组装 RollingMasterInput →
 * runRollingProjection（新鲜 L1 → L3 重展开 → 批窗 → L4 批生成）→ completed 则
 * weeklyDocs 经 Go batch-apply 落库；no_op 成功返回；infeasible = permanent error
 * （带 failedChecks JSON，不重试）。
 */
export function createRollingJobHandler(deps: RollingHandlerDeps): Handler {
  return async (job: PlanJob, hb) => {
    let request: RollingJobRequest;
    try {
      request = RollingJobRequest.parse(JSON.parse(job.inputJson));
    } catch (error) {
      throw newPermanentError(ERROR_CODES.CONTRACT_VIOLATION, error);
    }
    const stages = new StageHeartbeats(hb);
    const asOfDay = shanghaiDay(request.as_of ?? new Date().toISOString());

    // ① 读档：active master plan content + 已落库 weekly 周行。
    await stages.report(STAGE_READING);
    const active = await deps.masterPlans.getMasterPlanMetadataForDate(job.userId, asOfDay);
    if (active === null) {
      throw newPermanentError("kernel_rolling_no_master_plan", new Error(`user ${job.userId} has no master plan covering ${asOfDay}`));
    }
    if (active.status !== "active") {
      throw newPermanentError("kernel_rolling_master_plan_not_active", new Error(`master plan ${active.planId} is ${active.status}, rolling needs the active plan`));
    }
    // 周课归链 id：master job 物化首批时写进 content 的前瞻计划 id；admin apply
    // 后 Go 侧收养同一 id（master_plan.plan_id == weekly 归链 id == content id
    // 三方对齐），apply 前它就是唯一真源。缺省（老 content 无该字段）回退行 id。
    const contentMasterId = typeof active.content.master_plan_id === "string" && active.content.master_plan_id.length > 0 ? active.content.master_plan_id : null;
    const rollingMasterId = contentMasterId ?? active.planId;
    if (request.master_plan_id !== undefined && request.master_plan_id !== active.planId && request.master_plan_id !== rollingMasterId) {
      throw newPermanentError(
        "kernel_rolling_master_plan_mismatch",
        new Error(`request expects master plan ${request.master_plan_id} but the active plan is ${active.planId}`),
      );
    }
    const weekRows = await deps.weeklyPlans.listWeeklyPlanWeeks(job.userId, rollingMasterId);

    // ② 组装存量输入：lastGeneratedWeek = 快照有课周 ∪ 已落库 weekly 行的最大周号。
    let master: RollingMasterInput;
    try {
      master = fromStoredContent({
        content: active.content,
        masterPlanId: rollingMasterId,
        lastGeneratedWeek: Math.max(snapshotLastGeneratedWeek(active.content), weeklyMaxWeek(active.content, weekRows.map((row) => row.week_start))),
      });
    } catch (error) {
      throw newPermanentError("kernel_rolling_content_invalid", error);
    }

    // ③ 滚动投影：provider 包一层观测 L1（开始=evaluating、就绪=进 L3 planning），
    // contentModel 包一层观测 L4；内核逻辑零改动。
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
    const outcome = await (deps.projection ?? runRollingProjection)(
      { contextProvider: observedProvider, models: observedModels },
      { userId: job.userId, master, asOf: request.as_of ?? new Date().toISOString() },
    );

    if (outcome.decision === "infeasible") {
      throw newPermanentError("kernel_rolling_infeasible", new Error(`${outcome.reason}；failedChecks=${JSON.stringify(outcome.failedChecks)}`));
    }
    if (outcome.decision === "no_op") {
      return { result: JSON.stringify({ decision: "no_op", reason: outcome.reason, master_plan_id: rollingMasterId }) };
    }

    // ④ 落库：weeklyDocs 批量进 Go（同 master_plan 周期望替换 revision+1）。
    await stages.report(STAGE_OUTPUT);
    const applied = await applyWeeklyDocs(deps.weeklyPlans, job.userId, rollingMasterId, outcome.weeklyDocs);
    return {
      result: JSON.stringify({
        decision: "completed",
        master_plan_id: rollingMasterId,
        window: { start_week: outcome.window.startWeek, end_week: outcome.window.endWeek, mode: outcome.window.mode },
        reason: outcome.window.reason,
        weekly_weeks: applied.map((row) => ({ week_start: row.week_start, revision: row.revision, replaced: row.replaced })),
        audit_summary: outcome.audit.summary,
        source: outcome.scheduled.source,
        generated_by: "plan-job",
      }),
    };
  };
}

/** 同 master_plan 幂等重投：空批直接跳过（Go 端 400 拒空批）。 */
async function applyWeeklyDocs(channel: RollingWeeklyChannel, userId: string, masterPlanId: string, docs: WeeklyPlan[]): Promise<WeeklyPlanAppliedWeek[]> {
  if (docs.length === 0) return [];
  return channel.batchApplyWeeklyPlans(userId, masterPlanId, docs);
}

/** 快照有课周（key_sessions 非空）的最大周号；全空回退 min(6, total_weeks)（与 fromMasterArtifact 同源语义）。 */
function snapshotLastGeneratedWeek(content: Record<string, unknown>): number {
  const weeks = Array.isArray(content.weeks) ? (content.weeks as Array<Record<string, unknown>>) : [];
  const totalWeeks = typeof content.total_weeks === "number" ? content.total_weeks : 1;
  const generated = weeks
    .map((week) => ({ weekIndex: Number(week.week_index ?? 0), sessions: Array.isArray(week.key_sessions) ? (week.key_sessions as unknown[]) : [] }))
    .filter((week) => week.weekIndex > 0 && week.sessions.length > 0)
    .map((week) => week.weekIndex);
  return generated.length > 0 ? Math.max(...generated) : Math.min(6, totalWeeks);
}

/** 已落库 weekly 周行 → 计划内周号（第 1 周=planStartMonday 那周）；对不上的行忽略。 */
function weeklyMaxWeek(content: Record<string, unknown>, weekStarts: string[]): number {
  const planStartMonday = typeof content.start_date === "string" ? content.start_date : null;
  if (planStartMonday === null || weekStarts.length === 0) return 0;
  const base = Date.parse(`${planStartMonday}T00:00:00Z`);
  const weeks = weekStarts
    .map((weekStart) => Math.floor((Date.parse(`${weekStart}T00:00:00Z`) - base) / (7 * 86_400_000)) + 1)
    .filter((week) => week >= 1);
  return weeks.length > 0 ? Math.max(...weeks) : 0;
}
