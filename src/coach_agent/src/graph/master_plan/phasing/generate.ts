import { buildModel, getLogger, type PromptMessage } from "@stride/common";
import type { ModelConfig } from "../../../config/config.js";
import { buildIntentMessages, type PhasingIntentInput } from "./doctrine.js";
import { tableFallback } from "./fallback.js";
import { type GateCheck, gateViolations, validatePhaseIntent } from "./gates.js";
import { type PhaseDivisionIntent, PhaseDivisionIntentSchema } from "./intent.js";

/**
 * 意图层生成编排（devops#782 C/D/E 节）：deepseek-flash 判断 → 确定性结构门
 * 终检 → 违规带清单重试 ≤2 → T 表兜底。不含 kernel/graph 接入（另票）。
 */

const logger = getLogger("coachAgent:phasing");

export interface PhasingModel {
  /** 判断层单次调用；retry 携带上次输出与违规清单（多轮修正）。 */
  invoke(input: PhasingIntentInput, retry?: { previousIntent: unknown; violations: string[] }): Promise<PhaseDivisionIntent>;
}

export interface PhaseDivisionOutcome {
  intent: PhaseDivisionIntent;
  /** llm = 判断层通过结构门；fallback = 重试耗尽/调用失败落 T 表。 */
  source: "llm" | "fallback";
  attempts: number;
  /** 终检结果（fallback 时为其自身门检；构造保证全绿）。 */
  checks: GateCheck[];
}

/** 生产判断层模型：phasing role 的 ModelConfig（deepseek-flash 低温稳定过门，daniels.md §2.3；#810）。 */
export function createPhasingModel(config: ModelConfig): PhasingModel {
  return {
    async invoke(input, retry) {
      const messages: PromptMessage[] = buildIntentMessages(input, retry);
      const runnable = buildModel({
        ...config,
        structured: { schema: PhaseDivisionIntentSchema, name: "submit_phase_intent" },
      });
      return PhaseDivisionIntentSchema.parse(await runnable.invoke(messages));
    },
  };
}

/** 结构门违规重试上限（daniels.md §2.3 拍死 ≤2，加首次共 3 次尝试；调用/解析异常同计数）。 */
const MAX_GATE_RETRIES = 2;

/**
 * 生成入口（纯函数形态，无存储）：输入证据+跑道+目标，输出阶段划分意图。
 * 判断层每次输出都过全部结构门；重试耗尽或调用异常时落 T 表兜底，
 * 兜底构造保证合法（永远有产出）。每次产出打一条 outcome 日志
 * （source 字段）——生产兜底率的观测锚点（#810；Grafana 面板另票）。
 */
export async function generatePhaseDivisionIntent(input: PhasingIntentInput, model: PhasingModel): Promise<PhaseDivisionOutcome> {
  let attempts = 0;
  let lastIntent: unknown;
  let lastViolations: string[] = [];
  for (let round = 0; round <= MAX_GATE_RETRIES; round++) {
    attempts++;
    try {
      const intent = await model.invoke(input, round === 0 ? undefined : { previousIntent: lastIntent, violations: lastViolations });
      const checks = validatePhaseIntent(intent, input.runwayWeeks, input.evidence);
      if (checks.every((c) => c.pass)) {
        logger.info({ source: "llm", attempts, runway_weeks: input.runwayWeeks }, "phase division outcome");
        return { intent, source: "llm", attempts, checks };
      }
      lastIntent = intent;
      lastViolations = gateViolations(checks);
    } catch {
      lastViolations = ["模型调用或契约解析失败，请重新输出完整意图"];
    }
  }
  const fallback = tableFallback(input.evidence, input.runwayWeeks);
  const checks = validatePhaseIntent(fallback, input.runwayWeeks, input.evidence);
  logger.warn({ source: "fallback", attempts, runway_weeks: input.runwayWeeks, violations: lastViolations }, "phase division outcome");
  return { intent: fallback, source: "fallback", attempts, checks };
}
