/** Bounded race-strategy context tools over the read-only DataProvider (devops#891). */

import { type BaseMessage, ToolMessage } from "@langchain/core/messages";
import type { StructuredTool } from "@langchain/core/tools";
import * as z from "zod";
import type { CoachToolRuntime } from "../agents/coachAgent.js";
import { CoachTargetRef } from "../agents/turnScope.js";
import type { DataProvider } from "../data/dataProvider.js";
import { defineCoachTools } from "./common.js";

/** 服务端确定出的可绑赛事候选（devops#891）：模型只能从这里选，不许凭空造 ID。 */
export interface RaceTargetCandidate {
  race_event_id: number;
  item_type: string;
  name: string;
  race_date: string;
  city: string | null;
}

/** 与 CoachTargetRef 的 race 形态一致的绑定值。 */
export interface CoachRaceTargetRef {
  kind: "race";
  race_event_id: number;
  item_type: string;
}

/**
 * Per-thread race-target 持久化 seam（#891 聊天内绑赛）：由 API 层基于 MySQL 实现。
 * entry-gate 信任边界保持——模型只能 bind 候选集内的 (race_event_id, item_type)，
 * 候选集由服务端从公开赛历确定性检索产生；绑定后由 API 层在续轮自动注入 turn scope。
 */
export interface RaceTargetBindingGateway {
  get(threadId: string): Promise<CoachRaceTargetRef | null>;
  bind(threadId: string, ref: CoachRaceTargetRef): Promise<void>;
  rememberCandidates(threadId: string, candidates: RaceTargetCandidate[]): Promise<void>;
  candidates(threadId: string): Promise<RaceTargetCandidate[] | null>;
}

type RaceTargetContext = { target?: unknown; threadId?: unknown; raceTargetFromThread?: unknown };
const RACE_CONTEXT_TOOL_NAME = "get_race_calendar_context";
const raceContextAnchor = z.object({ found: z.literal(true), race_event_id: z.number(), target_item_type: z.string() });

/** Verify that the strategy used course data for the race and group being attached to the card. */
export function raceStrategyMatchesCourse(messages: BaseMessage[], target: CoachRaceTargetRef): boolean {
  const lookup = messages.findLast((message): message is ToolMessage => ToolMessage.isInstance(message) && message.name === RACE_CONTEXT_TOOL_NAME);
  if (!lookup || lookup.status === "error" || typeof lookup.content !== "string") return false;
  try {
    const result = raceContextAnchor.safeParse(JSON.parse(lookup.content));
    return result.success && result.data.race_event_id === target.race_event_id && result.data.target_item_type === target.item_type;
  } catch {
    return false;
  }
}

/** 从赛事入口取显式目标，普通聊天取线程里的最新绑定（含本轮重新选赛）。 */
export async function resolveRaceStrategyTarget(
  context: RaceTargetContext | undefined,
  raceTargets?: Pick<RaceTargetBindingGateway, "get"> | null,
): Promise<CoachRaceTargetRef | null> {
  if (context?.raceTargetFromThread !== true) {
    const parsed = CoachTargetRef.safeParse(context?.target);
    if (parsed.success) {
      const { kind, race_event_id, item_type } = parsed.data;
      if (kind === "race" && race_event_id != null && item_type != null) return { kind, race_event_id, item_type };
    }
  }
  const threadId = threadIdOf(context);
  return (threadId === null ? null : await raceTargets?.get(threadId)) ?? null;
}

function threadIdOf(context: RaceTargetContext | undefined): string | null {
  const threadId = context?.threadId;
  return typeof threadId === "string" && threadId.length > 0 ? threadId : null;
}

