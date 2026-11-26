import {
  DataProviderMasterPlanContextProvider,
  type MasterPlanContextProvider,
  MasterPlanGraphRequest,
  type MasterPlanLlmModels,
  type RunnerSnapshotSchema,
  runRollingProjection,
} from "@stride/coach-agent";
import { RollingJobRequest, shanghaiDay, type WeeklyPlan } from "@stride/contract";
import { asPermanent, newPermanentError } from "../job/errors.js";
import type { Heartbeat } from "../job/ports.js";
import { type MasterPlanGraphShim, runMasterKernel } from "../kernel/master/kernel.js";
import { type RollingHandlerDeps, runRollingJob } from "../kernel/rolling/handler.js";
import type { ExecutionInput, GenerateResult } from "./protocol.js";
import { SnapshotDataProvider, type SnapshotNotCoveredError } from "./snapshotDataProvider.js";

export interface GenerateDeps {
  /** 被测版本的图装配：LLM 模型取自本镜像的 coach 配置，上下文取自只读快照 Provider。 */
  buildGraph(contextProvider: MasterPlanContextProvider, models: MasterPlanLlmModels): MasterPlanGraphShim;
  buildModels(): MasterPlanLlmModels;
  /** 与生产 handler 相同的投影测试缝，镜像装配不传。 */
  rollingProjection?: RollingHandlerDeps["projection"];
}

const failed = (code: string, message: string): GenerateResult => ({ kind: "failed", error: { code, message } });

/**
 * 对一条冻结输入执行 Generate：装配只读快照 Provider → 跑本镜像的 master / rolling kernel →
 * 产出 `{type:"master_plan", plan, weekly_docs}` 原文，或结构化错误。错误分三类：
 * 快照/请求不合约（执行输入不兼容）、快照未覆盖被读取的数据（具体缺口）、kernel 的
 * 非完成终态（沿用它自己的稳定错误码）。
 */
export async function generateArtifact(input: ExecutionInput, deps: GenerateDeps, hb: Heartbeat): Promise<GenerateResult> {
  let snapshot: ReturnType<typeof RunnerSnapshotSchema.parse>;
  let request: MasterPlanGraphRequest | RollingJobRequest;
  try {
    snapshot = SnapshotDataProvider.parse(input.snapshot);
    if (shanghaiDay(input.as_of) !== snapshot.as_of_day) throw new Error("as_of must match snapshot.as_of_day");
    if (snapshot.as_of !== undefined && Date.parse(snapshot.as_of) !== Date.parse(input.as_of)) throw new Error("as_of must match snapshot.as_of");
    if (input.artifact_type === "weekly_plan_batch") {
      request = RollingJobRequest.parse(input.request);
      if (request.as_of !== undefined && Date.parse(request.as_of) !== Date.parse(input.as_of)) throw new Error("request.as_of differs from frozen as_of");
      request = { ...request, as_of: input.as_of };
      if (snapshot.generation_kind === "new_season") throw new Error("rolling requires a rolling snapshot");
    } else {
      const masterRequest = MasterPlanGraphRequest.parse(input.request);
      if (masterRequest.requested_as_of !== undefined && Date.parse(masterRequest.requested_as_of) !== Date.parse(input.as_of))
        throw new Error("request.requested_as_of differs from frozen as_of");
      request = { ...masterRequest, requested_as_of: input.as_of };
      if (snapshot.generation_kind !== "new_season") throw new Error("master_plan requires a new_season snapshot");
    }
  } catch (error) {
    return failed("execution_input_invalid", describe(error));
  }
  const userId = snapshot.records.profile?.userId ?? snapshot.snapshot_id;
  const notCovered: SnapshotNotCoveredError[] = [];
  const provider = new SnapshotDataProvider(snapshot, userId, input.as_of, (error) => notCovered.push(error));
  try {
    const contextProvider = new DataProviderMasterPlanContextProvider(provider);
    const models = deps.buildModels();
    if (input.artifact_type === "weekly_plan_batch") {
      const result = await generateRolling(request as RollingJobRequest, provider, contextProvider, snapshot, deps, hb, models);
      if (notCovered[0] !== undefined) return failed(notCovered[0].code, notCovered[0].message);
      return result;
    }
    const modelErrors: { content?: string; phasing?: string } = {};
    const modelViolations: { content?: string; phasing?: string } = {};
    const observedModels: MasterPlanLlmModels = {
      ...models,
      contentModel: {
        invoke: async (input, retry) => {
          if (retry !== undefined) modelViolations.content = retry.violations.join("; ").slice(0, 500);
          delete modelErrors.content;
          try {
            return await models.contentModel.invoke(input, retry);
          } catch (error) {
            modelErrors.content = describe(error).slice(0, 500);
            throw error;
          }
        },
      },
      // shortcut: phasing 仅暴露重试违规，内核提供终轮诊断时改为终轮明细。
      phasingModel: {
        invoke: async (input, retry) => {
          if (retry !== undefined) modelViolations.phasing = retry.violations.join("; ").slice(0, 500);
          delete modelErrors.phasing;
          try {
            return await models.phasingModel.invoke(input, retry);
          } catch (error) {
            modelErrors.phasing = describe(error).slice(0, 500);
            throw error;
          }
        },
      },
    };
    const result = await runMasterKernel(
      deps.buildGraph(contextProvider, observedModels),
      request as MasterPlanGraphRequest,
      { userId, generationId: `plan-eval-${input.as_of}` },
      hb,
    );
    if (notCovered[0] !== undefined) return failed(notCovered[0].code, notCovered[0].message);
    const fallback = result.warnings.filter((warning) => warning === "content_template_fallback" || warning === "policy_fallback_to_table");
    if (fallback.length > 0)
      return failed(
        "model_generation_failed",
        `master kernel exhausted model retries: ${fallback
          .map((warning) => {
            const stage = warning === "content_template_fallback" ? "content" : "phasing";
            return `${stage}: ${modelErrors[stage] ?? modelViolations[stage] ?? "model output failed validation"}`;
          })
          .join("; ")}`,
      );
    return {
      kind: "artifact",
      artifact_type: "master_plan",
      content: JSON.stringify({ type: "master_plan", plan: result.plan, weekly_docs: result.weeklyDocs }),
    };
  } catch (error) {
    // 图把取数失败收成 infrastructure_failure；把快照未覆盖的具体缺口补回报告。
    const gap = notCovered.length > 0 ? ` (${notCovered[0]?.message})` : "";
    const permanent = asPermanent(error);
    return failed(notCovered[0]?.code ?? (permanent !== null ? permanent.code : "infrastructure_failure"), `${describe(error)}${gap}`);
  }
}

