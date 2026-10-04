import { randomUUID } from "node:crypto";
import { AIMessage } from "@langchain/core/messages";
import type { GraphNode } from "@langchain/langgraph";
import { getLogger } from "@stride/common";
import { MasterPlanGraphOutcome } from "@stride/contract";
import type { RaceTarget } from "../../data/dataProvider.js";
import type { AgentsState } from "../state.js";
import { masterPlanCardMessage, renderKernelOutcome, renderRequestGap } from "./render.js";
import { buildMasterPlanRequest } from "./request.js";

const logger = getLogger("coachAgent:training");

/**
 * Wall-clock budget for one in-turn kernel run. The kernel's own model calls
 * each carry a `timeout_s` from the coach config; this guards the *sum* (and
 * any silent stall between stream updates) so a pathological turn still
 * answers the athlete instead of hanging the stream. Exceeded → failure copy,
 * never an async job fallback (#427 contract).
 */
const MASTER_KERNEL_TURN_TIMEOUT_MS = 10 * 60_000;

/**
 * Minimal surface of the compiled master-plan graph the node drives (same
 * structural-cast approach as the worker's kernel shim).
 */
export interface TrainingKernel {
  stream(input: unknown, options: { context: { userId: string; generationId: string }; streamMode: readonly string[] }): Promise<AsyncIterable<unknown>>;
}

export interface TrainingNodeDeps {
  kernel: TrainingKernel;
  /** Narrowed to what the node reads; `DataProvider` satisfies this structurally. */
  dataProvider: { getRaceTarget(userId: string): Promise<RaceTarget | null> };
  timeoutMs?: number;
}

/** Kernel nodes that each wrap exactly one LLM call — used to tally `llmCalls`. */
const LLM_NODES = new Set(["assess_goal", "strategy_worker", "judge_worker", "expand_skeleton", "review_worker"]);

