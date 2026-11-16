import { createHash } from "node:crypto";
import { tool } from "@langchain/core/tools";
import type { ModelConfig } from "@stride/common";
import { z } from "zod/v4";
import { FlashRuntime } from "./agentRuntime.js";
import { ProfileAgentSession } from "./agentSession.js";
import { profileAgentTools } from "./agentTools.js";
import { ProfileAssembly, ReviewSchema } from "./assembly.js";
import { briefEntry, buildDeterministic } from "./deterministic.js";
import { DimensionId, dimensions, WorkerId } from "./dimensions.js";
import { Explorations } from "./exploration.js";
import { assertSameReviewHistory, loadHistory } from "./history.js";
import { activityHabits, blockMeasurements } from "./measurements.js";
import type { Profile, Snapshot } from "./types.js";
import { runningEvidence } from "./types.js";

const MASTER_PROMPT = `你是训练画像master，统一汇总固定代码结果、专项子Agent探索和已审阅历史认识，形成真实、有用、可追溯的十维画像。
一级维度和信息性质分别标记；同一维度可以有事实、观察、偏好、目标、约束、感受、估计或关联。运动记录习惯不能自动变成本人偏好；用户感受不等于客观能力。代码执行不自动证明统计方法正确，固定统计和Agent自编计算的形成方式必须保留。
先了解输入的固定结果和历史目录，调用explore_dimension完成所有plannedWorkers。子Agent可并行运行，宿主限并发3；code-only维度不浪费Agent调用。question给研究问题与复核重点，不预写结论。子Agent失败或无发现也要记录状态，不能装作没有资料。每个子Agent允许一次revise=true、有具体反馈的重做。
通过inspect_profile_entries逐条检查所有有效旧认识，特别是温度线索：本轮未提到或没重新发现都不是撤销理由。必须保留原支持程度和适用条件；待复核可以pending_review，保持可追溯。已失效来源由宿主屏蔽。旧认识可retain/update/merge/withdraw，但每条都要明确处置；merge指向同维度同性质的保留条目，update/withdraw必须引用你独立执行的verify_profile_calculation成功receipt。没有新证据不能丢失或升级历史关联。
对子Agent候选逐项include/exclude并写原因。固定代码条目和原文不可重写数值。汇总不机械拼接：查反例是否真正改变结论、检查筛选分母/单位/日期、每条planningUse是否越过证据；发现错误，要求专项子Agent修订或排除，不能仅加免责声明。通过inspect_calculation查看原代码/样本/反例；至少用verify_profile_calculation独立复算一个关键结果后才能提交。
重点防止：用标签当实际强度、同日全当同课、从没记录推没训练、把运动学相关推成技术处方、从一次测试推心理或能力上限、从排除负荷解释推旅行/高原因果、把历史安排固定成未来可用日。现有能力基线和负荷只引用既有结果，不新增平行基线算法。当前伤病限制和目标尊重来源与时间。
完成后submit_profile_review，候选correction允许你显式修订标题/正文/用途/条件及引用来源，必须填写已成功的validationReceiptIds和实际sourceIds，并保留原报告与形成过程。固定代码条目不可改。若复算不同，必须correction修正文案或exclude，不能只在reason写正确数字却放行错误正文。优先用verify_predefined_measurement检验分段和行为统计。
完成后candidates覆盖全部当前子Agent条目，prior覆盖全部有效旧条目，不能漏项。highlights选择最多10条最有个人价值的保留条目，允许引用代码结果。summary简述认识变化，未知/资料缺口放覆盖报告，不用不确定说明填画像。画像不生成或应用训练计划，不产未经验证的精确修正系数。`;