function describe(error: unknown): string {
  if (error instanceof Error && error.name === "ZodError") return error.message;
  return error instanceof Error ? error.message : String(error);
}

async function generateRolling(
  request: RollingJobRequest,
  provider: SnapshotDataProvider,
  contextProvider: MasterPlanContextProvider,
  snapshot: ReturnType<typeof RunnerSnapshotSchema.parse>,
  deps: GenerateDeps,
  hb: Heartbeat,
  models: RollingHandlerDeps["models"],
): Promise<GenerateResult> {
  const userId = snapshot.records.profile?.userId ?? snapshot.snapshot_id;
  if (snapshot.records.active_master_plan === null)
    return failed("snapshot_not_covered", "getMasterPlanMetadataForDate: records.active_master_plan is missing");
  const rows = snapshot.records.weekly_plan_weeks;
  const docs = snapshot.records.weekly_plans;
  if (rows === undefined || docs === undefined)
    return failed("snapshot_not_covered", "rolling requires records.weekly_plan_weeks and records.weekly_plans (empty collections must be explicit)");
  for (const row of rows) {
    if (!docs.some((doc) => doc.week_start === row.week_start))
      return failed("snapshot_not_covered", `getWeeklyPlan: no complete weekly document for scheduled week ${row.week_start}`);
  }
  let weeklyDocs: WeeklyPlan[] = [];
  const result = await runRollingJob(
    {
      contextProvider,
      models,
      masterPlans: provider,
      weeklyDocs: provider,
      weeklyPlans: {
        listWeeklyPlanWeeks: (user, planId) => provider.listWeeklyPlanWeeks(user, planId),
        // 仅捕获本执行项的产物，不装配 Go API 写入通道。
        batchApplyWeeklyPlans: async (_user, _planId, weeks) => {
          weeklyDocs = weeks as WeeklyPlan[];
          return [];
        },
      },
      projection: async (projectionDeps, input) => {
        const outcome = await (deps.rollingProjection ?? runRollingProjection)(projectionDeps, input);
        if (outcome.decision === "completed" && outcome.scheduled.source === "fallback") {
          const last = outcome.scheduled.attemptsDetail.at(-1);
          throw newPermanentError(
            "model_generation_failed",
            new Error(`rolling model retries exhausted: ${last?.parseError ?? last?.violations.join("; ") ?? "template fallback"}`),
          );
        }
        return outcome;
      },
    },
    request,
    userId,
    hb,
  );
  const outcome = JSON.parse(result.result) as {
    decision: string;
    master_plan_id: string;
    window: { start_week: number; end_week: number; mode: string };
    reason: string;
  };
  if (outcome.decision !== "completed") return failed("kernel_rolling_no_op", outcome.reason);
  return {
    kind: "artifact",
    artifact_type: "weekly_plan_batch",
    content: JSON.stringify({
      type: "weekly_plan_batch",
      master_plan_id: outcome.master_plan_id,
      window: {
        ...outcome.window,
        start_week: weeklyDocs[0]?.week_index ?? outcome.window.start_week,
        end_week: weeklyDocs.at(-1)?.week_index ?? outcome.window.end_week,
      },
      weekly_docs: weeklyDocs,
    }),
  };
}
