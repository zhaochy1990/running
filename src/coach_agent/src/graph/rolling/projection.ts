/**
 * 滚动投影主入口（#858 PR-A Round 1）：用户练到存量课表最后生成周时，基于
 * 实际完成数据生成下一块（block=3+1 训练块）课表。
 *
 * 数据流严格对齐 master 图节点（initialize/l1_evidence/load/content/audit 的
 * 取数与构造方式），但**不重跑 L2**——阶段政策（policy）是赛季意图，存量沿用；
 * L3 用新鲜 habitual 基线 + 近 4 实际完成周重展开（rollingSeed，devops#793）；
 * L4 配速全部用新鲜 VDOT（evidence.current_capability.vdot）重算投影带，绝不
 * 沿用存量 anchor 的 vdot。
 */
import {
  addDays,
  type DanielsAudit,
  type LoadPlan,
  type MasterPlanGraphOutcome,
  planningStartDate,
  type RollingMasterInput,
  shanghaiDay,
  type WeeklyPlan,
} from "@stride/contract";
import type { MasterPlanContextProvider } from "../master_plan/context.js";
import type { MasterPlanLlmModels } from "../master_plan/llm/models.js";
import { logger } from "../master_plan/nodes/shared.js";
import { danielsAudit } from "../master_plan/phasing/content/danielsAudit.js";
import { buildProvenSessions, type ContentGeneratorInput, type ContentWeekRow, QUALITY_FAMILY_OF } from "../master_plan/phasing/content/doctrine.js";
import { generateWeekContent, type ScheduledOutcome } from "../master_plan/phasing/content/generate.js";
import { projectZones } from "../master_plan/phasing/content/project.js";
import { buildPhaseEvidence, type PhaseEvidence, type PhasingActivityInput } from "../master_plan/phasing/evidence.js";
import { buildWeeklySeries, habitualBaseline, type WeeklySeries } from "../master_plan/phasing/load/baseline.js";
import { buildLoadPlan } from "../master_plan/phasing/load/expand.js";
import { buildWeeklyDocs, freezePastSessions } from "./weeklyDocs.js";
import { currentWeekOf, evaluateRollingWindow, type RollingWindow } from "./window.js";

/** 全马拉松标准距离（与 master content 节点同源）。 */
const RACE_DISTANCE_M = 42195;
/** 内容层外层重试上限（fallback 后整段再生成，同 master content 节点）。 */
const MAX_OUTER_CONTENT_TRIES = 3;
/** L1 活动回看窗（master initialize 同款：月度焦点 6 个月 + 余量）。 */
const ACTIVITY_LOOKBACK_DAYS = 210;

const r1 = (x: number) => Math.round(x * 10) / 10;

/**
 * 计划前 throughWeek 周的实际完成序列（#858 滚动自适应的 L3 historyKm 来源）：
 * series 周按周一对上计划周（planStartMonday+(w-1)×7）取实际 km；对不上（没跑
 * 的 gap 周 / 超出 28 周回看窗）取 0——没跑就是没跑，不猜。只含**完整周**（调用
 * 方传 currentWeek−1；进行中的当前周半程数据会过度压低 rollMean，不入列）。
 */
export function historyKmOf(series: WeeklySeries, planStartMonday: string, throughWeek: number): number[] {
  const kmOfWeekStart = new Map(series.weeks.map((week) => [week.weekStart, week.km]));
  return Array.from({ length: Math.max(0, throughWeek) }, (_, index) => kmOfWeekStart.get(addDays(planStartMonday, index * 7)) ?? 0);
}

/** "2:50:00" → 秒（master nodes.ts 同款私有助手，两处语义必须一致）。 */
function parseHms(value: string): number | null {
  const match = /^(\d{1,2}):([0-5]\d):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}

export type RollingOutcome =
  | {
      decision: "completed";
      window: RollingWindow;
      /** 重投后的全跑道新骨架（周号与存量 policy 对齐）。 */
      skeletonNew: LoadPlan;
      deviation: Array<{ week: number; newKm: number; baseKm: number; pct: number }>;
      scheduled: ScheduledOutcome;
      weeklyDocs: WeeklyPlan[];
      /** 丹尼尔斯符合性审计原样返回（fail>0 不改 decision——由调用方判定，PR-C 再接偏差通知）。 */
      audit: DanielsAudit;
      evidence: PhaseEvidence;
    }
  | { decision: "no_op"; reason: string }
  | { decision: "infeasible"; reason: string; failedChecks: Array<{ id: string; detail: string }> };

