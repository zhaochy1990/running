/**
 * Master Plan kernel —— 新拓扑（devops#803 §3，2026-11-08 拍板 breaking 替换）。
 *
 *   initialize → assess_goal → L1_evidence → L2_phasing → L3_load → L4_content
 *              → audit → finalize
 *
 * 老拓扑（strategies 三扇出 → judges 九评审 → expand_skeleton → simulate →
 * rules → validate → reviews 三评审）整体删除：spike 实证九次评审占 9/17 次
 * 调用而收益存疑，确定性质量证据改由 L3 六门 + L4 C/P 门 + danielsAudit 承担。
 * 训练学判断全部住在 phasing/ 里（本文件只做接线与状态搬运，零判断）。
 */
import { END, StateSchema } from "@langchain/langgraph";
import { ModelContractError } from "@stride/common";
import {
  type DanielsAudit,
  DanielsAuditSchema,
  type LoadPlan,
  LoadPlanSchema,
  type MasterPlanAnchor,
  MasterPlanAnchorSchema,
  type MasterPlanGraphOutcome,
  MasterPlanGraphContext,
  MasterPlanGraphOutcome as MasterPlanGraphOutcomeSchema,
  type MasterPlanGraphRequest,
  MasterPlanGraphRequest as MasterPlanGraphRequestSchema,
  type MasterPlan,
  MasterPlanSchema,
  type PhaseDivisionIntent,
  PhaseDivisionIntentSchema,
  addDays,
  planningStartDate,
  shanghaiDay,
} from "@stride/contract";
import { z } from "zod/v4";
import { measureExecutionTimeAsync } from "../../utils/performance.js";
import {
  type AssessmentFacts,
  canonicalizeAssessmentSummary,
  deriveAssessmentFacts,
  type GoalAssessment,
  GoalAssessmentSchema,
  validateAssessmentReferences,
  validateGoalAssessmentTargets,
  withAuthoritativeLevel,
  withBackfilledClaimCitations,
} from "./assessment.js";
import { type ContextSnapshot, ContextSnapshotSchema, type MasterPlanContextProvider } from "./context.js";
import { danielsAudit } from "./phasing/content/danielsAudit.js";
import type { ContentGeneratorInput, ContentWeekRow } from "./phasing/content/doctrine.js";
import { type ContentModel, generateWeekContent, type ScheduledOutcome } from "./phasing/content/generate.js";
import { projectZones } from "./phasing/content/project.js";
import { buildPhaseEvidence, type PhaseEvidence, type PhasingActivityInput } from "./phasing/evidence.js";
import { generatePhaseDivisionIntent, type PhasingModel } from "./phasing/generate.js";
import type { GateCheck } from "./phasing/gates.js";
import { buildWeeklySeries, habitualBaseline } from "./phasing/load/baseline.js";
import { buildLoadPlan } from "./phasing/load/expand.js";
import { infrastructureFailure, logSwallowedFailure, logger, modelFailure, qualityFailure } from "./nodes/shared.js";
import { buildV2Snapshot } from "./v2Snapshot.js";

interface GoalAssessmentModel {
  invoke(input: { request: MasterPlanGraphRequest; snapshot: ContextSnapshot; facts: AssessmentFacts }): Promise<unknown>;
}

export interface MasterPlanGraphDependencies {
  contextProvider: MasterPlanContextProvider;
  goalAssessmentModel: GoalAssessmentModel;
  /** L2 判断层（deepseek-flash 低温 + 结构门 + T 兜底，见 phasing/generate.ts）。 */
  phasingModel: PhasingModel;
  /** L4 内容层（课包生成 + 波浪排位，见 phasing/content/generate.ts）。 */
  contentModel: ContentModel;
  artifactRevision?: number;
}

// Defined in `@stride/common` next to the structured-output contract that raises
// it; re-exported because the master-plan graph's public surface exposes it.
export { ModelContractError };

