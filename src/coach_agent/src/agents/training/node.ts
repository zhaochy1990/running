import { AIMessage, type BaseMessage, SystemMessage } from "@langchain/core/messages";
import type { GraphNode } from "@langchain/langgraph";
import { getLogger } from "@stride/common";
import {
  MasterPlanFormCardSchema,
  MasterPlanFormEnvelopeSchema,
  type MasterPlanFormCard,
  type MasterPlanFormEnvelope,
  WEEKDAY_VALUES,
} from "@stride/contract";
import { normalizeMessageContent } from "../messages.js";
import type { AgentsState } from "../state.js";
import { TRAINING_FORM_PROMPT } from "../prompts.js";

const logger = getLogger("coachAgent:training");

/**
 * Wall-clock budget for one slot-filling call. The node is a single fast LLM
 * turn (seconds); exceeded → failure copy, never a hang.
 */
const FORM_TURN_TIMEOUT_MS = 90_000;

/** Minimal surface of the fast chat model the node drives. */
export interface TrainingLlm {
  invoke(input: unknown, config?: unknown): Promise<BaseMessage>;
}

/**
 * training 业务节点（#1024 R2/R7）：master_plan 意图的一次快 LLM 槽位补全——
 * 从对话提取备赛意图（比赛/日期/目标/习惯），输出 `master-plan-form` 预填
 * 表单卡。真正的计划生成已出聊天管线：运动员在卡片上确认/修改后由小程序
 * 组装 kernel request 直投 plan-jobs（异步 worker，R1/R3），旧 deepagent
 * 生成器退役（R7）。槽位补全失败/解析不出按普通文本回复，绝不臆造表单。
 */
export function makeTrainingNode(deps: TrainingNodeDeps): GraphNode<typeof AgentsState> {
  const timeoutMs = deps.timeoutMs ?? FORM_TURN_TIMEOUT_MS;
  return async (state, config) => {
    if (state.intent?.intent !== "master_plan") {
      // The router only sends master_plan here; anything else means a routing
      // change upstream — answer honestly instead of silently continuing.
      return { messages: [new AIMessage("这部分我还在学习中。你可以告诉我目标比赛（名称/日期/目标成绩），我来为你制定赛季训练计划。")] };
    }

    const history = state.messages.slice(-12);
    const messages: BaseMessage[] = [new SystemMessage(TRAINING_FORM_PROMPT), ...history];

    let reply: BaseMessage;
    try {
      reply = await withDeadline(deps.llm.invoke(messages, config), timeoutMs);
    } catch (error) {
      if (error instanceof FormDeadline) {
        logger.warn({ timeoutMs }, "training slot-filling exceeded budget; failing the turn");
        return { messages: [new AIMessage(FORM_FAILED_COPY)] };
      }
      logger.error({ err: error instanceof Error ? error : undefined }, "training slot-filling LLM threw inside chat turn");
      return { messages: [new AIMessage(FORM_FAILED_COPY)] };
    }

    const envelope = extractFormEnvelope(reply) ?? envelopeFromText(reply);
    if (envelope === undefined) {
      // 模型没守 JSON 形态：按普通文本回复透传（绝不臆造表单）。
      return { messages: [normalizeMessageContent(reply)] };
    }
    if (envelope.disposition === "clarify") {
      const text = envelope.message?.trim();
      return { messages: [new AIMessage(text && text.length > 0 ? text : FORM_FALLBACK_ASK_COPY)] };
    }

    let form: MasterPlanFormCard;
    try {
      form = normalizeForm(envelope.form ?? {});
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error : undefined }, "training form normalization rejected; replying as text");
      const text = envelope.message?.trim();
      return { messages: [new AIMessage(text && text.length > 0 ? text : FORM_FALLBACK_ASK_COPY)] };
    }
    logger.info({ raceName: form.goal.race_name, raceDate: form.goal.race_date }, "training form card emitted");
    return {
      messages: [
        new AIMessage({
          content:
            "好，我们一起向目标出发。信息我按你的情况先填好了，你确认或改一改，然后点「生成我的训练计划」。",
          additional_kwargs: { card: { $type: "master-plan-form", data: form } },
        }),
      ],
    };
  };
}

const FORM_FAILED_COPY = "这次没能整理好你的目标信息，请稍后再试一次。";
const FORM_FALLBACK_ASK_COPY = "说说你的目标比赛（名称、日期、目标成绩），我来为你制定赛季训练计划。";

/** Minimal surface kept for handler typing parity with the orchestrator wiring. */
export interface TrainingNodeDeps {
  llm: TrainingLlm;
  timeoutMs?: number;
}

/** Rejected by `withDeadline` when the budget runs out before the reply lands. */
class FormDeadline extends Error {}

