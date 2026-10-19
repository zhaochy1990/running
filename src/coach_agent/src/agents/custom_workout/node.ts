import { randomUUID } from "node:crypto";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { GraphNode } from "@langchain/langgraph";
import { getLogger } from "@stride/common";
import { type CustomWorkoutCard, workoutTotals } from "@stride/contract";
import { estimatePlannedRunLoad } from "../../graph/training_load/plannedRunLoad.js";
import type { AgentsState } from "../state.js";
import {
  customWorkoutCardMessage,
  extractCustomWorkoutDraft,
  leakedCustomWorkoutFromText,
  type NormalizedCustomWorkoutDraft,
} from "./render.js";

const logger = getLogger("coachAgent:custom_workout");

/**
 * Wall-clock budget for one in-turn custom-workout parse. Each inner model call
 * carries its own `timeout_s`; this guards the *sum* so a pathological turn
 * still answers the athlete instead of hanging the stream（对齐 training 节点）。
 * 单课解析远轻于赛季生成，预算收窄到 5 分钟。
 */
const CUSTOM_WORKOUT_TURN_TIMEOUT_MS = 5 * 60_000;

/** Minimal surface of the inner custom-workout agent the node drives. */
export interface CustomWorkoutAgent {
  invoke(input: unknown, config?: unknown): Promise<{ messages: BaseMessage[] } & Record<string, unknown>>;
}

/** 校准读取（estimatePlannedRunLoad 的确定性 dose 输入）；缺数据返回 null。 */
export type CalibrationResolver = (
  userId: string,
  asof: string,
) => Promise<{ thresholdSpeedMps: number | null; thresholdHr: number | null; rhrBaseline: number | null } | null>;

export interface CustomWorkoutNodeDeps {
  agent: CustomWorkoutAgent;
  resolveCalibration?: CalibrationResolver;
  timeoutMs?: number;
}

/**
 * custom_workout 业务节点（devops#587）：内层 agent 解析自然语言课表，结构化
 * 信封（return_direct + 草稿）经宽松 schema 解析、normalize 后由节点确定性补
 * 齐卡片标量（save_token=randomUUID、totals=workoutTotals、
 * dose=estimatePlannedRunLoad（未校准→null）），渲染 markdown + custom-workout
 * 卡片消息。无信封（缺日期/缺结构追问、说明）按普通业务节点写回文本增量。
 * 泄漏防御 + 超时兜底对齐 training / race_strategy 节点模式。
 */
export function makeCustomWorkoutNode(deps: CustomWorkoutNodeDeps): GraphNode<typeof AgentsState> {
  const timeoutMs = deps.timeoutMs ?? CUSTOM_WORKOUT_TURN_TIMEOUT_MS;
  return async (state, config) => {
    if (state.intent?.intent !== "custom_workout") {
      // The router only sends custom_workout here; anything else means a routing
      // change upstream — answer honestly instead of silently generating.
      return {
        messages: [new AIMessage("这部分我还在学习中。你可以描述一节具体的训练课（如「明天 3 组 4km，配速 350-400，组间休息 3 分钟」），我来帮你建成课表。")],
      };
    }

    const startedAt = Date.now();
    let result: { messages: BaseMessage[] } & Record<string, unknown>;
    try {
      result = await withDeadline(deps.agent.invoke({ messages: state.messages }, config), timeoutMs);
    } catch (error) {
      if (error instanceof WorkoutDeadline) {
        logger.warn({ elapsedMs: Date.now() - startedAt, timeoutMs }, "custom-workout parse exceeded in-turn budget; failing the turn");
        return { messages: [new AIMessage(PARSE_TIMEOUT_COPY)] };
      }
      logger.error({ err: error instanceof Error ? error : undefined, elapsedMs: Date.now() - startedAt }, "custom-workout agent threw inside chat turn");
      return { messages: [new AIMessage(PARSE_FAILED_COPY)] };
    }

    const draft = extractCustomWorkoutDraft(result) ?? leakedCustomWorkoutFromText(result, state);
    if (draft !== undefined) {
      const card = await buildCard(deps.resolveCalibration, draft, config);
      logger.info({ elapsedMs: Date.now() - startedAt, date: card.date }, "custom workout parsed in-turn");
      return { messages: [customWorkoutCardMessage(card)] };
    }
    // 无信封：缺日期/缺结构的中文追问或说明，按普通业务节点写回增量——agent
    // 的工具调用轨迹（含 ToolStrategy 伪调用）留在节点内，不进入会话历史。
    return { messages: result.messages.slice(state.messages.length) };
  };
}

const PARSE_FAILED_COPY = "这节课表没能解析成功，请换个说法再试一次。";
const PARSE_TIMEOUT_COPY = "这节课表解析用时超出了限制，已停止。请稍后再试一次。";

/**
 * 卡片组装（fail-soft）：save_token/totals 由节点确定性补齐；dose 依赖校准，
 * 查询失败或未校准一律 null——不阻塞出卡，缺的只是负荷数字。
 */
async function buildCard(
  resolveCalibration: CalibrationResolver | undefined,
  draft: NormalizedCustomWorkoutDraft,
  config: unknown,
): Promise<CustomWorkoutCard> {
  const totals = workoutTotals(draft.spec);
  const runtime = (config as { context?: { userId?: unknown; asof?: unknown } } | undefined)?.context;
  let dose: number | null = null;
  if (resolveCalibration && typeof runtime?.userId === "string" && typeof runtime?.asof === "string") {
    try {
      const calibration = await resolveCalibration(runtime.userId, runtime.asof);
      const thresholdSpeed = calibration?.thresholdSpeedMps;
      const estimate =
        thresholdSpeed !== null && thresholdSpeed !== undefined && thresholdSpeed > 0
          ? estimatePlannedRunLoad(draft.spec, thresholdSpeed, calibration?.thresholdHr ?? null, calibration?.rhrBaseline ?? null)
          : null;
      dose = estimate === null ? null : Math.round(estimate.expectedDose);
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error : undefined }, "custom-workout dose estimation failed; card keeps estimated_dose null");
    }
  } else if (resolveCalibration) {
    logger.warn("custom-workout dose skipped: no userId/asof in runtime context; card keeps estimated_dose null");
  }
  const card: CustomWorkoutCard = {
    save_token: randomUUID(),
    date: draft.date,
    name: draft.name,
    summary: draft.summary,
    ...(draft.advice !== undefined ? { advice: draft.advice } : {}),
    total_distance_m: totals.total_distance_m,
    total_duration_s: totals.total_duration_s,
    estimated_dose: dose,
    spec: draft.spec,
  };
  return card;
}

/** Rejected by `withDeadline` when the budget runs out before the turn lands. */
class WorkoutDeadline extends Error {}

/** Race the generation against the wall-clock budget. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new WorkoutDeadline()), ms);
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
