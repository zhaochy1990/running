import { AIMessage, type BaseMessage, SystemMessage } from "@langchain/core/messages";
import type { GraphNode } from "@langchain/langgraph";
import { getLogger } from "@stride/common";
import { addDays } from "@stride/contract";
import { z } from "zod/v4";
import type { DaySessionRow } from "../../data/dataProvider.js";
import type { AgentsState } from "../state.js";
import { type WorkoutOpCardData, workoutOpCardMessage } from "./render.js";

const logger = getLogger("coachAgent:workout_manage");

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 模型 JSON-mode 输出会把不适用的可选字段显式置 null（devops#741：DeepSeek delete 分支
 * 必带 "new_date": null），z.string().optional() 只容 undefined/缺键、拒收 JSON null。
 * null 与缺键同义：剥掉再校验，下游 !== undefined 语义与三道硬防线保持不动。
 */
const nullAsMissingString = z.preprocess((value) => (value === null ? undefined : value), z.string().optional());

/** 决策单次 LLM 调用的输出（JSON mode + 本地 zod 硬校验，对齐 orchestrator 修复后模式）。 */
const WorkoutManageDecisionSchema = z.object({
  action: z.enum(["delete", "move", "unclear"]),
  workout_id: nullAsMissingString,
  new_date: nullAsMissingString,
  reply: nullAsMissingString,
});
type WorkoutManageDecision = z.infer<typeof WorkoutManageDecisionSchema>;

/**
 * 决策提示（导出供单测锁定关键规则：workout_id 只能取自列表、改内容不是本节点职责）。
 * 已存课列表与今天日期在调用点拼进 SystemMessage。
 */
export const WORKOUT_MANAGE_PROMPT = `你是 STRIDE 跑步教练的课表管理助手。用户想删除或改期一节已保存的训练课，你根据对话与系统消息里的已存课列表，判断用户指的是哪节课、想做什么操作。

规则：
1. 只输出一个 JSON 对象（不要 Markdown）：{"action": "delete" | "move" | "unclear", "workout_id": "...", "new_date": "YYYY-MM-DD", "reply": "..."}。
   - delete：用户想删除某节课，workout_id 取自已存课列表，reply 一句中文确认话术。
   - move：用户想把某节课挪到新日期，workout_id 取自列表，new_date 是目标日期（相对日期如「明天」「周五」按系统消息给出的今天换算成 YYYY-MM-DD）。
   - unclear：指认不出是哪节课、目标日期缺失或换算不出、或用户意图不明；reply 用中文一句澄清话术（可引导用户报课名或日期）。
2. workout_id 只能来自已存课列表，绝不臆造；列表为空时一律 unclear，并在 reply 里说明近期没有已保存的课。
3. 用户要改的是课表内容（组数/配速/时长）或「改期+改内容」混合请求时，不是本助手职责：输出 unclear，reply 里说明将由建课流程处理。
4. 面向运动员的文本一律中文。`;

/** Minimal surface of the JSON-mode chat model the node drives（buildChatModel 的 ChatOpenAI 满足之）。 */
export interface WorkoutManageModel {
  invoke(messages: BaseMessage[], options?: { response_format?: { type: "json_object" } }): Promise<{ text: string }>;
}

/** 已存课读取（生产由 dataProvider.getPlanSessions 注入）。 */
export type ListSessionsResolver = (userId: string, dateFrom: string, dateTo: string) => Promise<DaySessionRow[]>;

export interface WorkoutManageNodeDeps {
  model: WorkoutManageModel;
  listSessions: ListSessionsResolver;
}

/** 相对今天回看 7 天、前看 14 天的指认窗口（与 custom_workout reissue 注入窗口同宽）。 */
const LOOKBACK_DAYS = 7;
const LOOKAHEAD_DAYS = 14;

/**
 * workout_manage 业务节点（devops#697）：单次 JSON-mode LLM 调用把「删/挪哪节课」
 * 解析成结构化决策，节点侧硬防线兜底——workout_id 必须命中 DB 列表（防幻觉）、
 * new_date 必须是 YYYY-MM-DD、目标必须是自建课（周计划/手表课回复暂不支持）；
 * 未命中或 unclear 一律纯文字澄清（列出现有自建课供指认），绝不凭空执行。命中才
 * 出文字确认 + workout-op 确认卡（执行在客户端 CTA，coach 无写端点）。
 */