export function makeTrainingNode(deps: TrainingNodeDeps): GraphNode<typeof AgentsState> {
  const timeoutMs = deps.timeoutMs ?? MASTER_KERNEL_TURN_TIMEOUT_MS;
  return async (state, config) => {
    if (state.intent?.intent !== "master_plan") {
      // The router only sends master_plan here; anything else means a routing
      // change upstream — answer honestly instead of silently generating.
      return { messages: [new AIMessage("这部分我还在学习中。你可以问我训练相关的问题，或让我为一场比赛制定赛季训练计划。")] };
    }
    const userId = userIdFromRuntime(config) ?? state.userId;
    if (!userId) {
      logger.warn("training node missing userId in runtime context");
      return { messages: [new AIMessage(KERNEL_FAILED_COPY)] };
    }

    const target = await deps.dataProvider.getRaceTarget(userId);
    const built = buildMasterPlanRequest(target, { requestId: `chat-${randomUUID()}`, now: new Date() });
    if (!built.ok) {
      logger.info({ gap: built.gap }, "training node cannot build master-plan request");
      return { messages: [new AIMessage(renderRequestGap(built.gap))] };
    }

    const generationId = randomUUID();
    const startedAt = Date.now();
    const timing: Array<{ node: string; ms: number }> = [];
    let llmCalls = 0;
    let outcomeRaw: unknown = null;

    const timedOut = (elapsedMs: number) => {
      logger.warn({ userId, generationId, elapsedMs, timeoutMs }, "master kernel exceeded in-turn budget; failing the turn");
      logTimingBreakdown(generationId, timing, elapsedMs);
      return { messages: [new AIMessage(KERNEL_TIMEOUT_COPY)], llmCalls };
    };

    try {
      const stream = await deps.kernel.stream({ request: built.request }, { context: { userId, generationId }, streamMode: ["updates"] });
      const iterator = stream[Symbol.asyncIterator]();
      let lastTick = startedAt;
      for (;;) {
        const remaining = timeoutMs - (Date.now() - startedAt);
        if (remaining <= 0) {
          return timedOut(Date.now() - startedAt);
        }
        const next = await withDeadline(iterator.next(), remaining);
        if (next.done) break;
        const chunk = Array.isArray(next.value) ? (next.value[next.value.length - 1] as Record<string, unknown>) : (next.value as Record<string, unknown>);
        if (chunk === null || typeof chunk !== "object") continue;
        for (const [nodeKey, update] of Object.entries(chunk)) {
          if (nodeKey.startsWith("__")) continue;
          const at = Date.now();
          timing.push({ node: nodeKey, ms: at - lastTick });
          lastTick = at;
          if (LLM_NODES.has(nodeKey)) llmCalls += 1;
          if (update !== null && typeof update === "object" && "outcome" in update) {
            outcomeRaw = (update as Record<string, unknown>).outcome;
          }
        }
      }
    } catch (error) {
      if (error instanceof KernelDeadline) {
        return timedOut(Date.now() - startedAt);
      }
      logger.error(
        { err: error instanceof Error ? error : undefined, userId, generationId, elapsedMs: Date.now() - startedAt },
        "master kernel threw inside chat turn",
      );
      logTimingBreakdown(generationId, timing, Date.now() - startedAt);
      return { messages: [new AIMessage(KERNEL_FAILED_COPY)], llmCalls };
    }

    logTimingBreakdown(generationId, timing, Date.now() - startedAt);

    if (outcomeRaw === null) {
      logger.error({ userId, generationId }, "master kernel stream ended without an outcome");
      return { messages: [new AIMessage(KERNEL_FAILED_COPY)], llmCalls };
    }
    const parsed = MasterPlanGraphOutcome.safeParse(outcomeRaw);
    if (!parsed.success) {
      logger.error({ userId, generationId, issues: parsed.error.issues }, "master kernel emitted an unparseable outcome");
      return { messages: [new AIMessage(KERNEL_FAILED_COPY)], llmCalls };
    }
    const outcome = parsed.data;
    if (outcome.decision !== "completed") {
      logger.warn({ userId, generationId, decision: outcome.decision }, "master kernel finished without a plan");
      return { messages: [new AIMessage(renderKernelOutcome(outcome))], llmCalls };
    }
    // completed：markdown 摘要正文 + `master-plan` 卡片信封（#428）。信封挂
    // 消息自身随 checkpoint 持久化，done/历史投影按消息读取，跨设备重进免费。
    return { messages: [masterPlanCardMessage(outcome.artifact.plan, outcome.artifact.simulation_report)], llmCalls };
  };
}

const KERNEL_FAILED_COPY = "这次训练计划生成没能完成，请稍后再试一次。";
const KERNEL_TIMEOUT_COPY = "这次训练计划生成用时超出了限制，已停止。请稍后再试一次。";

/** Rejected by `withDeadline` when the budget runs out before the chunk lands. */
class KernelDeadline extends Error {}

/** Race a pending chunk against the remaining wall-clock budget (silent-stall guard). */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new KernelDeadline()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** userId rides the per-turn runtime context (same source the coach tools read). */
function userIdFromRuntime(config: unknown): string | undefined {
  if (config === null || typeof config !== "object") return undefined;
  const context = (config as { context?: unknown }).context;
  if (context === null || typeof context !== "object") return undefined;
  const userId = (context as { userId?: unknown }).userId;
  return typeof userId === "string" && userId.length > 0 ? userId : undefined;
}

/**
 * One aggregated latency line per turn — the tracer bullet's deliverable
 * (#433 measures off these logs; failed runs log it too, their breakdown is
 * often the most valuable). Arrival-gap attribution: fan-out nodes are
 * credited the wall time until their update lands, which is exactly the
 * stage-latency the athlete experiences.
 */
function logTimingBreakdown(generationId: string, timing: Array<{ node: string; ms: number }>, totalMs: number): void {
  if (timing.length === 0) return;
  const perNode: Record<string, number> = {};
  for (const { node, ms } of timing) {
    perNode[node] = (perNode[node] ?? 0) + ms;
  }
  logger.info({ generationId, totalMs, perNode }, "master kernel stage timing");
}
