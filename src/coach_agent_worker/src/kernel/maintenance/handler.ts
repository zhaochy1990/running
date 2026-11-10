import {
  type ActiveMasterPlanMetadata,
  buildMaintenanceWeek,
  freezePastSessions,
  fromStoredContent,
  isMaintenanceWeeklyDoc,
  type MasterPlanContextProvider,
  storedWeeklyDocOf,
} from "@stride/coach-agent";
import { addDays, MaintenanceJobRequest, mondayOnOrBefore, shanghaiDay } from "@stride/contract";
import type { RollingWeeklyChannel } from "../../goClient/weeklyPlanClient.js";
import { ERROR_CODES, type Handler, newPermanentError } from "../../job/errors.js";
import type { PlanJob } from "../../job/model.js";
import { rollingMasterIdOf, snapshotLastGeneratedWeek } from "../rolling/handler.js";

/**
 * #858 PR-D 伤病维持课 worker handler（`generate_maintenance`，零 LLM）：
 *
 * 读 active injury state（Go 内部端点）→ mode=reduced 才出课（rest/pending_doctor
 * 或已恢复无行=no_op）→ 目标周=当前周（本周已有维持行→顺延下一周）→ 维持周量
 * 重估（见下方公式）→ buildMaintenanceWeek 确定性构造 → batch-apply 落库（同
 * rolling 链）→ 经内部端点回写 state.maintenance_km（单值锚）。
 *
 * maintenance_km 单一真源取舍（票面 #858 Q14 倾向）：Go 只存值，重估全在 TS——
 * checkin better 不在 Go ×1.1（避免双轨抬量），回抬收敛到本 handler 的
 * `clamp(min(state×1.05, 近2完整周实际均值×1.1), 伤前骨架km×0.5, 伤前骨架km×0.7)`。
 * 夜检每天 enqueue 一次（幂等键含扫描日），回抬节奏=每日重估。
 */
export function createMaintenanceJobHandler(deps: MaintenanceHandlerDeps): Handler {
  return async (job: PlanJob, hb) => {
    let request: MaintenanceJobRequest;
    try {
      request = MaintenanceJobRequest.parse(JSON.parse(job.inputJson));
    } catch (error) {
      throw newPermanentError(ERROR_CODES.CONTRACT_VIOLATION, error);
    }
    const asOfDay = shanghaiDay(request.as_of ?? new Date().toISOString());
    await hb("reading_history", 10);

    // ① active 伤病态：无行（已恢复/从未进入）或非减量模式 → no_op（维持课只服务 reduced）。
    const state = await deps.weeklyPlans.getInjuryState(job.userId);
    if (state === null) {
      return { result: JSON.stringify({ decision: "no_op", reason: "无 active 伤病态（已恢复或从未进入）" }) };
    }
    if (state.mode !== "reduced") {
      return { result: JSON.stringify({ decision: "no_op", reason: `伤病态 mode=${state.mode}，维持课只服务减量模式` }) };
    }

    // ② 读档：active master content（骨架=伤前基准、availability=跑日上限）。
    const active = await deps.masterPlans.getMasterPlanMetadataForDate(job.userId, asOfDay);
    if (active === null || active.status !== "active") {
      throw newPermanentError("kernel_maintenance_no_active_master_plan", new Error("维持课需要 active master plan"));
    }
    const rollingMasterId = rollingMasterIdOf(active.content, active.planId);
    if (request.master_plan_id !== undefined && request.master_plan_id !== active.planId && request.master_plan_id !== rollingMasterId) {
      throw newPermanentError("kernel_maintenance_master_plan_mismatch", new Error(`请求期望 ${request.master_plan_id}，active 是 ${active.planId}`));
    }
    const master = (() => {
      try {
        return fromStoredContent({
          content: active.content,
          masterPlanId: rollingMasterId,
          lastGeneratedWeek: snapshotLastGeneratedWeek(active.content),
        });
      } catch (error) {
        throw newPermanentError("kernel_maintenance_content_invalid", error);
      }
    })();

    // ③ 目标周=当前周；本周已有维持行（coach_notes 含「伤病维持期」标记——可复现
    // 判据）→ 顺延下一周（夜检正常不 enqueue 该场景，此为手动补投/竞态双护栏）。
    const currentWeekMonday = mondayOnOrBefore(asOfDay);
    let targetWeek = currentWeekMonday;
    if (await weekHasMaintenance(deps, job.userId, currentWeekMonday)) {
      targetWeek = addDays(currentWeekMonday, 7);
    }
    const targetWeekNumber = weekNumberOf(master.planStartMonday, targetWeek);
    if (targetWeekNumber === null) {
      throw newPermanentError("kernel_maintenance_week_out_of_plan", new Error(`目标周 ${targetWeek} 早于计划起点 ${master.planStartMonday}`));
    }

    // ④ 维持周量重估：伤前基准=存量骨架该周 km（赛周/再生周 km=0 或越出骨架时
    // 回退到最近一个正量周——维持期量带必须为正）；锚=近 2 完整周实际均值与
    // state.maintenance_km 取小起步（V1 简化公式，见文件头）。
    const skeletonWeeks = master.skeleton.weeks.filter((row) => row.km > 0).sort((a, b) => a.week - b.week);
    const skeletonWeek = skeletonWeeks.find((row) => row.week === targetWeekNumber) ?? skeletonWeeks.at(-1);
    if (skeletonWeek === undefined) {
      throw newPermanentError("kernel_maintenance_skeleton_empty", new Error("存量骨架无正量周"));
    }
    const preInjuryKm = skeletonWeek.km;
    const actualAvgKm = await recentActualAvgKm(deps, job.userId, currentWeekMonday);
    const startKm = state.maintenance_km ?? preInjuryKm * 0.6; // 进入减量缺省锚=伤前 60%（票面口径）
    const maintenanceKm = r1(clamp(Math.min(startKm * 1.05, actualAvgKm * 1.1), preInjuryKm * 0.5, preInjuryKm * 0.7));

    // ⑤ 确定性构造（零 LLM）+ 已过日期冻结（同 rolling 链口径）。
    await hb("planning_phases", 60);
    const strengthPerWeek =
      typeof (active.content.availability as Record<string, unknown> | undefined)?.strength_sessions_per_week === "number"
        ? ((active.content.availability as Record<string, unknown>).strength_sessions_per_week as number)
        : 2; // availability 未落库力量频次时缺省 2（力量保留，票面口径）
    const built = buildMaintenanceWeek({
      planStartMonday: master.planStartMonday,
      weekStart: targetWeek,
      weeklyRunDaysMax: master.availability.weeklyRunDaysMax,
      maintenanceKm,
      strengthPerWeek,
      phaseGoalNote: `伤前骨架第 ${targetWeekNumber} 周（${skeletonWeek.role}）${r1(preInjuryKm)}km，维持带 ${r1(preInjuryKm * 0.5)}-${r1(preInjuryKm * 0.7)}km`,
    });
    const [doc] = freezePastSessions([built], asOfDay);

    // ⑥ 落库（同 master_plan 周期望替换 revision+1）+ 回写单值锚。
    await hb("outputting", 95);
    const applied = await deps.weeklyPlans.batchApplyWeeklyPlans(job.userId, rollingMasterId, [doc]);
    const updatedState = await deps.weeklyPlans.updateInjuryMaintenance(job.userId, maintenanceKm);
    return {
      result: JSON.stringify({
        decision: "completed",
        master_plan_id: rollingMasterId,
        week_start: targetWeek,
        week_index: targetWeekNumber,
        maintenance_km: maintenanceKm,
        pre_injury_km: r1(preInjuryKm),
        recent_actual_avg_km: r1(actualAvgKm),
        start_km: r1(startKm),
        needs_verdict: updatedState.needs_verdict,
        weekly_weeks: applied.map((row) => ({ week_start: row.week_start, revision: row.revision, replaced: row.replaced })),
        generated_by: "plan-job",
      }),
    };
  };
}