export interface RollingDeps {
  /** 复用 master 的 provider（DataProviderMasterPlanContextProvider / Frozen 测试桩皆可）。 */
  contextProvider: MasterPlanContextProvider;
  /**
   * 对齐 createMasterPlanLlmModels 返回类型（Pick 出滚动用到的两件）——
   * rolling 不重跑 L2，phasingModel 仅为装配兼容保留（当前不调用）。
   */
  models: Pick<MasterPlanLlmModels, "phasingModel" | "contentModel">;
}

export interface RollingProjectionInput {
  /** 取数主体（provider.loadSnapshot/loadActivities 需要）。 */
  userId: string;
  master: RollingMasterInput;
  /** 生成时点（ISO instant 或上海日历日，内部归一）。 */
  asOf: string;
  /** 测试钩子：series 周里程缩放（默认 1）——adaptive 验证用，不进生产。 */
  actualKmScale?: number;
}

/**
 * 滚动投影主入口（纯函数形态，无存储）：新鲜 L1 → L3 重展开 → 批窗 → L4 批
 * 生成 → 审计 → 周课文档。L3 门挂 = infeasible（不模板兜底、不静默）；audit
 * 原样进 outcome（completed 不变，调用方判定 fail 项）。
 */
export async function runRollingProjection(deps: RollingDeps, input: RollingProjectionInput): Promise<RollingOutcome> {
  const { master, userId } = input;
  const asOfDay = shanghaiDay(input.asOf);
  const targetSec = parseHms(master.race.targetTime);
  if (targetSec === null)
    return {
      decision: "infeasible",
      reason: "目标完赛时间不可解析（滚动只支持带时间目标）",
      failedChecks: [{ id: "invalid_target_time", detail: master.race.targetTime }],
    };

  // ① 新鲜 L1（对齐 master initialize/l1_evidence 的取数）：快照 + 逐条活动并行。
  let snapshot: Awaited<ReturnType<MasterPlanContextProvider["loadSnapshot"]>>;
  let activities: PhasingActivityInput[];
  try {
    const windowStart = addDays(planningStartDate(asOfDay), -ACTIVITY_LOOKBACK_DAYS);
    [snapshot, activities] = await Promise.all([
      deps.contextProvider.loadSnapshot(userId, asOfDay),
      deps.contextProvider.loadActivities(userId, windowStart, asOfDay),
    ]);
  } catch (error) {
    return {
      decision: "infeasible",
      reason: "新鲜证据取数失败（snapshot/activities）",
      failedChecks: [{ id: "context_unavailable", detail: error instanceof Error ? error.message : String(error) }],
    };
  }

  let evidence: PhaseEvidence;
  try {
    evidence = buildPhaseEvidence(
      snapshot,
      activities,
      {
        raceName: master.race.name,
        distance: master.race.distance ?? "FM",
        targetTime: master.race.targetTime,
        weeklyRunDaysMax: master.availability.weeklyRunDaysMax,
      },
      asOfDay,
    );
  } catch (error) {
    return {
      decision: "infeasible",
      reason: "阶段证据构造失败（phase_evidence_invalid）",
      failedChecks: [{ id: "phase_evidence_invalid", detail: error instanceof Error ? error.message : String(error) }],
    };
  }
  const vdot = evidence.current_capability.vdot;
  if (vdot === null)
    return {
      decision: "infeasible",
      reason: "新鲜证据无当前能力 VDOT（换算阶梯全档不可用）",
      failedChecks: [{ id: "no_current_capability_vdot", detail: `as_of=${asOfDay}` }],
    };

  // ② L3 滚动种子：近 4 实际完成周 + habitual 基线（actualKmScale 仅测试钩子）。
  const scale = input.actualKmScale ?? 1;
  const series = buildWeeklySeries(activities, asOfDay);
  const baselineRaw = habitualBaseline(series);
  const baseline =
    scale === 1
      ? baselineRaw
      : {
          ...baselineRaw,
          week_km: r1(baselineRaw.week_km * scale),
          avg4_km: r1(baselineRaw.avg4_km * scale),
          pre_peak_km: r1(baselineRaw.pre_peak_km * scale),
        };
  const recentWeeksKm = series.weeks.slice(-4).map((week) => r1(week.km * scale));

  // ②b 历史实际周（#858 自适应链路）：已完成整周（1..currentWeek−1，不含进行中
  // 的当前周）的实际 km 喂给展开器——否则 W1..Wn 的 km 是展开器自建的重建计划
  // 值，到第 5 周 prev4 已被重建值占据、actual4 被完全稀释，批窗周量不随实际
  // 完成度变化。gap 周=0；actualKmScale 同步作用（测试钩子一致性）。
  const currentWeek = currentWeekOf(master.planStartMonday, asOfDay);
  const historyRaw = historyKmOf(series, master.planStartMonday, Math.min(currentWeek - 1, master.totalWeeks));
  const historyKm = historyRaw.length > 0 ? historyRaw.map((km) => r1(km * scale)) : undefined;

  // ③ L3 重展开（存量 policy + 新鲜基线 + 历史实际周）→ 全跑道新骨架；六门挂 = infeasible。
  const skeletonNew = buildLoadPlan({
    intent: master.policy,
    runwayWeeks: master.totalWeeks,
    baseline,
    recentWeeksKm,
    ...(historyKm != null ? { historyKm } : {}),
  });
  const failed = skeletonNew.checks.filter((check) => !check.pass);
  if (failed.length > 0)
    return {
      decision: "infeasible",
      reason: `L3 六门 ${failed.length} 项未过（滚动不模板兜底、不静默）`,
      failedChecks: failed.map((check) => ({ id: check.id, detail: check.detail })),
    };

  // ④ 批窗：无事可做 → no_op。
  const windowDecision = evaluateRollingWindow({
    skeleton: skeletonNew,
    planStartMonday: master.planStartMonday,
    asOf: asOfDay,
    lastGeneratedWeek: master.lastGeneratedWeek,
  });
  if (windowDecision.kind === "no_op") return { decision: "no_op", reason: windowDecision.reason };
  const window = windowDecision.window;

  try {
    // ⑤ 批行构造（master content 节点同款）：新鲜 VDOT 重算投影带。
    const projection = projectZones(vdot, targetSec, RACE_DISTANCE_M, master.totalWeeks);
    const batchWeeks = skeletonNew.weeks.filter((week) => week.week >= window.startWeek && week.week <= window.endWeek);
    const rows: ContentWeekRow[] = batchWeeks.map((week) => {
      const projected = projection.weeks[week.week - 1];
      if (projected === undefined) throw new Error(`projectZones 缺第 ${week.week} 周带`);
      return {
        week: week.week,
        phase: week.canonical,
        role: week.role,
        totalKm: week.km,
        longRunKm: week.lr,
        qualitySessions: week.q,
        qualityFamily: QUALITY_FAMILY_OF[week.canonical] ?? "",
        zones: projected.zones,
      };
    });

    // ⑥ 批输入：运动员/比赛/起点/已证课（#857）同款；PMC 种子=实际当前体能
    // （快照直读），不是首批批链的末端种子。
    const batchInput: ContentGeneratorInput = {
      rows,
      athlete: {
        weeklyRunDaysMax: master.availability.weeklyRunDaysMax,
        weekKm: evidence.habitual.week_km,
        fitness: { ctl: evidence.fitness.ctl, atl: evidence.fitness.atl, form: evidence.fitness.form },
      },
      race: {
        name: master.race.name,
        date: master.race.date,
        targetTime: master.race.targetTime,
        goalPaceSKm: targetSec / (RACE_DISTANCE_M / 1000),
      },
      planStartMonday: master.planStartMonday,
      provenSessions: buildProvenSessions(activities, asOfDay),
    };

    // ⑦ L4 批生成：外层重试 ≤3 同 master（fallback 时 warn 日志保留批产物）。
    const pmcSeed = { acute: evidence.fitness.atl, chronic: evidence.fitness.ctl };
    let scheduled = await generateWeekContent(batchInput, deps.models.contentModel, { pmcSeed });
    for (let outer = 2; outer <= MAX_OUTER_CONTENT_TRIES && scheduled.source === "fallback"; outer++) {
      logger.warn(
        {
          batch: `${window.startWeek}-${window.endWeek}`,
          weeks: rows.map((row) => row.week),
          outer,
          attempts: scheduled.attempts,
          attemptsDetail: scheduled.attemptsDetail,
        },
        `rolling content template fallback — outer regeneration ${outer}/${MAX_OUTER_CONTENT_TRIES}`,
      );
      scheduled = await generateWeekContent(batchInput, deps.models.contentModel, { pmcSeed });
    }
    if (scheduled.source === "fallback")
      logger.warn(
        { batch: `${window.startWeek}-${window.endWeek}`, weeks: rows.map((row) => row.week), attempts: scheduled.attempts },
        `rolling content fell back to the template after ${MAX_OUTER_CONTENT_TRIES} outer tries`,
      );

    // ⑧ 审计：原样进 outcome（fail>0 照录 warn、decision 仍 completed，调用方判定）。
    const items = danielsAudit(scheduled, batchInput);
    const audit: DanielsAudit = {
      items,
      summary: {
        pass: items.filter((item) => item.verdict === "pass").length,
        warn: items.filter((item) => item.verdict === "warn").length,
        fail: items.filter((item) => item.verdict === "fail").length,
      },
    };
    if (audit.summary.fail > 0)
      logger.warn(
        { fail: audit.summary.fail, items: items.filter((item) => item.verdict === "fail").map((item) => item.item) },
        "rolling daniels audit has hard failures (returned as-is, caller decides)",
      );

    // ⑨ 偏差 + 周课文档；⑩ 追赶冻结（批首周=当前周时，已过日期不排课）。
    const deviation = batchWeeks.map((week) => {
      const baseKm = master.skeleton.weeks.find((stored) => stored.week === week.week)?.km ?? 0;
      return { week: week.week, newKm: week.km, baseKm, pct: baseKm > 0 ? r1(((week.km - baseKm) / baseKm) * 100) : 0 };
    });
    let weeklyDocs = buildWeeklyDocs({
      scheduled,
      batchRows: rows,
      policy: master.policy,
      skeletonNew,
      skeletonStored: master.skeleton,
      planStartMonday: master.planStartMonday,
      athlete: { weeklyRunDaysMax: master.availability.weeklyRunDaysMax },
    });
    if (window.mode === "catch_up" && window.startWeek === currentWeek) weeklyDocs = freezePastSessions(weeklyDocs, asOfDay);

    return { decision: "completed", window, skeletonNew, deviation, scheduled, weeklyDocs, audit, evidence };
  } catch (error) {
    return {
      decision: "infeasible",
      reason: "滚动批生成失败（content/snapshot 构造异常）",
      failedChecks: [{ id: "rolling_generation_failed", detail: error instanceof Error ? error.message : String(error) }],
    };
  }
}