export function makeWorkoutManageNode(deps: WorkoutManageNodeDeps): GraphNode<typeof AgentsState> {
  return async (state, config) => {
    if (state.intent?.intent !== "workout_manage") {
      // 只有 workout_manage 意图会路由到本节点；其它 intent 意味着上游路由变更。
      return { messages: [new AIMessage("这部分我还在学习中。你可以告诉我想删除还是改期某一节自建训练课（如「把明天的课删了」）。")] };
    }

    const runtime = (config as { context?: { userId?: unknown; asof?: unknown } } | undefined)?.context;
    const userId = typeof runtime?.userId === "string" ? runtime.userId : null;
    const asof = typeof runtime?.asof === "string" ? runtime.asof : null;
    if (userId === null || asof === null) {
      logger.warn({ hasUserId: userId !== null, hasAsof: asof !== null }, "workout_manage: missing runtime context; failing the turn");
      return { messages: [new AIMessage(TURN_FAILED_COPY)] };
    }

    let rows: DaySessionRow[];
    try {
      rows = await deps.listSessions(userId, addDays(asof, -LOOKBACK_DAYS), addDays(asof, LOOKAHEAD_DAYS));
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error : undefined }, "workout_manage: listing saved sessions failed");
      return { messages: [new AIMessage(TURN_FAILED_COPY)] };
    }

    let decision: WorkoutManageDecision | undefined;
    try {
      const raw = await deps.model.invoke(
        [
          new SystemMessage(
            `${WORKOUT_MANAGE_PROMPT}\n\n今天（Asia/Shanghai 日历日）是 ${asof}。\n\n已存课列表（${addDays(asof, -LOOKBACK_DAYS)} 至 ${addDays(asof, LOOKAHEAD_DAYS)}，含周计划课/自建课/手表课；只有 source=custom 的自建课可删除/改期）：\n${renderModelListing(rows)}`,
          ),
          ...state.messages,
        ],
        { response_format: { type: "json_object" } },
      );
      const parsed = WorkoutManageDecisionSchema.safeParse(JSON.parse(raw.text));
      if (parsed.success) {
        decision = parsed.data;
      } else {
        logger.warn({ issues: parsed.error.issues.length }, "workout_manage: decision off-schema");
      }
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error : undefined }, "workout_manage: decision decode failed; clarifying");
    }
    const llmCalls = { llmCalls: 1 };

    if (decision === undefined || decision.action === "unclear") {
      const lead = decision?.reply?.trim();
      return { messages: [new AIMessage(lead ? `${lead}\n${renderCustomListing(rows)}` : clarifyCopy(rows))], ...llmCalls };
    }

    // 硬防线 1：workout_id 必须命中 DB 列表（模型幻觉 id 一律澄清，绝不执行）。
    const target = decision.workout_id !== undefined ? rows.find((row) => row.workout_id === decision.workout_id) : undefined;
    if (target === undefined) {
      logger.warn({ workout_id: decision.workout_id }, "workout_manage: decision workout_id not in saved list; clarifying");
      return { messages: [new AIMessage(clarifyCopy(rows))], ...llmCalls };
    }

    // 硬防线 2：只支持自建课；周计划课/手表课明确回复暂不支持。
    if (target.source !== "custom") {
      const sourceLabel = target.source === "weekly" ? "周计划课" : "手表同步课";
      return {
        messages: [
          new AIMessage(
            `「${target.name}」（${target.date}）是${sourceLabel}，暂不支持在对话里删除或改期。${target.source === "weekly" ? "调整周计划可以直接说，比如「下周计划周三改成休息」。" : ""}`,
          ),
        ],
        ...llmCalls,
      };
    }

    // 硬防线 3：move 必须带合法 YYYY-MM-DD 目标日期。
    if (decision.action === "move" && (decision.new_date === undefined || !DAY_RE.test(decision.new_date))) {
      logger.warn({ new_date: decision.new_date }, "workout_manage: move without a valid target date; clarifying");
      return {
        messages: [new AIMessage(`想把这节课挪到哪一天？直接告诉我日期（如「挪到周五」或「挪到 ${asof}」）即可。\n${renderCustomListing(rows)}`)],
        ...llmCalls,
      };
    }

    const data: WorkoutOpCardData = {
      op: decision.action,
      workout_id: target.workout_id,
      date: target.date,
      ...(decision.action === "move" && decision.new_date !== undefined ? { new_date: decision.new_date } : {}),
      name: target.name,
      kind: target.kind,
      ...(target.summary !== null ? { summary: target.summary } : {}),
      pushed: target.pushed,
    };
    logger.info({ op: data.op, workout_id: data.workout_id, date: data.date, new_date: data.new_date ?? null }, "workout_manage: confirmation card issued");
    return { messages: [workoutOpCardMessage(data)], ...llmCalls };
  };
}

const TURN_FAILED_COPY = "这次没能处理你的请求，请稍后再试一次。";

/** 模型侧列表：全量行（含 weekly/watch，供指认判断），带 workout_id。 */
function renderModelListing(rows: DaySessionRow[]): string {
  if (rows.length === 0) return "（该窗口内没有任何已保存的训练课）";
  return rows
    .map((row) => {
      const fields = [
        `workout_id=${row.workout_id}`,
        `date=${row.date}`,
        `source=${row.source}`,
        `kind=${row.kind}`,
        `name=${row.name}`,
        row.summary !== null ? `summary=${row.summary}` : null,
        `pushed=${row.pushed ? "yes" : "no"}`,
      ].filter((field): field is string => field !== null);
      return `- ${fields.join(" ")}`;
    })
    .join("\n");
}

/** 用户侧澄清列表：只列可操作的自建课（date/name/summary），供用户指认。 */
function renderCustomListing(rows: DaySessionRow[]): string {
  const custom = rows.filter((row) => row.source === "custom");
  if (custom.length === 0) return "目前（近 7 天至未来 14 天）没有已保存的自建训练课。";
  const listing = custom.map((row) => `- ${row.date}「${row.name}」${row.summary !== null ? `：${row.summary}` : ""}`).join("\n");
  return `已保存的自建课：\n${listing}`;
}

/** 澄清兜底文案（决策解析失败 / 幻觉 id 未指定模型话术时）。 */
function clarifyCopy(rows: DaySessionRow[]): string {
  return `我还不能确定你指的是哪节课或想怎么调整。\n${renderCustomListing(rows)}`;
}