/** 维持 job 的 master 存量读档面（MySqlDataProvider 满足，测试注入 fake）。 */
export interface MaintenanceMasterPlanSource {
  getMasterPlanMetadataForDate(userId: string, day: string): Promise<ActiveMasterPlanMetadata | null>;
}

/** 周文档读面（本周维持行判定用；MySqlDataProvider 满足）。 */
export interface MaintenanceWeeklyDocSource {
  getWeeklyPlan(userId: string, weekStart: string): Promise<unknown | null>;
}

export interface MaintenanceHandlerDeps {
  /** 近 2 完整周实际量取数（与 adjust handler 同一 provider 面）。 */
  contextProvider: Pick<MasterPlanContextProvider, "loadActivities">;
  masterPlans: MaintenanceMasterPlanSource;
  weeklyPlans: RollingWeeklyChannel;
  weeklyDocs: MaintenanceWeeklyDocSource;
}

/** 某周是否已有维持行（周文档 coach_notes 含「伤病维持期」标记；无行/解析失败=false）。 */
async function weekHasMaintenance(deps: MaintenanceHandlerDeps, userId: string, weekStart: string): Promise<boolean> {
  const raw = await deps.weeklyDocs.getWeeklyPlan(userId, weekStart);
  if (raw === null) return false;
  try {
    return isMaintenanceWeeklyDoc(storedWeeklyDocOf(raw, weekStart));
  } catch {
    // 存量行解析失败（老文档缺字段等）按「非维持行」处理——本轮直接覆盖出维持课。
    return false;
  }
}

/** 近 2 完整周（本周一−14 .. 本周一−1）实际跑步均值 km（跑步行过滤同 adjust handler：>2km）。 */
async function recentActualAvgKm(deps: MaintenanceHandlerDeps, userId: string, currentWeekMonday: string): Promise<number> {
  const start = addDays(currentWeekMonday, -14);
  const end = addDays(currentWeekMonday, -1);
  const activities = await deps.contextProvider.loadActivities(userId, start, end);
  const totalKm = activities
    .filter((activity) => activity.distanceM != null && activity.distanceM > 2000)
    .reduce((total, activity) => total + (activity.distanceM ?? 0) / 1000, 0);
  return totalKm / 2;
}

function weekNumberOf(planStartMonday: string, weekStart: string): number | null {
  const week = Math.floor((Date.parse(`${weekStart}T00:00:00Z`) - Date.parse(`${planStartMonday}T00:00:00Z`)) / (7 * 86_400_000)) + 1;
  return week >= 1 ? week : null;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

function r1(x: number): number {
  return Math.round(x * 10) / 10;
}
