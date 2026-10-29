import { randomUUID } from "node:crypto";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { GraphNode } from "@langchain/langgraph";
import { getLogger } from "@stride/common";
import { type MasterPlan, MasterPlanLenientDirectResponseSchema, normalizeRunWorkout } from "@stride/contract";
import { normalizeMessageContent } from "../messages.js";
import type { AgentsState } from "../state.js";
import { assertWeeksLinkedToPhases, masterPlanToContent } from "./content.js";
import { masterPlanCardMessage } from "./render.js";

const logger = getLogger("coachAgent:training");

/**
 * Wall-clock budget for one in-turn master-plan generation. Each inner model
 * call carries its own `timeout_s`; this guards the *sum* so a pathological
 * turn still answers the athlete instead of hanging the stream. Exceeded →
 * failure copy, never an async job fallback (#427 contract).
 */
const MASTER_PLAN_TURN_TIMEOUT_MS = 10 * 60_000;

/** Minimal surface of the inner generate-master-plan agent the node drives. */
export interface TrainingAgent {
  invoke(input: unknown, config?: unknown): Promise<{ messages: BaseMessage[] } & Record<string, unknown>>;
}

/** Resolve the athlete's active race-goal id (the apply content needs a real UUID). */
export type RaceGoalIdResolver = (userId: string) => Promise<string | null>;

export interface TrainingNodeDeps {
  agent: TrainingAgent;
  timeoutMs?: number;
  resolveGoalId?: RaceGoalIdResolver;
}

/**
 * training 业务节点（deepagent 版）：内层 createAgent 生成赛季计划，结构化
 * 信封（return_direct + MasterPlan）经宽松 schema 解析后渲染为 markdown 摘要
 * + master-plan 卡片消息；无信封（目标缺失追问、说明）按普通业务节点写回
 * 文本增量。跨字段确定性质量门暂不启用（临时决策，回归另立票）。
 *
 * #585 apply-from-content：生成不落库。卡片 data 携带完整 v2 content
 * （masterPlanToContent）+ 一次性 apply_token，运动员点「应用」才经 Go
 * 用户端点落库；无 race goal / 变换被拒时整个省略载荷（卡片降级，无 CTA），
 * 绝不打断回复。
 */
export function makeTrainingNode(deps: TrainingNodeDeps): GraphNode<typeof AgentsState> {
  const timeoutMs = deps.timeoutMs ?? MASTER_PLAN_TURN_TIMEOUT_MS;
  return async (state, config) => {
    if (state.intent?.intent !== "master_plan") {
      // The router only sends master_plan here; anything else means a routing
      // change upstream — answer honestly instead of silently generating.
      return { messages: [new AIMessage("这部分我还在学习中。你可以问我训练相关的问题，或让我为一场比赛制定赛季训练计划。")] };
    }

    const startedAt = Date.now();
    let result: { messages: BaseMessage[] } & Record<string, unknown>;
    try {
      result = await withDeadline(deps.agent.invoke({ messages: state.messages }, config), timeoutMs);
    } catch (error) {
      if (error instanceof PlanDeadline) {
        logger.warn({ elapsedMs: Date.now() - startedAt, timeoutMs }, "master-plan generation exceeded in-turn budget; failing the turn");
        return { messages: [new AIMessage(GENERATION_TIMEOUT_COPY)] };
      }
      logger.error({ err: error instanceof Error ? error : undefined, elapsedMs: Date.now() - startedAt }, "master-plan agent threw inside chat turn");
      return { messages: [new AIMessage(GENERATION_FAILED_COPY)] };
    }

    const plan = extractMasterPlan(result) ?? leakedPlanFromText(result, state);
    if (plan !== undefined) {
      logger.info({ elapsedMs: Date.now() - startedAt, totalWeeks: plan.total_weeks }, "master plan generated in-turn");
      const payload = await buildApplyPayload(deps.resolveGoalId, plan, config);
      // markdown 摘要正文 + `master-plan` 卡片信封（#428）。信封挂消息自身随
      // checkpoint 持久化，done/历史投影按消息读取，跨设备重进免费。
      return { messages: [masterPlanCardMessage(plan, payload)] };
    }
    // 无信封：目标缺失追问或说明类回复，按普通业务节点写回增量——agent 的
    // 工具调用轨迹（含 ToolStrategy 伪调用）留在节点内，不进入会话历史。
    // 数组 content 归一化为字符串再入会话历史（devops#833）。
    return { messages: result.messages.slice(state.messages.length).map(normalizeMessageContent) };
  };
}