export async function generateProfile(
  snapshot: Snapshot,
  config: ModelConfig,
  previous: Profile | Profile[] | null,
  record: (event: unknown) => Promise<void>,
  reuse?: { profile: Profile; analysis: unknown; feedback: string; sourceRun: string },
) {
  if (config.model !== "deepseek-flash") throw new Error("Training profile POC tests may only use deepseek-flash");
  const started = performance.now(),
    history = loadHistory(previous ? (Array.isArray(previous) ? previous : [previous]) : [], snapshot);
  const computed = buildDeterministic(snapshot);
  const runtime = new FlashRuntime(config, record, AbortSignal.timeout(20 * 60 * 1000));
  const workers = new Explorations(snapshot, computed.entries, history, runtime);
  if (reuse) {
    if (reuse.profile.userId !== snapshot.userId || reuse.profile.inputHash !== createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"))
      throw new Error("Review reuse must match the same user and exact input snapshot");
    assertSameReviewHistory(reuse.analysis, history);
    workers.restoreFinished(reuse.analysis);
  }
  const validation = new ProfileAgentSession(snapshot, (event) => record({ agent: "master", event }), "master");
  const assembly = new ProfileAssembly(snapshot, computed.entries, history, workers, validation);
  const tools = [
    tool(
      async ({ topic, minimumDistanceKm }) => {
        const result = topic === "activity_habits" ? activityHabits(snapshot) : blockMeasurements(snapshot, minimumDistanceKm ?? 25);
        validation.fixedEvidenceUses++;
        return validation.receipt({
          hypothesisId: null,
          purpose: "validation",
          question: `Fixed verification: ${topic}`,
          code: `fixed:${topic}-unrounded-v1`,
          inputRead: true,
          sourceIds: runningEvidence(snapshot).map((e) => e.id),
          result,
        });
      },
      {
        name: "verify_predefined_measurement",
        description:
          "用已测试固定代码验证训练时段/同日间隔，或首末10km/真实等距离半程/末5km。仅canonical跑步，分段至少3、最大5km且覆盖完整；真实累计距离边界、分类前不round；间隔按开始+时长估计。保留排除和方法口径。minimumDistanceKm在block时≥20，habits可null。",
        schema: z.object({ topic: z.enum(["activity_habits", "distance_blocks"]), minimumDistanceKm: z.number().min(20).nullable() }),
      },
    ),
    tool(({ worker, question, revise }) => workers.launch(worker, question, revise), {
      name: "explore_dimension",
      description: "启动指定专项子Agent。plannedWorkers需全部处理；revise=false首轮，true需具体纠错反馈、最多再跑一次。只用同一个Flash配置，返回结构化报告。",
      schema: z.object({ worker: WorkerId, question: z.string().min(10), revise: z.boolean() }),
    }),
    tool(({ ids }) => ids.map((id) => assembly.inspect(id)), {
      name: "inspect_profile_entries",
      description: "读取候选或历史条目的原始内容、支持程度、来源与方法；所有有效历史都必须逐条检查。",
      schema: z.object({ ids: z.array(z.string()).min(1).max(15) }),
    }),
    tool(
      ({ agentId, receiptId }) => {
        const session =
          agentId === "master" ? validation : [...workers.reports.values(), ...workers.archived].find((r) => r.session.agentId === agentId)?.session;
        const receipt = session?.receipts.get(receiptId);
        if (!receipt) throw new Error("Unknown agent/receipt");
        return { ...receipt, sourceIds: receipt.sourceIds.slice(0, 15), dependencySourceCount: receipt.sourceIds.length };
      },
      {
        name: "inspect_calculation",
        description: "检查指定Agent的计算代码、实际结果与反例。receipt编号在各Agent内唯一，须同时指定agentId，例如response-1。",
        schema: z.object({ agentId: z.string(), receiptId: z.string() }),
      },
    ),
    tool(({ question, code }) => validation.calculate({ hypothesisId: null, purpose: "validation", question, code }), {
      name: "verify_profile_calculation",
      description: "master独立写JS复算关键事实/反证，不由子Agent口头保证。必须读取sources并返回方法、数值、样本与反例。返回receiptId用于旧认识更新/撤销。",
      schema: z.object({ question: z.string().min(5), code: z.string().min(5) }),
    }),
    ...profileAgentTools(validation, null).filter((t) => ["describe_training_data", "read_training_data", "read_activity_detail"].includes(t.name)),
    tool(
      async (review) => {
        const result = assembly.submit(review);
        await record({ type: "master_review", review, result });
        return result;
      },
      {
        name: "submit_profile_review",
        description: "提交所有旧认识处置、全部当前候选取舍与亮点条目ID；只引用已有条目，不改写固定统计。缺少探索/历史检查/独立复算/处置会拒绝。",
        schema: ReviewSchema,
      },
    ),
  ];
  await record({
    type: "run_start",
    model: config.model,
    parameters: { maxOutputTokens: config.max_tokens, reasoningEffort: config.reasoning_effort },
    inputSources: snapshot.evidence.filter((e) => e.active).length,
    priorEntries: history.length,
    computedEntries: computed.entries.length,
    plannedWorkers: workers.planned,
    reusedExplorationFrom: reuse?.sourceRun ?? null,
  });
  try {
    await runtime.run(
      "master",
      validation,
      tools,
      MASTER_PROMPT,
      JSON.stringify({
        dimensions,
        plannedWorkers: workers.planned,
        reviewFeedback: reuse?.feedback ?? null,
        savedReports: reuse ? [...workers.reports.values()].map((r) => workers.brief(r)) : null,
        taskMode: reuse ? "review-only: workers are complete; correct or exclude saved candidates without new exploration" : "full-run",
        computed: computed.entries.map(briefEntry),
        history: history.map((p) =>
          p.valid && p.conclusion
            ? { id: p.id, title: p.conclusion.title, support: p.conclusion.support, previousDimension: p.conclusion.dimension }
            : { id: p.id, protected: true },
        ),
        task: "按十维分类，代码结果直接使用，探索委派专项Agent。汇总前检查每条旧认识和新候选、独立复算，再提交。",
      }),
      () => assembly.profile !== null,
      24,
    );
  } catch (error) {
    await record({ type: "run_failure", error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  const profile = assembly.profile;
  if (!profile) throw new Error("Master did not submit a profile");
  const reports = [...workers.reports.values()];
  const sessions = [validation, ...reports.map((r) => r.session), ...workers.archived.map((r) => r.session)];
  const coverage = Object.entries(dimensions).map(([id, title]) => ({
    dimensionId: id,
    title,
    entries: profile.conclusions.filter((c) => c.metadata?.dimensionId === id).length,
    codeEntries: computed.entries.filter((c) => c.metadata?.dimensionId === id).length,
    relevantWorkers: reports
      .filter((r) => r.session.allowedDimensions.includes(DimensionId.parse(id)))
      .map((r) => ({ worker: r.worker, status: r.status, error: r.error ?? null })),
  }));
  return {
    profile,
    analysis: {
      computed,
      history: history.map((p) => ({ id: p.id, valid: p.valid, method: p.method, conclusion: p.valid ? p.conclusion : undefined })),
      coverage,
      workers: [...reports, ...workers.archived].map((r) => ({
        ...workers.brief(r),
        entries: r.entries,
        hypotheses: [...r.session.hypotheses.values()],
        revisions: r.session.revisions,
        receipts: [...r.session.receipts.values()],
      })),
      master: { receipts: [...validation.receipts.values()] },
    },
    metrics: {
      durationMs: Math.round(performance.now() - started),
      model: config.model,
      parameters: { maxOutputTokens: config.max_tokens, reasoningEffort: config.reasoning_effort, timeoutSeconds: config.timeout_s },
      modelCalls: runtime.attemptedCalls,
      successfulModelCalls: runtime.calls.length,
      failedModelCalls: runtime.failures,
      calculationCalls: sessions.reduce((n, s) => n + s.executedCalculations, 0),
      fixedEvidenceUses: sessions.reduce((n, s) => n + s.fixedEvidenceUses, 0),
      reusedCalculations: sessions.reduce((n, s) => n + s.reusedCalculations, 0),
      usage: runtime.calls.reduce(
        (n, c) => ({
          input_tokens: n.input_tokens + c.inputTokens,
          output_tokens: n.output_tokens + c.outputTokens,
          total_tokens: n.total_tokens + c.totalTokens,
        }),
        { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      ),
      calls: runtime.calls,
      monetaryCost: null,
      generatedEntries: profile.conclusions.length,
      childFailures: reports.filter((r) => r.status === "failed").length,
      childAttempts: reports.length + workers.archived.length,
      reusedExplorationFrom: reuse?.sourceRun ?? null,
      contentReview: "pending",
    },
  };
}
