import { buildModel, type PromptMessage } from "@stride/common";
import { normalizeRunWorkout, type RunWorkout, RunWorkoutTypeSchema, StepRestSchema, WorkoutDurationSchema, WorkoutTargetSchema } from "@stride/contract";
import { z } from "zod/v4";
import type { ModelConfig } from "../../../../config/config.js";
import { buildContentMessages, type ContentGeneratorInput, type ContentWeekRow, easyMid, isRegeneration } from "./doctrine.js";
import { templateFallback } from "./fallback.js";
import { DEFAULT_DOSE_COEFFICIENTS, type DoseCoefficients } from "./schedule/dose.js";
import type { ScheduleCheck } from "./schedule/gates.js";
import { type CalendarDay, type LoadMeta, type LoadSeriesPoint, type PmcState, scheduleWeeks, type WeekBag } from "./schedule/scheduler.js";
import { type ContentValidation, E_DURATION_INTERVAL_BAND, E_DURATION_NORMAL_BAND, validateWeekContent } from "./validators.js";

/**
 * L4 内容与排位层编排（devops#799 两段制：L4a 内容生成 flash×1 + L4b 波浪排位
 * 纯代码，daniels-l4-content.md §5-§6）：draft（课包：无 day、E=槽位+时长带）
 * → normalize → 课包校验（C2/C3/C5-C8 + C1 带可行性；C4/C9 归排位段）→ L4b
 * 排位（P 门 + load_series）→ 全量终检（C1-C9 落位后按日判定）→ 带违规清单
 * 重试 ≤2（L2 同款；排位无解=课包问题，同环重生成 L4a——层内仲裁在 L4b 内
 * 先行确定性修复，本环绝不因排位失败跳过修复直触 LLM）→ 模板兜底课包+排位
 * （构造保证合法）。不含 kernel/weekly 接线（#803）。
 */

/** LLM 直出 draft（结构课无 day；E=槽位+时长带——落位与分钟归 L4b）。 */
const StepDraftSchema = z.object({
  step_kind: z.enum(["warmup", "work", "recovery", "cooldown", "rest"]),
  duration: WorkoutDurationSchema,
  target: WorkoutTargetSchema,
  note: z.string().nullish(),
  hr_cap_bpm: z.number().int().positive().nullish(),
  rest: StepRestSchema.nullish(),
});
const BlockDraftSchema = z.object({ repeat: z.number().int().positive(), steps: z.array(StepDraftSchema).min(1) });
const StructuredDraftSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["M", "T", "I", "R", "LR"]),
  purpose: z.string().min(1),
  note: z.string().nullish(),
  blocks: z.array(BlockDraftSchema).min(1),
});
/** E 槽位：不收 purpose（#824 拍板）——模型自写会与实际落位错位，说明统一由 L4b ePurpose 按位置生成；多余字段 schema 静默剥除。 */
const ESlotDraftSchema = z.object({
  type: z.literal("E"),
  band: z.enum(["normal", "interval"]),
  strides: z.boolean().nullish(),
});
const SessionDraftSchema = z.union([StructuredDraftSchema, ESlotDraftSchema]);
export const ContentDraftSchema = z.object({
  weeks: z.array(z.object({ week_no: z.number().int().positive(), courses: z.array(SessionDraftSchema).min(1) })).min(1),
});
export type ContentDraft = z.infer<typeof ContentDraftSchema>;

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

/** 单次失败尝试的可观测性记录（#822，#814 Phase 1）：校验违规逐条；解析/调用失败走 parseError。 */
export interface ContentAttemptDetail {
  violations: string[];
  parseError?: string;
}