const GENERATION_FAILED_COPY = "这次训练计划生成没能完成，请稍后再试一次。";
const GENERATION_TIMEOUT_COPY = "这次训练计划生成用时超出了限制，已停止。请稍后再试一次。";

/**
 * #585 apply 载荷构建（fail-soft）：userId 从 runtime context 读（与内层工具
 * 同源），race goal 经注入的 resolver 查；任何失败（无 userId / 无 goal /
 * 变换被拒）都返回 undefined——卡片降级为无 apply 载荷，不影响回复。
 */
async function buildApplyPayload(
  resolveGoalId: RaceGoalIdResolver | undefined,
  plan: MasterPlan,
  config: unknown,
): Promise<{ content: Record<string, unknown>; applyToken: string } | undefined> {
  const userId = (config as { context?: { userId?: unknown } } | undefined)?.context?.userId;
  if (resolveGoalId === undefined || typeof userId !== "string" || userId.length === 0) {
    logger.warn("master-plan apply payload skipped: no resolver or no userId in runtime context; card degrades without apply CTA");
    return undefined;
  }
  try {
    const goalId = await resolveGoalId(userId);
    if (goalId === null) {
      logger.info({ userId }, "master-plan apply payload skipped: no active race goal");
      return undefined;
    }
    const content = masterPlanToContent(plan, goalId);
    assertWeeksLinkedToPhases(plan, content);
    return { content, applyToken: randomUUID() };
  } catch (error) {
    logger.warn({ err: error instanceof Error ? error : undefined, userId }, "master-plan apply payload rejected; card degrades without apply CTA");
    return undefined;
  }
}

/** Rejected by `withDeadline` when the budget runs out before the turn lands. */
class PlanDeadline extends Error {}

/** Race the generation against the wall-clock budget. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PlanDeadline()), ms);
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

/**
 * 从内层 agent 的返回里取结构化信封（与 race_strategy 同模式）。信封已在
 * ToolStrategy 解析层按宽松 schema 校验；此处 safeParse 是防御性二次确认。
 * 结构化输出未产生（目标缺失追问、说明）时返回 undefined。
 */
/**
 * lenient→normalize→strict：聊天侧宽松信封里的 workout_structure 经
 * normalizeRunWorkout 补默认（note/hr_cap_bpm:null 等），得到严格 MasterPlan。
 */
function normalizeMasterPlanWorkouts(content: ReturnType<typeof MasterPlanLenientDirectResponseSchema.parse>["content"]): MasterPlan {
  return {
    ...content,
    weeks: content.weeks.map((week) => ({
      ...week,
      key_sessions: week.key_sessions.map((session) => ({
        ...session,
        workout_structure: session.workout_structure ? normalizeRunWorkout(session.workout_structure) : session.workout_structure,
      })),
    })),
  };
}

/**
 * 从内层 agent 的返回里取结构化信封（与 race_strategy 同模式）。信封已在
 * ToolStrategy 解析层按宽松 schema 校验；此处 safeParse 是防御性二次确认。
 * 结构化输出未产生（目标缺失追问、说明）时返回 undefined。
 */
function extractMasterPlan(result: Record<string, unknown>): MasterPlan | undefined {
  const structured = result.structuredResponse;
  if (typeof structured !== "object" || structured === null) return undefined;
  const envelope = MasterPlanLenientDirectResponseSchema.safeParse(structured);
  return envelope.success ? normalizeMasterPlanWorkouts(envelope.data.content) : undefined;
}

/**
 * 防御性信封解析：模型偶发不守 ToolStrategy 格式、把信封 JSON 当正文文本输
 * 出（弱模型上 race_strategy 已观察到同款行为）。只对形似信封的文本尝试，
 * 解析失败按普通回复透传，绝不臆造。
 */
function leakedPlanFromText(result: { messages: BaseMessage[] }, state: { messages: BaseMessage[] }): MasterPlan | undefined {
  const delta = result.messages.slice(state.messages.length);
  for (let index = delta.length - 1; index >= 0; index -= 1) {
    const message = delta[index];
    if (message === undefined || message.getType() !== "ai" || typeof message.content !== "string") continue;
    const unfenced = message.content
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?```\s*$/, "")
      .trim();
    if (!unfenced.startsWith('{"disposition"')) continue;
    try {
      const envelope = MasterPlanLenientDirectResponseSchema.safeParse(JSON.parse(unfenced));
      if (envelope.success) {
        logger.warn({ preview: message.content.slice(0, 120) }, "master-plan envelope leaked as plain text; recovered by defensive parse");
        return normalizeMasterPlanWorkouts(envelope.data.content);
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
