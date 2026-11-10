/**
 * #858 PR-C 下半——夜检扫描（rolling-scan）判定与编排。
 *
 * 每个 active v3 master 计划用户两个纯读判定（零 LLM）：
 *   a. 边界/掉队滚动：lastGeneratedWeek = 快照有课周 ∪ Go list 周行（判定函数
 *      与 worker rolling handler 共享单源），computeRollingWindow 非空 →
 *      enqueue `generate_rolling_block`；
 *   b. 偏差检测：最近一个完整周（本周一−7）的 weekly 行 + 当周活动 →
 *      assessWeek 非 within_tolerance → enqueue `generate_adjustment`
 *      （create_pending=true，reason=检测 preselect）。
 *
 * 幂等键含扫描日（yyyyMMdd 上海日）——失败次晚可重投；单用户失败跳过不中断
 * （记入 skipped）。判定函数（judgeUserScan）纯函数、可注入 asOf，dry-run 脚本
 * 与端到端验收复用同一份。
 */
import { randomUUID } from "node:crypto";
import {
  type Activity,
  type ActivityRef,
  type AskReason,
  assessWeek,
  computeRollingWindow,
  currentWeekOf,
  type DeviationClass,
  evaluateRollingWindow,
  fromStoredContent,
  type RollingWindow,
  storedWeeklyDocOf,
} from "@stride/coach-agent";
import { rollingMasterIdOf, snapshotLastGeneratedWeek, type WeeklyPlanWeekRow, weeklyMaxWeek } from "@stride/coach-agent-worker";
import { addDays, mondayOnOrBefore, shanghaiDay, type WeeklyPlan } from "@stride/contract";

/** 枚举面：active v3 master 计划行（content 含 policy 段，只读）。 */
export interface ScanPlanRef {
  userId: string;
  planId: string;
  content: Record<string, unknown>;
}

/** 扫描读面（MySqlDataProvider 结构性满足；测试注入 fake）。 */
export interface RollingScanStore {
  listActiveMasterPlans(): Promise<ScanPlanRef[]>;
  getWeeklyPlan(userId: string, weekStart: string): Promise<unknown | null>;
  getActivitySummariesByDateRange(userId: string, startDay: string, endDay: string): Promise<Activity[]>;
}

/** 单用户判定的只读取数（IO 由编排层完成，判定本身纯函数）。 */
export interface ScanUserContext {
  /** Go 内部 list 的已落库周行（已过滤到本计划归链 id）。 */
  weeklyRows: WeeklyPlanWeekRow[];
  /** 最近完整周的 weekly 行文档（无行=null）。 */
  eventWeekDoc: WeeklyPlan | null;
  /** 最近完整周活动（跑步过滤后）。 */
  eventWeekActivities: ActivityRef[];
}

export type ScanAction =
  | {
      kind: "rolling";
      jobType: "generate_rolling_block";
      idempotencyKey: string;
      input: { request_id: string; master_plan_id: string; as_of: string };
    }
  | {
      kind: "adjust";
      jobType: "generate_adjustment";
      idempotencyKey: string;
      input: { request_id: string; master_plan_id: string; event_week_start: string; reason: AskReason; create_pending: true; as_of: string };
    };

export interface ScanDeviation {
  weekStart: string;
  class: DeviationClass;
  preselect: AskReason | null;
  severe: boolean;
  evidence: string;
  plannedKm: number;
  actualKm: number;
  deliveryRatio: number;
}

export interface ScanDecision {
  masterPlanId: string;
  lastGeneratedWeek: number;
  currentWeek: number;
  /** 最近完整周周一（YYYY-MM-DD）。 */
  eventWeekStart: string;
  rollingWindow: RollingWindow | null;
  /** window=null 时的 no_op 原因（evaluateRollingWindow 同源）。 */
  rollingNote: string;
  deviation: ScanDeviation | null;
  /** deviation=null 时的原因（无周行/早于计划/容忍内）。 */
  deviationNote: string;
  actions: ScanAction[];
}

/**
 * 单用户判定（纯函数）：content/周行/事件周文档+活动 → 是否投滚动批/调整提案。
 * content 解析失败（老 v2 行缺政策段等）抛错，由编排层捕获记入 skipped。
 */