/** 两段制产物：课包排位后的最终日历（sessions=带日期 v1 课）+ 波浪序列 + 全部门。 */
export interface ScheduledOutcome {
  weeks: Array<{ week: number; sessions: RunWorkout[] }>;
  calendar: CalendarDay[];
  loadSeries: LoadSeriesPoint[];
  loadMeta: LoadMeta;
  /** 逐周终检（排位后全量 C1-C9）。 */
  checks: ContentValidation[][];
  /** 逐周排位门（P1-P7）。 */
  scheduleChecks: ScheduleCheck[][];
  repairs: string[];
  /** llm = 校验全绿；fallback = 重试耗尽/调用失败落模板。 */
  source: "llm" | "fallback";
  attempts: number;
  /** 逐次失败尝试明细，仅失败尝试入列：首过=空；llm 重试后过=失败次数条；fallback=3 条。 */
  attemptsDetail: ContentAttemptDetail[];
}

/** 校验违规重试上限（≤2，加首次共 3 次尝试；调用/解析异常同计数——L2 同款）。 */
const MAX_CONTENT_RETRIES = 2;

/** draft → 逐周课包（结构课直映、nullish 归一为 null；E 槽位归一）。 */
function normalizeDraft(draft: ContentDraft, input: ContentGeneratorInput): WeekBag[] {
  const rowOfWeek = new Map(input.rows.map((row) => [row.week, row]));
  return draft.weeks.map((week) => {
    const row = rowOfWeek.get(week.week_no);
    if (row == null) throw new Error(`第${week.week_no}周不在骨架内`);
    return {
      week: week.week_no,
      courses: week.courses.map((course): WeekBag["courses"][number] =>
        course.type === "E"
          ? { kind: "e-slot", band: course.band, strides: course.strides ?? false, purpose: null }
          : {
              kind: "course",
              name: course.name,
              type: course.type,
              purpose: course.purpose,
              note: course.note ?? null,
              blocks: course.blocks.map((block) => ({
                repeat: block.repeat,
                steps: block.steps.map((st) => ({ ...st, note: st.note ?? null, hr_cap_bpm: st.hr_cap_bpm ?? null, rest: st.rest ?? undefined })),
              })),
            },
      ),
    };
  });
}

/**
 * 课包阶段校验（导出供测试与 R0 复用）：结构课物化到占位日期（赛周比赛课=
 * 最大里程者物化到比赛日——罩带/C7 豁免锚），E 槽位以 km 带区间参与 C1 可行性。
 */
export function validateWeekBag(bag: WeekBag, row: ContentWeekRow, input: ContentGeneratorInput): ContentValidation[] {
  return validateWeekContent(bagValidationInput(bag, row, input));
}

/** 课包阶段校验输入：结构课物化到占位日期（赛周比赛课=最大里程者物化到比赛日——罩带/C7 豁免锚）。 */
function bagValidationInput(bag: WeekBag, row: ContentWeekRow, input: ContentGeneratorInput) {
  const weekMonday = new Date(`${input.planStartMonday}T00:00:00Z`);
  const monday = new Date(weekMonday.getTime() + (row.week - 1) * 604800_000).toISOString().slice(0, 10);
  const structured = bag.courses.filter((c): c is Extract<typeof c, { kind: "course" }> => c.kind === "course");
  const dated = structured.map((course) => {
    const workout = normalizeRunWorkout({
      name: course.name,
      date: monday,
      type: course.type,
      purpose: course.purpose,
      note: course.note,
      blocks: course.blocks,
    });
    return { course, workout };
  });
  // 赛周比赛课=最大里程结构课（与 L4b placeRaceWeek 同判据）——物化到比赛日
  if (row.role === "race") {
    const byKm = [...dated].sort(
      (a, b) =>
        (b.workout.blocks.reduce((s, b2) => s + b2.steps.reduce((t, st) => t + (st.duration.kind === "distance_m" ? st.duration.value : 0), 0), 0) ?? 0) -
        (a.workout.blocks.reduce((s, b2) => s + b2.steps.reduce((t, st) => t + (st.duration.kind === "distance_m" ? st.duration.value : 0), 0), 0) ?? 0),
    );
    if (byKm[0] != null) byKm[0].workout = normalizeRunWorkout({ ...byKm[0].workout, date: input.race.date });
  }
  const eMid = easyMid(row);
  const kmOfMin = (m: number) => (eMid != null ? (m * 60) / eMid : 0);
  const eSlotKmRanges = bag.courses
    .filter((c): c is Extract<typeof c, { kind: "e-slot" }> => c.kind === "e-slot")
    .map(() => {
      // 赛周 E 槽=赛前激活窗 shake（C9 豁免下限，「短」激活可 0-60min）；
      // 常规周取落位带全并集 [30,90]min（最终带按位置定——声明带只是落位倾向，
      // 可行性取两带并集防课包阶段与排位实际容量劈叉；终值由排位后终检钉）
      if (row.role === "race") return [0, kmOfMin(E_DURATION_INTERVAL_BAND[1])] as [number, number];
      return [kmOfMin(E_DURATION_INTERVAL_BAND[0]), kmOfMin(E_DURATION_NORMAL_BAND[1])] as [number, number];
    });
  return {
    sessions: dated.map(({ workout }) => ({ workout })),
    row: { total_km: row.totalKm, long_run_km: row.longRunKm, quality_sessions: row.qualitySessions },
    zones: row.zones,
    maxTrainingDays: input.athlete.weeklyRunDaysMax,
    ...(row.role === "race" ? { raceDate: input.race.date } : {}),
    ...(isRegeneration(row) ? { regeneration: true } : {}),
    bagStage: { eSlotKmRanges },
  };
}