export const GraphInput = new StateSchema({ request: MasterPlanGraphRequestSchema });
export const GraphOutput = new StateSchema({ outcome: MasterPlanGraphOutcomeSchema });
export const GraphState = new StateSchema({
  request: MasterPlanGraphRequestSchema,
  context: MasterPlanGraphContext.optional(),
  snapshot: ContextSnapshotSchema.optional(),
  activities: z.custom<PhasingActivityInput[]>().optional(),
  facts: z.custom<AssessmentFacts>().optional(),
  goalAssessment: GoalAssessmentSchema.optional(),
  /** L1：证据（含 vdot 锚、habitual 基线、伤退）。 */
  evidence: z.custom<PhaseEvidence>().optional(),
  /** L2：阶段划分意图 + 结构门结果（source=fallback 时是 T 表产物）。 */
  policy: PhaseDivisionIntentSchema.optional(),
  policyChecks: z.custom<GateCheck[]>().optional(),
  policySource: z.enum(["llm", "fallback"]).optional(),
  /** L3：周骨架 + 六门。 */
  skeleton: LoadPlanSchema.optional(),
  /** 生成时点锚（重生成/滚动种子）。 */
  anchor: MasterPlanAnchorSchema.optional(),
  /** L4：给内容层的输入（audit 也要用，故随状态走）。 */
  contentInput: z.custom<ContentGeneratorInput>().optional(),
  scheduled: z.custom<ScheduledOutcome>().optional(),
  /** 丹尼尔斯符合性审计。 */
  audit: DanielsAuditSchema.optional(),
  /** 首期课表快照（v2 形状）。 */
  plan: MasterPlanSchema.optional(),
  artifactRevision: z.int().positive().default(1),
  outcome: MasterPlanGraphOutcomeSchema.optional(),
});