export function judgeUserScan(args: { plan: ScanPlanRef; context: ScanUserContext; asOf: string }): ScanDecision {
  const { plan, context, asOf } = args;
  const masterId = rollingMasterIdOf(plan.content, plan.planId);
  const lastGeneratedWeek = Math.max(
    snapshotLastGeneratedWeek(plan.content),
    weeklyMaxWeek(
      plan.content,
      context.weeklyRows.map((row) => row.week_start),
    ),
  );
  const master = fromStoredContent({ content: plan.content, masterPlanId: masterId, lastGeneratedWeek });
  const asOfDay = shanghaiDay(asOf);
  const scanDay = asOfDay.replaceAll("-", "");
  const currentWeek = currentWeekOf(master.planStartMonday, asOf);
  const actions: ScanAction[] = [];

  // a. 边界/掉队滚动：与 rolling job 同一判定源（evaluateRollingWindow）。
  const windowDecision = evaluateRollingWindow({
    skeleton: master.skeleton,
    planStartMonday: master.planStartMonday,
    asOf,
    lastGeneratedWeek,
  });
  let rollingWindow: RollingWindow | null = null;
  let rollingNote = "";
  if (windowDecision.kind === "window") {
    rollingWindow = windowDecision.window;
    actions.push({
      kind: "rolling",
      jobType: "generate_rolling_block",
      idempotencyKey: `rolling:${plan.userId}:${rollingWindow.startWeek}:${scanDay}`,
      input: { request_id: randomUUID(), master_plan_id: masterId, as_of: asOf },
    });
  } else {
    rollingWindow = null;
    rollingNote = windowDecision.reason;
  }

  // b. 偏差检测：最近一个完整周（本周一−7，该周周日已过完）。
  const eventWeek = addDays(mondayOnOrBefore(asOfDay), -7);
  let deviation: ScanDeviation | null = null;
  let deviationNote = "";
  const eventWeekIndex = Math.floor((Date.parse(`${eventWeek}T00:00:00Z`) - Date.parse(`${master.planStartMonday}T00:00:00Z`)) / (7 * 86_400_000)) + 1;
  if (eventWeekIndex < 1) {
    deviationNote = `最近完整周 ${eventWeek} 早于计划起点 ${master.planStartMonday}，无计划可比`;
  } else if (context.eventWeekDoc === null) {
    deviationNote = `最近完整周 ${eventWeek} 无已落库 weekly 行，跳过偏差检测`;
  } else {
    const assessed = assessWeek({ weekDoc: context.eventWeekDoc, activities: context.eventWeekActivities });
    deviation = {
      weekStart: assessed.weekStart,
      class: assessed.class,
      preselect: assessed.preselect,
      severe: assessed.severe,
      evidence: assessed.evidence,
      plannedKm: assessed.plannedKm,
      actualKm: assessed.actualKm,
      deliveryRatio: assessed.deliveryRatio,
    };
    if (assessed.class === "within_tolerance" || assessed.preselect === null) {
      deviationNote = `${assessed.evidence}（容忍内，不触发调整）`;
    } else {
      actions.push({
        kind: "adjust",
        jobType: "generate_adjustment",
        idempotencyKey: `adjust:${plan.userId}:${eventWeek}:${scanDay}`,
        input: {
          request_id: randomUUID(),
          master_plan_id: masterId,
          event_week_start: eventWeek,
          reason: assessed.preselect,
          create_pending: true,
          as_of: asOf,
        },
      });
    }
  }

  return {
    masterPlanId: masterId,
    lastGeneratedWeek,
    currentWeek,
    eventWeekStart: eventWeek,
    rollingWindow,
    rollingNote,
    deviation,
    deviationNote,
    actions,
  };
}

/** 跑步过滤（test_deviation 同口径：sport 前缀 run 或 sportName 含 run）。 */
export function toScanActivityRefs(activities: Activity[]): ActivityRef[] {
  return activities
    .filter((row) => row.sport?.toLowerCase().startsWith("run") === true || row.sportName?.toLowerCase().includes("run") === true)
    .map((row) => ({
      day: row.shanghaiDay,
      name: row.name ?? "(未命名)",
      distanceKm: Math.round(((row.distanceM ?? 0) / 1000) * 100) / 100,
      durationS: row.durationS ?? 0,
      avgPaceSKm: row.avgPaceSKm ?? null,
      sessionClass: row.strideSessionClass ?? null,
    }));
}

export interface RollingScanSummaryUser {
  user_id: string;
  master_plan_id: string;
  rolling: { window: { start_week: number; end_week: number; mode: string } | null; note: string };
  deviation: { week_start: string; class: string; preselect: string | null; evidence: string } | null;
  deviation_note: string;
  enqueued: string[];
}

export interface RollingScanSummary {
  scanned: number;
  rolling_enqueued: number;
  adjust_enqueued: number;
  skipped: Array<{ user_id: string; reason: string }>;
  users: RollingScanSummaryUser[];
}

export interface RollingScanRunner {
  /** 全量扫描（dispatch=true 投递 job；false=dry-run 只判定）。 */
  runRollingScan(options?: { dispatch?: boolean; asOf?: string }): Promise<RollingScanSummary>;
}

