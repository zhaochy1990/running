import { buildModel, type PromptMessage } from "@stride/common";
import { normalizeRunWorkout, type RunWorkout, RunWorkoutTypeSchema, StepRestSchema, WorkoutDurationSchema, WorkoutTargetSchema } from "@stride/contract";
import { z } from "zod/v4";
import type { ModelConfig } from "../../../../config/config.js";
import { buildContentMessages, type ContentGeneratorInput, isRegeneration } from "./doctrine.js";
import { templateFallback, type WeekContentResult } from "./fallback.js";
import { type ContentValidation, validateWeekContent } from "./validators.js";

/**
 * L4 内容生成编排（devops#811，daniels-l4-content.md §5）：flash×1 整块（weeks
 * 数组一次调用，低温）→ normalize → C1-C9 校验 → 带违规清单重试 ≤2（L2 同款）
 * → 简版模板兜底（构造保证合法）。不含 kernel/weekly 接线（#803）。
 */

/** LLM 直出 draft（session 用 day 周内落位；date 由本层换算——L5 校验修复定最终日期）。 */
const StepDraftSchema = z.object({
  step_kind: z.enum(["warmup", "work", "recovery", "cooldown", "rest"]),
  duration: WorkoutDurationSchema,
  target: WorkoutTargetSchema,
  note: z.string().nullish(),
  hr_cap_bpm: z.number().int().positive().nullish(),
  rest: StepRestSchema.nullish(),
});
const BlockDraftSchema = z.object({ repeat: z.number().int().positive(), steps: z.array(StepDraftSchema).min(1) });
const SessionDraftSchema = z.object({
  day: z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]),
  name: z.string().min(1),
  type: RunWorkoutTypeSchema,
  purpose: z.string().min(1),
  note: z.string().nullish(),
  blocks: z.array(BlockDraftSchema).min(1),
});
export const ContentDraftSchema = z.object({
  weeks: z.array(z.object({ week_no: z.number().int().positive(), sessions: z.array(SessionDraftSchema).min(1) })).min(1),
});
export type ContentDraft = z.infer<typeof ContentDraftSchema>;

const DAY_INDEX: Record<ContentDraft["weeks"][number]["sessions"][number]["day"], number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