/** master completed 产物里的政策包段（fromMasterArtifact 的入参形状）。 */
export type MasterPlanArtifact = Extract<MasterPlanGraphOutcome, { decision: "completed" }>["artifact"];

/**
 * master 图 completed 产物 → RollingMasterInput 适配器：planStartMonday 取 v2
 * 快照 start_date（=第 1 周周一），lastGeneratedWeek 缺省取「有重点课的最大周号」
 * （首批门控 = min(首阶段末周, 6)；纯 E 周也有 LR 重点课，赛周只有比赛课）——
 * 调用方已落库 weekly 行时可显式覆盖。
 */
export function fromMasterArtifact(args: {
  artifact: MasterPlanArtifact;
  availability: { weeklyRunDaysMax: number };
  masterPlanId: string;
  /** 快照周 ∪ 已落库 weekly 行的最大周号（缺省按快照重点课推）。 */
  lastGeneratedWeek?: number;
}): RollingMasterInput {
  const { artifact } = args;
  const generated = artifact.plan.weeks.filter((week) => week.key_sessions.length > 0).map((week) => week.week_index);
  return {
    masterPlanId: args.masterPlanId,
    planStartMonday: artifact.plan.start_date,
    totalWeeks: artifact.plan.total_weeks,
    race: {
      name: artifact.plan.goal.race_name,
      date: artifact.plan.goal.race_date,
      targetTime: artifact.plan.goal.target_time,
      distance: artifact.plan.goal.distance,
    },
    availability: { weeklyRunDaysMax: args.availability.weeklyRunDaysMax },
    policy: artifact.policy,
    skeleton: artifact.skeleton,
    anchor: artifact.anchor,
    lastGeneratedWeek: args.lastGeneratedWeek ?? (generated.length > 0 ? Math.max(...generated) : Math.min(6, artifact.plan.total_weeks)),
  };
}