/** Race the slot-filling call against the wall-clock budget. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new FormDeadline()), ms);
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

/** 模型回复 → 宽松信封。content 用 .text getter 提取——responses API 的
 * AIMessage.content 是 content-parts 数组（devops#833 同坑），手拼字符串段
 * 会得到空串、解析必败、JSON 原样漏给用户。 */
function extractFormEnvelope(reply: BaseMessage): MasterPlanFormEnvelope | undefined {
  const unfenced = reply.text
    .replace(/^```(?:json)?\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();
  if (!unfenced.startsWith("{")) return undefined;
  try {
    const parsed = MasterPlanFormEnvelopeSchema.safeParse(JSON.parse(unfenced));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** 防御性兜底：JSON 混在多段 AI 文本里时从后往前找形似信封的段。 */
function envelopeFromText(reply: BaseMessage): MasterPlanFormEnvelope | undefined {
  for (const line of reply.text.split("\n").reverse()) {
    const trimmed = line.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = MasterPlanFormEnvelopeSchema.safeParse(JSON.parse(trimmed));
      if (parsed.success) {
        logger.warn({ preview: trimmed.slice(0, 120) }, "training form envelope recovered from text line");
        return parsed.data;
      }
      return undefined;
    } catch {
      continue;
    }
  }
  return undefined;
}

const WEEKDAY_ALIASES: Record<string, (typeof WEEKDAY_VALUES)[number]> = {
  monday: "monday", tuesday: "tuesday", wednesday: "wednesday", thursday: "thursday", friday: "friday", saturday: "saturday", sunday: "sunday",
  一: "monday", 二: "tuesday", 三: "wednesday", 四: "thursday", 五: "friday", 六: "saturday", 日: "sunday", 天: "sunday",
  周一: "monday", 周二: "tuesday", 周三: "wednesday", 周四: "thursday", 周五: "friday", 周六: "saturday", 周日: "sunday", 周天: "sunday",
};

/** 中文/别名星期 → 枚举；未知的丢弃。 */
function normalizeWeekdays(input: string[]): (typeof WEEKDAY_VALUES)[number][] {
  const out: (typeof WEEKDAY_VALUES)[number][] = [];
  for (const raw of input) {
    const day = WEEKDAY_ALIASES[raw.trim().toLowerCase()] ?? WEEKDAY_ALIASES[raw.trim()];
    if (day && !out.includes(day)) out.push(day);
  }
  return out;
}

function normalizeLongDay(input: string | undefined): (typeof WEEKDAY_VALUES)[number] | null {
  if (!input) return null;
  return WEEKDAY_ALIASES[input.trim().toLowerCase()] ?? WEEKDAY_ALIASES[input.trim()] ?? null;
}

/** 日期宽松归一：YYYY/M/D、YYYY.MM.DD → YYYY-MM-DD；非法原样返回（表单可改）。 */
function normalizeDate(input: string | undefined): string {
  if (!input) return "";
  const m = input.trim().match(/^(\d{4})[/\-.年](\d{1,2})[/\-.月](\d{1,2})日?$/);
  if (!m) return input.trim();
  return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
}

/** 将 hh:mm 扩展为 h:mm:ss，空串留给运动员填写。 */
function normalizeTarget(input: string | undefined): string {
  if (!input) return "";
  const raw = input.trim();
  if (/^\d{1,2}:[0-5]\d$/.test(raw)) return `${Number(raw.split(":")[0])}:${raw.split(":")[1]}:00`;
  return raw;
}

/** 宽松槽位 → 严格表单卡（schema 校验兜底；失败抛错由调用方按文本透传）。 */
function normalizeForm(form: NonNullable<MasterPlanFormEnvelope["form"]>): MasterPlanFormCard {
  const statedDays = normalizeWeekdays(form.weekly_days ?? []);
  const weeklyDays = statedDays.length > 0 ? statedDays : WEEKDAY_VALUES.slice(0, 5);
  const longRunDay = normalizeLongDay(form.long_run_day);
  const candidate = {
    goal: {
      race_name: (form.race_name ?? "").trim().slice(0, 60),
      distance: form.distance === "HM" ? "HM" : "FM",
      race_date: normalizeDate(form.race_date),
      target_time: normalizeTarget(form.target_time),
    },
    availability: {
      weekly_days: weeklyDays,
      preferred_long_run_day: longRunDay !== null && weeklyDays.includes(longRunDay) ? longRunDay : null,
    },
    base: (form.base ?? "").trim().slice(0, 200),
    restriction: (form.restriction ?? "").trim().slice(0, 200),
  };
  return MasterPlanFormCardSchema.parse(candidate);
}