/** 排位后全量校验（真实日期+E 实例化——C1/C4/C9 按日判定）。 */
function finalValidation(weeks: Array<{ week: number; sessions: RunWorkout[] }>, input: ContentGeneratorInput): ContentValidation[][] {
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

/** L4b 排位上下文（PMC 种子=athlete.fitness 生产快照直读）。 */
function scheduleContextOf(input: ContentGeneratorInput, coefficients: DoseCoefficients) {
  return {
    rows: input.rows,
    planStartMonday: input.planStartMonday,
    race: input.race,
    athlete: { weeklyRunDaysMax: input.athlete.weeklyRunDaysMax },
    pmcSeed: { acute: input.athlete.fitness.atl, chronic: input.athlete.fitness.ctl } satisfies PmcState,
    coefficients,
  };
}

/** 课包 → 排位+终检（课包违规 ∪ 排位无解 ∪ 终检违规；全绿返回产物）。 */
function runSchedule(
  bags: WeekBag[],
  input: ContentGeneratorInput,
  coefficients: DoseCoefficients,
): { violations: string[]; scheduleFailures: string[]; outcome?: Omit<ScheduledOutcome, "source" | "attempts" | "attemptsDetail"> } {
  const bagChecks = bags.map((bag) => {
    const row = input.rows.find((r) => r.week === bag.week)!;
    return validateWeekContent(bagValidationInput(bag, row, input));
  });
  const bagViolations = bagChecks.flatMap((weekChecks, i) => weekChecks.filter((c) => !c.pass).map((c) => `第${bags[i]!.week}周 ${c.id}：${c.detail}`));
  const scheduled = scheduleWeeks(bags, scheduleContextOf(input, coefficients));
  if (!scheduled.ok) return { violations: [...bagViolations, ...scheduled.failures], scheduleFailures: scheduled.failures };

  const weeks = scheduled.weeks.map(({ week, sessions }) => ({ week, sessions }));
  const finalChecks = finalValidation(weeks, input);
  const finalViolations = finalChecks.flatMap((weekChecks, i) => weekChecks.filter((c) => !c.pass).map((c) => `第${weeks[i]!.week}周 ${c.id}：${c.detail}`));
  const violations = [...bagViolations, ...finalViolations];
  if (violations.length > 0) return { violations, scheduleFailures: [] };
  return {
    violations: [],
    scheduleFailures: [],
    outcome: {
      weeks,
      calendar: scheduled.weeks.flatMap((w) => w.calendar),
      loadSeries: scheduled.weeks.flatMap((w) => w.loadSeries),
      loadMeta: scheduled.loadMeta,
      checks: finalChecks,
      scheduleChecks: scheduled.weeks.map((w) => w.checks),
      repairs: scheduled.weeks.flatMap((w) => w.repairs),
    },
  };
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
 * 输出排位后的整段日历与负荷序列（课包→排位两段在内部编排）。每次输出都过
 * 课包校验+排位门+落位终检；重试耗尽或调用异常落模板兜底（source 供调用方
 * 观测兜底率）。
 */
export async function generateWeekContent(
  input: ContentGeneratorInput,
  model: ContentModel,
  options?: { coefficients?: DoseCoefficients },
): Promise<ScheduledOutcome> {
  assertInput(input);
  const coefficients = options?.coefficients ?? DEFAULT_DOSE_COEFFICIENTS;
  let attempts = 0;
  let lastDraft: unknown;
  let lastViolations: string[] = [];
  const attemptsDetail: ContentAttemptDetail[] = [];
  for (let round = 0; round <= MAX_CONTENT_RETRIES; round++) {
    attempts++;
    try {
      const draft = await model.invoke(input, round === 0 ? undefined : { previous: lastDraft, violations: lastViolations });
      const bags = normalizeDraft(draft, input);
      const rowSet = new Set(input.rows.map((r) => r.week));
      const missing = [...rowSet].filter((w) => !bags.some((x) => x.week === w));
      const dupWeeks = bags.map((x) => x.week).filter((w, i, arr) => arr.indexOf(w) !== i);
      const { violations, outcome } = runSchedule(bags, input, coefficients);
      const all = [...missing.map((w) => `第${w}周缺失（week_rows 每周都要输出）`), ...[...new Set(dupWeeks)].map((w) => `第${w}周重复输出`), ...violations];
      if (all.length === 0 && outcome != null) return { ...outcome, source: "llm", attempts, attemptsDetail };
      lastDraft = draft;
      lastViolations = all;
      // 拷贝隔离：重试载荷数组与落盘明细互不串改（模型端只读，此处防未来包装器污染）
      attemptsDetail.push({ violations: lastViolations.slice() });
    } catch (error) {
      const parseError = error instanceof Error ? error.message.slice(0, 200) : "unknown";
      lastViolations = [`模型调用或契约解析失败（${parseError}），请重新输出完整 weeks`];
      attemptsDetail.push({ violations: [], parseError });
    }
  }
  // 兜底永不静默吞错，两类失败分开定性：
  // ① 模板课包挂 C 门/构造抛错=实现缺陷（兜底必须永远合法）；② 课包合法但排位
  // 无解（P6 波形 cap 等）=输入超排位包络的结构性无解——显式上浮给调用方
  // （#803 接线侧决策：压 L3 周量或调种子），不当缺陷吞掉也不静默降级
  let bags: WeekBag[];
  try {
    bags = templateFallback(input);
  } catch (error) {
    throw new Error(`L4 兜底构造失败（输入超出 L3 缺省包络）：${error instanceof Error ? error.message : String(error)}`);
  }
  const bagViolations = bags.flatMap((bag) => {
    const row = input.rows.find((r) => r.week === bag.week)!;
    return validateWeekBag(bag, row, input)
      .filter((c) => !c.pass)
      .map((c) => `第${bag.week}周 ${c.id}：${c.detail}`);
  });
  if (bagViolations.length > 0) {
    throw new Error(`L4 兜底产物挂门（实现缺陷）：${bagViolations.join(";")}`);
  }
  const { violations, outcome, scheduleFailures } = runSchedule(bags, input, coefficients);
  if (outcome == null || violations.length > 0) {
    if (scheduleFailures.length > 0) {
      throw new Error(`L4 结构性无解（输入超排位包络，P 门上浮）：${scheduleFailures.join(";")}`);
    }
    throw new Error(`L4 兜底产物挂门（实现缺陷）：${violations.join(";")}`);
  }
  return { ...outcome, source: "fallback", attempts, attemptsDetail };
}