/** YYYY-MM-DD 的有界加天（候选日期窗用）。 */
function addDays(day: string, days: number): string {
  const parsed = new Date(`${day}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

class RaceStrategyContextTool {
  constructor(
    private readonly store: Pick<DataProvider, "getRaceCalendarContext" | "searchRaceCalendar">,
    private readonly raceTargets: RaceTargetBindingGateway | null,
  ) {}

  async getRaceCalendarContext(_input: z.infer<typeof getRaceCalendarContextSchema>, runtime: CoachToolRuntime) {
    const target = await resolveRaceStrategyTarget(runtime.context, this.raceTargets);
    if (target === null) return { bound: false as const };
    const raceEventId = target.race_event_id;
    const context = await this.store.getRaceCalendarContext(raceEventId);
    if (context === null) {
      return { race_event_id: raceEventId, found: false, reason: "race not found or unpublished" };
    }
    return { ...context, race_event_id: raceEventId, target_item_type: target.item_type, found: true };
  }

  async searchRaceTargets(input: z.infer<typeof searchRaceTargetsSchema>, runtime: CoachToolRuntime) {
    const asof = runtime.context?.asof;
    if (typeof asof !== "string" || asof.length === 0) throw new Error("search_race_targets: missing asof context");
    const rows = await this.store.searchRaceCalendar({
      asofDate: asof,
      ...(input.keyword !== undefined ? { keyword: input.keyword } : {}),
      ...(input.city !== undefined ? { city: input.city } : {}),
      dateFrom: input.date ?? asof,
      // 显式日期收窄到 ±窗口由实现层缺省（dateFrom+90d）接管；仅显式 date 才收紧。
      ...(input.date !== undefined ? { dateTo: addDays(input.date, 30) } : {}),
      ...(input.item_type !== undefined ? { itemType: input.item_type } : {}),
      limit: 8,
    });
    const candidates: RaceTargetCandidate[] = [];
    for (const row of rows) {
      for (const item of row.items) {
        if (input.item_type !== undefined && item.item_type !== input.item_type) continue;
        candidates.push({
          race_event_id: row.race_event_id,
          item_type: item.item_type,
          name: row.name_cn ?? row.name,
          race_date: row.race_date,
          city: row.city,
        });
      }
    }
    const threadId = threadIdOf(runtime.context);
    if (threadId !== null) {
      await this.raceTargets?.rememberCandidates(threadId, candidates);
    }
    return { candidates };
  }

  async bindRaceTarget(input: z.infer<typeof bindRaceTargetSchema>, runtime: CoachToolRuntime) {
    const threadId = threadIdOf(runtime.context);
    if (threadId === null) throw new Error("bind_race_target: missing thread context");
    const gateway = this.raceTargets;
    if (!gateway) throw new Error("bind_race_target: binding is not available");
    const candidates = (await gateway.candidates(threadId)) ?? [];
    const match = candidates.some((candidate) => candidate.race_event_id === input.race_event_id && candidate.item_type === input.item_type);
    // entry-gate 的模型侧体现：只能绑服务端检索给过的候选，防「模型塞别赛事进上下文」。
    if (!match) {
      throw new Error("bind_race_target: race_event_id/item_type 不在本会话候选集内，请先调用 search_race_targets");
    }
    await gateway.bind(threadId, { kind: "race", race_event_id: input.race_event_id, item_type: input.item_type });
    return { bound: true, race_event_id: input.race_event_id, item_type: input.item_type };
  }
}

/**
 * 一个有界只读工具：赛事内容聚合（赛道/难点/关门/补给站/城市）。策略代理各
 * 调用一次，禁止拿逐条活动替代。目标成绩不查数据——只来自运动员自己的消息
 * （目标定多少是运动员的决策，策略内容也不做能力分析）。
 */
export function createRaceStrategyContextTools(
  store: Pick<DataProvider, "getRaceCalendarContext" | "searchRaceCalendar">,
  raceTargets: RaceTargetBindingGateway | null = null,
): StructuredTool[] {
  const impl = new RaceStrategyContextTool(store, raceTargets);
  return defineCoachTools([
    {
      name: RACE_CONTEXT_TOOL_NAME,
      description:
        "获取当前会话目标赛事的内容聚合：基本信息、赛道文字、爬升、海拔剖面、难点、补给站、关门点与城市/气候背景（无输入参数，赛事取自会话 target）。" +
        "返回 bound=false 表示本会话尚未绑定赛事（聊天入口），此时改用 search_race_targets + bind_race_target 流程；" +
        "found=false 表示赛事不存在或未发布。",
      schema: getRaceCalendarContextSchema,
      handler: (input, runtime) => impl.getRaceCalendarContext(input, runtime),
    },
    {
      name: "search_race_targets",
      description:
        "按名称/日期/城市/项目检索已发布赛历，返回可绑定的候选赛事列表（#891 聊天入口）。" +
        "条件来自用户消息（如「南通马拉松」「11月8日」「半马」）；无任何线索时先用中文追问比赛是哪一场。",
      schema: searchRaceTargetsSchema,
      handler: (input, runtime) => impl.searchRaceTargets(input, runtime),
    },
    ...(raceTargets
      ? [
          {
            name: "bind_race_target",
            description:
              "把会话目标赛事绑定为指定候选（race_event_id + item_type 必须来自 search_race_targets 刚返回的候选）。" +
              "唯一候选时直接绑定；多候选须先由用户选定。绑定后 get_race_calendar_context 会直接读到本次绑定。",
            schema: bindRaceTargetSchema,
            handler: (input: z.infer<typeof bindRaceTargetSchema>, runtime: CoachToolRuntime) => impl.bindRaceTarget(input, runtime),
          },
        ]
      : []),
  ]);
}

const getRaceCalendarContextSchema = z.object({});

const searchRaceTargetsSchema = z.object({
  keyword: z.string().min(1).max(32).optional().describe("名称关键词（名称/中文名子串匹配），如「南通」"),
  city: z.string().min(1).max(16).optional().describe("城市精确匹配，如「南通市」"),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("比赛日期 YYYY-MM-DD（用户说「11月8日」时换算）"),
  item_type: z.string().min(1).max(32).optional().describe("项目类型 token，如 HalfMarathon / Marathon"),
});

const bindRaceTargetSchema = z.object({
  race_event_id: z.number().int().positive().describe("候选赛事的 race_event_id"),
  item_type: z.string().min(1).max(32).describe("候选赛事的项目类型 token（与候选项一致）"),
});