/** 第 1 周周一 + n 周。 */
const weeksBetween = (monday: string, day: string): number =>
  Math.ceil((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${monday}T00:00:00Z`)) / (7 * 86_400_000));

export class MasterPlanNodes {
  constructor(private readonly dependencies: MasterPlanGraphDependencies) {}

  readonly initialize = async (state: typeof GraphState.State, runtime: { context?: MasterPlanGraphContext }) => {
    logger.info("Initialize Coach Agent Graph for request: %s, mode: %s", JSON.stringify(state.request), state.request.requested_mode);
    const request = MasterPlanGraphRequestSchema.parse(state.request);
    const context = MasterPlanGraphContext.parse(runtime.context);
    const artifactRevision = this.dependencies.artifactRevision ?? 1;

    if (request.requested_mode !== "new_season") {
      logger.warn(`Requested mode ${request.requested_mode} is not supported`);
      return {
        context,
        artifactRevision,
        outcome: MasterPlanGraphOutcomeSchema.parse({
          decision: "unsupported",
          request_id: request.request_id,
          generation_id: context.generationId,
          artifact: {
            type: "capability_gap",
            requested_mode: request.requested_mode,
            supported_modes: ["new_season"],
          },
        }),
      };
    }

    // 快照与逐条活动并行取：L1 证据层的月度焦点要逐条活动，snapshot 只有周汇总。
    const asOf = asOfOf(request);
    const windowStart = addDays(planningStartDate(asOf), -210);
    let snapshot: ContextSnapshot;
    let activities: PhasingActivityInput[];
    try {
      const res = await measureExecutionTimeAsync(async () => {
        const [loaded, rows] = await Promise.all([
          this.dependencies.contextProvider.loadSnapshot(context.userId, asOf),
          this.dependencies.contextProvider.loadActivities(context.userId, windowStart, asOf),
        ]);
        return { snapshot: loaded, activities: rows };
      });
      snapshot = res.result.snapshot;
      activities = res.result.activities;
      logger.info(
        `Loaded context snapshot for user ${context.userId} as of ${snapshot.as_of} (${activities.length} activities) in ${res.time.toFixed(2)} ms`,
      );
    } catch (e) {
      logger.error(`Failed to load context snapshot for user ${context.userId}: ${e instanceof Error ? e.message : "unknown error"}`);
      return { context, outcome: infrastructureFailure(request, context, "context_snapshot_unavailable") };
    }

    const safetyReasons = explicitAcuteRestrictions(request, snapshot);
    if (safetyReasons.length > 0) {
      return {
        context,
        snapshot,
        activities,
        outcome: MasterPlanGraphOutcomeSchema.parse({
          decision: "blocked_for_safety",
          request_id: request.request_id,
          generation_id: context.generationId,
          reasons: safetyReasons,
          prerequisites: ["Obtain clinical clearance or an explicit return-to-run restriction update"],
        }),
      };
    }

    const facts = deriveAssessmentFacts(snapshot, request);
    const volume = facts.facts.find((fact) => fact.fact_id === "volume.recent_weekly_km")?.value;
    const frequency = facts.facts.find((fact) => fact.fact_id === "frequency.recent_run_days_per_week")?.value;
    logger.info("recent weekly volume (km): %s", volume);
    logger.info("recent weekly frequency (days): %s", frequency);

    if (typeof volume !== "number" || volume <= 0 || typeof frequency !== "number" || frequency <= 0) {
      return {
        context,
        snapshot,
        activities,
        facts,
        outcome: MasterPlanGraphOutcomeSchema.parse({
          decision: "needs_baseline",
          request_id: request.request_id,
          generation_id: context.generationId,
          artifact: {
            type: "baseline_requirements",
            missing: ["positive recent running volume and frequency"],
            next_steps: ["Record at least two representative running weeks before season planning"],
          },
        }),
      };
    }

    return { context, snapshot, activities, facts, artifactRevision };
  };

  readonly assessGoal = async (state: typeof GraphState.State) => {
    const { request, context } = required(state);
    const snapshot = state.snapshot;
    const facts = state.facts;
    if (snapshot === undefined || facts === undefined) throw new Error("assess_goal: snapshot/facts 缺失（initialize 未铺设）");
    try {
      const assessment = withAuthoritativeLevel(
        withBackfilledClaimCitations(
          canonicalizeAssessmentSummary(
            GoalAssessmentSchema.parse(
              await this.dependencies.goalAssessmentModel.invoke({
                request,
                snapshot,
                facts: facts,
              }),
            ),
          ),
          facts,
        ),
        facts,
      );
      validateAssessmentReferences(assessment, facts);
      validateGoalAssessmentTargets(assessment, request, facts);
      if (assessment.level === "multi_cycle_required")
        return {
          outcome: MasterPlanGraphOutcomeSchema.parse({
            decision: "multi_cycle_required",
            request_id: request.request_id,
            generation_id: context.generationId,
            artifact: {
              type: "multi_cycle_path",
              cycles:
                assessment.multi_cycle_path.length >= 2 ? assessment.multi_cycle_path : ["Develop the required baseline", "Reassess the confirmed target"],
            },
          }),
        };
      if (assessment.level === "unsafe_or_incompatible")
        return {
          outcome: MasterPlanGraphOutcomeSchema.parse({
            decision: "goal_conflict",
            request_id: request.request_id,
            generation_id: context.generationId,
            artifact: {
              type: "goal_options",
              conflicts: assessment.conflicts.length ? assessment.conflicts.map((conflict) => conflict.description) : [assessment.summary],
              options: ["Keep the confirmed A goal as an unplanned aspiration", "Explicitly confirm a compatible planning target"],
            },
          }),
        };
      return { goalAssessment: assessment };
    } catch (error) {
      return { outcome: modelFailure(error, request, context, "goal_assessment_contract_invalid", "assessment_model_unavailable") };
    }
  };

  /** L1：证据（纯函数，零 LLM）。 */
  readonly evidence = (state: typeof GraphState.State) => {
    const { request, context, snapshot, activities } = requiredWithBaseline(state);
    const goal = aGoalOf(request);
    // 判断层教义只验证过「带目标的 FM」（daniels.md）；HM 与完赛目标缺配速锚，
    // 与其用编造的目标糊过去，不如让它带着明确原因失败。
    if (goal.distance !== "FM")
      return { outcome: qualityFailure(request, context, `unsupported_goal_distance:${goal.distance}`) };
    if (goal.target_time === null) return { outcome: qualityFailure(request, context, "unsupported_goal:finish_only") };
    try {
      const phaseEvidence = buildPhaseEvidence(
        snapshot,
        activities,
        {
          raceName: goal.race_name,
          distance: "FM",
          targetTime: goal.target_time,
          weeklyRunDaysMax: request.availability.weekly_run_days_max,
        },
        asOfOf(request),
      );
      if (phaseEvidence.current_capability.vdot === null)
        return { outcome: qualityFailure(request, context, "no_current_capability_vdot") };
      return { evidence: phaseEvidence };
    } catch (error) {
      logSwallowedFailure("evidence", error);
      return { outcome: qualityFailure(request, context, "phase_evidence_invalid") };
    }
  };

  /** L2：阶段划分意图（flash 一次 + 结构门 + T 兜底）。 */
  readonly phasing = async (state: typeof GraphState.State) => {
    const { request, context, evidence } = requiredWithEvidence(state);
    const monday = planningStartDate(asOfOf(request));
    const goal = aGoalOf(request);
    const runwayWeeks = weeksBetween(monday, goal.race_date);
    if (runwayWeeks < MIN_RUNWAY_WEEKS)
      return { outcome: qualityFailure(request, context, `runway_too_short:${runwayWeeks}w`) };
    try {
      const outcome = await generatePhaseDivisionIntent({ evidence, runwayWeeks, raceDate: goal.race_date }, this.dependencies.phasingModel);
      if (outcome.source === "fallback") logger.warn(`policy fell back to the T table for ${request.request_id}`);
      return { policy: outcome.intent, policyChecks: outcome.checks, policySource: outcome.source };
    } catch (error) {
      logSwallowedFailure("phasing", error);
      return { outcome: qualityFailure(request, context, "phasing_failed") };
    }
  };

  /** L3：载荷层（零 LLM），六门任一挂即质量失败。 */
  readonly load = (state: typeof GraphState.State) => {
    const { request, context, policy, activities } = requiredWithPolicy(state);
    const monday = planningStartDate(asOfOf(request));
    const goal = aGoalOf(request);
    const runwayWeeks = weeksBetween(monday, goal.race_date);
    try {
      const series = buildWeeklySeries(activities, asOfOf(request));
      const skeleton = buildLoadPlan({
        intent: policy,
        runwayWeeks,
        baseline: habitualBaseline(series),
        recentWeeksKm: series.weeks.slice(-4).map((week) => week.km),
      });
      const failed = skeleton.checks.filter((check) => !check.pass);
      if (failed.length > 0)
        return { outcome: qualityFailure(request, context, ...failed.map((check) => `load_gate:${check.id}`)) };
      return { skeleton };
    } catch (error) {
      logSwallowedFailure("load", error);
      return { outcome: qualityFailure(request, context, "load_expansion_failed") };
    }
  };

  /** L4：内容层（课包 + 波浪排位，重试环内建，模板兜底在 generate 内部）。 */
  readonly content = async (state: typeof GraphState.State) => {
    const { request, context, evidence, skeleton } = requiredWithSkeleton(state);
    const monday = planningStartDate(asOfOf(request));
    const goal = aGoalOf(request);
    const runwayWeeks = weeksBetween(monday, goal.race_date);
    const vdot = evidence.current_capability.vdot;
    if (vdot === null) return { outcome: qualityFailure(request, context, "no_current_capability_vdot") };
    const targetSec = parseHms(goal.target_time!);
    if (targetSec === null) return { outcome: qualityFailure(request, context, "invalid_target_time") };

    try {
      const projection = projectZones(vdot, targetSec, RACE_DISTANCE_M, runwayWeeks);
      const rows: ContentWeekRow[] = skeleton.weeks.map((week, index) => {
        const projected = projection.weeks[index];
        if (projected === undefined) throw new Error(`projectZones 缺第 ${week.week} 周带`);
        return {
          week: week.week,
          phase: week.canonical,
          role: week.role,
          totalKm: week.km,
          longRunKm: week.lr,
          qualitySessions: week.q,
          qualityFamily: skeleton.strength_policy.find((item) => item.canonical === week.canonical)?.quality_family ?? "",
          zones: projected.zones,
        };
      });
      const contentInput: ContentGeneratorInput = {
        rows,
        athlete: {
          weeklyRunDaysMax: request.availability.weekly_run_days_max,
          weekKm: evidence.habitual.week_km,
          fitness: { ctl: evidence.fitness.ctl, atl: evidence.fitness.atl, form: evidence.fitness.form },
        },
        race: {
          name: goal.race_name,
          date: goal.race_date,
          targetTime: goal.target_time!,
          goalPaceSKm: targetSec / (RACE_DISTANCE_M / 1000),
        },
        planStartMonday: monday,
      };
      const scheduled = await generateWeekContent(contentInput, this.dependencies.contentModel);
      if (scheduled.source === "fallback") logger.warn(`content fell back to the template for ${request.request_id}`);
      return { contentInput, scheduled, anchor: anchorOf(evidence, projection.meta, scheduled) };
    } catch (error) {
      logSwallowedFailure("content", error);
      return { outcome: qualityFailure(request, context, "content_generation_failed") };
    }
  };

  /** 丹尼尔斯符合性审计（纯函数，不重复实现门逻辑，只按原书口径重述+引用）。 */
  readonly audit = (state: typeof GraphState.State) => {
    const { request, context, scheduled, contentInput } = requiredWithScheduled(state);
    try {
      const items = danielsAudit(scheduled, contentInput);
      const count = (verdict: "pass" | "warn" | "fail") => items.filter((item) => item.verdict === verdict).length;
      const audit: DanielsAudit = {
        items,
        summary: { pass: count("pass"), warn: count("warn"), fail: count("fail") },
      };
      // ❌ = 硬校验挂（C/P 门本应已拦）。落到这里说明审计与门不一致，宁可失败也别发出。
      if (audit.summary.fail > 0)
        return {
          audit,
          outcome: qualityFailure(
            request,
            context,
            ...items.filter((item) => item.verdict === "fail").map((item) => `daniels_audit_fail:${item.item}`),
          ),
        };
      return { audit };
    } catch (error) {
      logSwallowedFailure("audit", error);
      return { outcome: qualityFailure(request, context, "daniels_audit_failed") };
    }
  };

  /** 组装首期课表快照 + 政策包，产出 completed。 */
  readonly finalize = (state: typeof GraphState.State) => {
    const { request, context } = required(state);
    const plan = state.plan!;
    const goal = aGoalOf(request);
    if (
      plan.goal.race_name !== goal.race_name ||
      plan.goal.distance !== goal.distance ||
      plan.goal.race_date !== goal.race_date ||
      plan.goal.target_time !== (goal.target_time ?? "finish_only")
    )
      return { outcome: qualityFailure(request, context, "candidate_plan_changed_confirmed_goal") };

    return {
      outcome: MasterPlanGraphOutcomeSchema.parse({
        decision: "completed",
        request_id: request.request_id,
        generation_id: context.generationId,
        artifact: {
          type: "master_plan_draft",
          activation_status: "inactive",
          plan,
          facts: state.facts,
          goal_assessment: state.goalAssessment!,
          policy: state.policy!,
          skeleton: state.skeleton!,
          anchor: state.anchor!,
          audit: state.audit!,
          artifact_revision: state.artifactRevision,
          warnings: warningsOf(state),
        },
      }),
    };
  };

  /** 条件边助手：任何节点返回 outcome 即终止整条链。 */
  readonly stopOr = (next: string) => (state: typeof GraphState.State) => (state.outcome ? END : next);

  /** 快照组装（独立节点，finalize 只做终检）。 */
  readonly snapshotPlan = (state: typeof GraphState.State) => {
    const { request } = required(state);
    try {
      const plan = buildV2Snapshot({
        policy: state.policy!,
        skeleton: state.skeleton!,
        scheduled: state.scheduled!,
        request,
        planStartMonday: planningStartDate(asOfOf(request)),
        generatedAt: generatedAtOf(request),
      });
      return { plan: MasterPlanSchema.parse(plan) };
    } catch (error) {
      logSwallowedFailure("snapshotPlan", error);
      return {
        outcome: qualityFailure(request, state.context!, `v2_snapshot_invalid:${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`),
      };
    }
  };
}

const RACE_DISTANCE_M = 42195;
/** 短于 5 周跑不出丹尼尔斯五阶段（L2 门也会挡，这里早退省一次 LLM 调用）。 */
const MIN_RUNWAY_WEEKS = 5;

/** 生成时点：一律归一到上海日历日（请求里可能带的是完整 ISO instant）。 */
function asOfOf(request: MasterPlanGraphRequest): string {
  return shanghaiDay(request.requested_as_of ?? new Date().toISOString());
}

function aGoalOf(request: MasterPlanGraphRequest) {
  return request.goals.find((item) => item.priority === "A") ?? request.goals[0]!;
}

function parseHms(value: string): number | null {
  const match = /^(\d{1,2}):([0-5]\d):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}

function generatedAtOf(request: MasterPlanGraphRequest): string {
  void request;
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function anchorOf(
  evidence: PhaseEvidence,
  projection: { capped: boolean; residual: number },
  scheduled: ScheduledOutcome,
): MasterPlanAnchor {
  return MasterPlanAnchorSchema.parse({
    as_of: evidence.as_of,
    vdot: evidence.current_capability.vdot,
    vdot_source: `${evidence.current_capability.source}@${evidence.current_capability.source_date ?? evidence.as_of}`,
    seed: { ctl: scheduled.loadMeta.seed.chronic, atl: scheduled.loadMeta.seed.acute },
    coefficient_version: scheduled.loadMeta.coefficient_version,
    projection: { capped: projection.capped, residual: projection.residual },
  });
}

function warningsOf(state: typeof GraphState.State): string[] {
  const warnings: string[] = [];
  if (state.policySource === "fallback") warnings.push("policy_fallback_to_table");
  if (state.scheduled?.source === "fallback") warnings.push("content_template_fallback");
  const policyWarned = (state.policyChecks ?? []).filter((check) => !check.pass).map((check) => `policy_gate:${check.id}`);
  warnings.push(...policyWarned);
  return warnings;
}

// ── 状态访问器（缺前置字段即编程错误，抛而不是静默） ──────────────────────────

function required(state: typeof GraphState.State) {
  return { request: state.request, context: state.context! };
}

function requiredWithBaseline(state: typeof GraphState.State) {
  const { request, context } = required(state);
  return { request, context, snapshot: state.snapshot!, activities: state.activities! };
}

function requiredWithEvidence(state: typeof GraphState.State) {
  const { request, context } = required(state);
  return { request, context, evidence: state.evidence! };
}

function requiredWithPolicy(state: typeof GraphState.State) {
  const { request, context } = required(state);
  return { request, context, policy: state.policy!, activities: state.activities! };
}

function requiredWithSkeleton(state: typeof GraphState.State) {
  const { request, context } = required(state);
  return { request, context, evidence: state.evidence!, skeleton: state.skeleton! };
}

function requiredWithScheduled(state: typeof GraphState.State) {
  const { request, context } = required(state);
  return { request, context, scheduled: state.scheduled!, contentInput: state.contentInput! };
}

function explicitAcuteRestrictions(request: MasterPlanGraphRequest, snapshot: ContextSnapshot): string[] {
  const explicit = /(?:acute|急性|stop running|no running|禁止跑|停跑|non-weight-bearing|不可负重|medical restriction|医生限制)/i;
  return [
    ...request.injury_declarations
      .filter((injury) => injury.kind === "current" && isPositiveRestriction(`${injury.status} ${injury.training_impact}`, explicit))
      .map((injury) => `Current ${injury.body_area} restriction: ${injury.status}; ${injury.training_impact}`),
    ...snapshot.injuries
      .filter((injury) => isPositiveRestriction(injury.status, explicit))
      .map((injury) => `Canonical ${injury.body_area} restriction: ${injury.status}`),
  ];
}

function isPositiveRestriction(text: string, restriction: RegExp): boolean {
  return text
    .split(/[,;，；]|\bbut\b|\bhowever\b|\band\b|但是|并且|而且|且|但/i)
    .some(
      (clause) =>
        restriction.test(clause) &&
        !/(?:no|without|none|not|无|没有|否认)[^,;，；]{0,30}(?:acute|injury|pain|running restriction|restriction|伤|痛|限制)/i.test(clause),
    );
}