const dateOf = (planStartMonday: string, week: number, day: keyof typeof DAY_INDEX): string => {
  const d = new Date(`${planStartMonday}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (week - 1) * 7 + DAY_INDEX[day]);
  return d.toISOString().slice(0, 10);
};

export interface ContentModel {
  /** 生成层单次调用；retry 携带上次输出与违规清单（多轮修正）。 */
  invoke(input: ContentGeneratorInput, retry?: { previous: unknown; violations: string[] }): Promise<ContentDraft>;
}

/** 生产生成层模型：master_plan role 的 ModelConfig（deepseek-flash），低温 0.15（#810 同源拍板 0.1-0.2）。 */
export function createContentModel(config: ModelConfig): ContentModel {
  return {
    async invoke(input, retry) {
      const messages: PromptMessage[] = buildContentMessages(input, retry);
      const runnable = buildModel({
        ...config,
        temperature: 0.15,
        structured: { schema: ContentDraftSchema, name: "submit_weeks_content" },
      });
      return ContentDraftSchema.parse(await runnable.invoke(messages));
    },
  };
}

export interface ContentOutcome {
  weeks: WeekContentResult[];
  /** llm = 校验全绿；fallback = 重试耗尽/调用失败落模板。 */
  source: "llm" | "fallback";
  attempts: number;
  /** 逐周终检结果（与 weeks 对齐；fallback 为模板自身门检，构造保证全绿）。 */
  checks: ContentValidation[][];
}

/** 校验违规重试上限（≤2，加首次共 3 次尝试；调用/解析异常同计数——L2 同款）。 */
const MAX_CONTENT_RETRIES = 2;

/** draft → 逐周 RunWorkout（day→date 换算 + lenient→strict 归一）。 */
function normalizeDraft(draft: ContentDraft, input: ContentGeneratorInput): WeekContentResult[] {
  const rowOfWeek = new Map(input.rows.map((row) => [row.week, row]));
  return draft.weeks.map((week) => {
    const row = rowOfWeek.get(week.week_no);
    if (row == null) throw new Error(`第${week.week_no}周不在骨架内`);
    return {
      week: week.week_no,
      sessions: week.sessions.map((session) =>
        normalizeRunWorkout({
          name: session.name,
          date: dateOf(input.planStartMonday, week.week_no, session.day),
          type: session.type,
          purpose: session.purpose,
          note: session.note ?? null,
          blocks: session.blocks,
        }),
      ),
    };
  });
}

/** 逐周校验（draft 周序与骨架行对齐后跑全套 C1-C9）。 */
function validateWeeks(weeks: WeekContentResult[], input: ContentGeneratorInput): ContentValidation[][] {
  const rowOfWeek = new Map(input.rows.map((row) => [row.week, row]));
  return weeks.map(({ week, sessions }) => {
    const row = rowOfWeek.get(week)!;
    return validateWeekContent({
      sessions: sessions.map((workout) => ({ workout })),
      row: { total_km: row.totalKm, long_run_km: row.longRunKm, quality_sessions: row.qualitySessions },
      zones: row.zones,
      maxTrainingDays: input.athlete.weeklyRunDaysMax,
      ...(row.role === "race" ? { raceDate: input.race.date } : {}),
      ...(isRegeneration(row) ? { regeneration: true } : {}),
    });
  });
}

/**
 * 入口前置断言（fail fast，防兜底路径抛裸异常）：投影带完整（easy/m）、
 * 非 race 行 lr≠null、q≤2、赛周行网格含比赛日且比赛日 ≥周三（#825：周一/周二
 * 比赛的激活窗跨周不可表达）。L3+projectZones 正常产出恒满足；
 * ContentGeneratorInput 是 #803 的公开接入面，坏输入在门口给出可读错误。
 */
function assertInput(input: ContentGeneratorInput): void {
  if (input.rows.length === 0) throw new Error("generateWeekContent: rows 为空");
  const raceRow = input.rows.find((row) => row.role === "race") ?? null;
  if (raceRow != null) {
    const weekStart = new Date(`${input.planStartMonday}T00:00:00Z`).getTime() + (raceRow.week - 1) * 604800_000;
    const raceMs = new Date(`${input.race.date}T00:00:00Z`).getTime();
    if (raceMs < weekStart || raceMs > weekStart + 6 * 86400_000)
      throw new Error(`generateWeekContent: 比赛日 ${input.race.date} 不落在赛周（第${raceRow.week}周）网格内`);
    // #825：赛周 M 激活窗=赛前 2-3 天，须落在本周内（比赛日周三及以后）；周一/周二
    // 比赛的激活窗在上一周、周内模型不可表达（L3 无比赛日期不可先知）——fail fast
    // 逼上游处理，不静默产出 C3 结构性非法的课表
    const raceWd = (new Date(`${input.race.date}T00:00:00Z`).getUTCDay() + 6) % 7;
    if (raceWd < 2)
      throw new Error(`generateWeekContent: 比赛日 ${input.race.date} 落在周一/周二——赛前 2-3 天激活窗跨周，周内模型不可表达（上游须先解决跨周激活）`);
  }
  for (const row of input.rows) {
    if (row.zones.easy == null || row.zones.m == null) throw new Error(`generateWeekContent: 第${row.week}周 easy/m 投影带缺失`);
    if (row.role !== "race" && row.longRunKm == null) throw new Error(`generateWeekContent: 第${row.week}周非赛周但 lr=null`);
    if (row.qualitySessions > 2) throw new Error(`generateWeekContent: 第${row.week}周 q=${row.qualitySessions} 超域（L3 缺省 ∈{0,1,2}）`);
  }
}

/**
 * 生成入口（纯函数形态，无存储）：输入 L3 周骨架 + 每周投影带 + 运动员/比赛上下文，
 * 输出整段周课表。每次输出都过全部校验；重试耗尽或调用异常落模板兜底
 * （source 供调用方观测兜底率）。
 */
export async function generateWeekContent(input: ContentGeneratorInput, model: ContentModel): Promise<ContentOutcome> {
  assertInput(input);
  let attempts = 0;
  let lastDraft: unknown;
  let lastViolations: string[] = [];
  for (let round = 0; round <= MAX_CONTENT_RETRIES; round++) {
    attempts++;
    try {
      const draft = await model.invoke(input, round === 0 ? undefined : { previous: lastDraft, violations: lastViolations });
      const weeks = normalizeDraft(draft, input);
      const rowSet = new Set(input.rows.map((r) => r.week));
      const missing = [...rowSet].filter((w) => !weeks.some((x) => x.week === w));
      const checks = validateWeeks(weeks, input);
      const violations = [
        ...missing.map((w) => `第${w}周缺失（week_rows 每周都要输出）`),
        ...checks.flatMap((weekChecks, i) => weekChecks.filter((c) => !c.pass).map((c) => `第${weeks[i]!.week}周 ${c.id}：${c.detail}`)),
      ];
      if (violations.length === 0) return { weeks, source: "llm", attempts, checks };
      lastDraft = draft;
      lastViolations = violations;
    } catch (error) {
      lastViolations = [`模型调用或契约解析失败（${error instanceof Error ? error.message.slice(0, 200) : "unknown"}），请重新输出完整 weeks`];
    }
  }
  // 兜底永不静默吞错：断言已过而分配器仍抛（包络外输入）= 实现缺陷，显式上抛
  let weeks: WeekContentResult[];
  let checks: ContentValidation[][];
  try {
    weeks = templateFallback(input);
    checks = validateWeeks(weeks, input);
  } catch (error) {
    throw new Error(`L4 兜底构造失败（输入超出 L3 缺省包络）：${error instanceof Error ? error.message : String(error)}`);
  }
  return { weeks, source: "fallback", attempts, checks };
}