export function createRollingScanRunner(deps: {
  store: RollingScanStore;
  weeklyPlans: Pick<import("@stride/coach-agent-worker").RollingWeeklyChannel, "listWeeklyPlanWeeks">;
  enqueue: (input: {
    userId: string;
    jobType: "generate_rolling_block" | "generate_adjustment";
    inputJson: string;
    idempotencyKey: string;
  }) => Promise<unknown>;
}): RollingScanRunner {
  return {
    async runRollingScan(options = {}) {
      const dispatch = options.dispatch ?? true;
      const asOf = options.asOf ?? new Date().toISOString();
      const asOfDay = shanghaiDay(asOf);
      const eventWeek = addDays(mondayOnOrBefore(asOfDay), -7);
      const summary: RollingScanSummary = { scanned: 0, rolling_enqueued: 0, adjust_enqueued: 0, skipped: [], users: [] };
      const plans = await deps.store.listActiveMasterPlans();
      for (const plan of plans) {
        summary.scanned += 1;
        try {
          const masterId = rollingMasterIdOf(plan.content, plan.planId);
          const weeklyRows = await deps.weeklyPlans.listWeeklyPlanWeeks(plan.userId, masterId);
          const rawDoc = await deps.store.getWeeklyPlan(plan.userId, eventWeek);
          // Go 落库剥掉 schema/week_name——storedWeeklyDocOf 按行身份回填后严格 parse。
          const eventWeekDoc = rawDoc === null ? null : storedWeeklyDocOf(rawDoc, eventWeek);
          const activities = await deps.store.getActivitySummariesByDateRange(plan.userId, eventWeek, addDays(eventWeek, 6));
          const decision = judgeUserScan({
            plan,
            context: { weeklyRows, eventWeekDoc, eventWeekActivities: toScanActivityRefs(activities) },
            asOf,
          });
          const enqueued: string[] = [];
          if (dispatch) {
            for (const action of decision.actions) {
              await deps.enqueue({
                userId: plan.userId,
                jobType: action.jobType,
                inputJson: JSON.stringify(action.input),
                idempotencyKey: action.idempotencyKey,
              });
              enqueued.push(action.idempotencyKey);
              if (action.kind === "rolling") summary.rolling_enqueued += 1;
              else summary.adjust_enqueued += 1;
            }
          }
          summary.users.push({
            user_id: plan.userId,
            master_plan_id: decision.masterPlanId,
            rolling: {
              window:
                decision.rollingWindow === null
                  ? null
                  : { start_week: decision.rollingWindow.startWeek, end_week: decision.rollingWindow.endWeek, mode: decision.rollingWindow.mode },
              note: decision.rollingWindow === null ? decision.rollingNote : decision.rollingWindow.reason,
            },
            deviation:
              decision.deviation === null
                ? null
                : {
                    week_start: decision.deviation.weekStart,
                    class: decision.deviation.class,
                    preselect: decision.deviation.preselect,
                    evidence: decision.deviation.evidence,
                  },
            deviation_note: decision.deviation === null ? decision.deviationNote : "",
            enqueued,
          });
        } catch (error) {
          summary.skipped.push({
            user_id: plan.userId,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return summary;
    },
  };
}

/** 判定一致性断言入口（dry-run 脚本用）：判定输出 vs computeRollingWindow/assessWeek 直调。 */
export function assertDecisionConsistent(decision: ScanDecision, args: { plan: ScanPlanRef; context: ScanUserContext; asOf: string }): boolean {
  const masterId = rollingMasterIdOf(args.plan.content, args.plan.planId);
  const lastGeneratedWeek = Math.max(
    snapshotLastGeneratedWeek(args.plan.content),
    weeklyMaxWeek(
      args.plan.content,
      args.context.weeklyRows.map((row) => row.week_start),
    ),
  );
  const master = fromStoredContent({ content: args.plan.content, masterPlanId: masterId, lastGeneratedWeek });
  const window = computeRollingWindow({ skeleton: master.skeleton, planStartMonday: master.planStartMonday, asOf: args.asOf, lastGeneratedWeek });
  if ((window === null) !== (decision.rollingWindow === null)) return false;
  if (window !== null && decision.rollingWindow !== null && window.startWeek !== decision.rollingWindow.startWeek) return false;
  if (args.context.eventWeekDoc !== null) {
    const assessed = assessWeek({ weekDoc: args.context.eventWeekDoc, activities: args.context.eventWeekActivities });
    if ((assessed.class === "within_tolerance") !== (decision.deviation === null || decision.deviation.class === "within_tolerance")) return false;
    if (decision.deviation !== null && assessed.class !== decision.deviation.class) return false;
  }
  return true;
}
