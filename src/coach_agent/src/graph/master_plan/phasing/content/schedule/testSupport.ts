import { addDays, type RunWorkout } from "@stride/contract";
import type { ContentGeneratorInput, ContentWeekRow } from "../doctrine.js";
import { type ContentDraft, ContentDraftSchema, type ContentModel } from "../generate.js";
import { validateWeekContent } from "../validators.js";
import type { AvailabilityConstraints } from "./availability.js";
import { contextMetrics, type DistributionMetrics, factsOfWeek } from "./distribution.js";
import {
  type ESlotCourse,
  type PlannedCourse,
  type PmcState,
  type ScheduleContext,
  type StructuredCourse,
  scheduleWeek,
  type WeekBag,
  type WeekSchedule,
} from "./scheduler.js";

/**
 * 日期分布/排课可用度测试与回放共用件（与 load/testSupport.ts、content/testSupport.ts
 * 惯例一致）：devops#1043 票面「四跑周」样例的最小复现——长跑 20km + 阈值课
 * 6km + 两个 E 槽位，周量 55km；贪心落位恒为「E·T·休·休·休·E·LR」。
 */

export const ZONES = { easy: [288, 336], m: [249, 288], t: [235, 249], i: [218, 235], r: [null, 218] } as const;
export const PLAN_START_MONDAY = "2026-11-30";
/** 赛事日在样例批次之外（样例周不受赛周逻辑影响）。 */
export const RACE = { name: "测试马拉松", date: "2027-03-28", targetTime: "3:30:00", goalPaceSKm: 297 };
export const PMC_SEED = { acute: 33, chronic: 38 };

type TestStep = StructuredCourse["blocks"][number]["steps"][number];
const step = (stepKind: TestStep["step_kind"], duration: TestStep["duration"], target: TestStep["target"]): TestStep => ({
  step_kind: stepKind,
  duration,
  target,
  note: null,
  hr_cap_bpm: null,
});
const easy = { kind: "pace_s_km", low: ZONES.easy[0], high: ZONES.easy[1] } as const;
const tPace = { kind: "pace_s_km", low: 239, high: 245 } as const;
/** 长跑尾段配速：落在 M 带内才算质量段（判定表：质量谱=M 带慢端 +10s 以内）。 */
const mPaceTail = { kind: "pace_s_km", low: 250, high: 256 } as const;

/** 长跑课；qualityTailKm>0 时带 M 配速尾段（质量课，触发 P2 判定）。 */
export const lrCourse = (km: number, qualityTailKm = 0): StructuredCourse => ({
  kind: "course" as const,
  name: `长跑 ${km}km`,
  type: "LR" as const,
  purpose: "长跑课：E 配速积累耐力。",
  note: null,
  blocks: [
    {
      repeat: 1,
      steps: [
        step("work", { kind: "distance_m", value: Math.round((km - qualityTailKm) * 1000) }, easy),
        ...(qualityTailKm > 0 ? [step("work", { kind: "distance_m", value: qualityTailKm * 1000 }, mPaceTail)] : []),
      ],
    },
  ],
});

/** 阈值课：热身 15min + km@T + 放松 10min。 */
export const tCourse = (km: number): StructuredCourse => ({
  kind: "course" as const,
  name: `T ${km}km`,
  type: "T" as const,
  purpose: "阈值课：T 配速提升乳酸阈值。",
  note: null,
  blocks: [
    {
      repeat: 1,
      steps: [
        step("warmup", { kind: "time_s", value: 15 * 60 }, easy),
        step("work", { kind: "distance_m", value: km * 1000 }, tPace),
        step("cooldown", { kind: "time_s", value: 10 * 60 }, easy),
      ],
    },
  ],
});

export const eSlot = (band: "normal" | "interval" = "normal"): ESlotCourse => ({ kind: "e-slot" as const, band, strides: false, purpose: null });

/** 赛周课包：比赛课（42.2km，同 scheduler.test 的赛周行形态）+ 赛前 M 激活短课 + 两个赛前短 E 槽。 */
export const raceBag = (week: number, raceName = RACE.name): WeekBag => ({
  week,
  courses: [
    {
      kind: "course" as const,
      name: `${raceName} 42.2km`,
      type: "M" as const,
      purpose: "比赛课：按目标配速执行。",
      note: null,
      blocks: [{ repeat: 1, steps: [step("work", { kind: "distance_m", value: 42195 }, { kind: "pace_s_km", low: 237, high: 247 })] }],
    },
    {
      kind: "course" as const,
      name: "赛前激活 M 4km+strides",
      type: "M" as const,
      purpose: "赛前激活：M 配速触感。",
      note: null,
      blocks: [{ repeat: 1, steps: [step("warmup", { kind: "time_s", value: 900 }, easy), step("work", { kind: "distance_m", value: 4000 }, tPace)] }],
    },
    eSlot("interval"),
    eSlot("interval"),
  ],
});

/** 样例周行：transition_quality 进展周，55km / 长跑 20km / 1 节质量课。 */
export const normalRow = (week: number, overrides: Partial<ContentWeekRow> = {}): ContentWeekRow => ({
  week,
  phase: "transition_quality",
  role: "progress",
  totalKm: 55,
  longRunKm: 20,
  qualitySessions: 1,
  qualityFamily: "I/T（冬季以 T 为主）",
  zones: ZONES,
  ...overrides,
});

/** 赛周行：56km、无长跑、2 节质量课（比赛 + 激活）。 */
export const raceRow = (week: number): ContentWeekRow => normalRow(week, { role: "race", totalKm: 56, longRunKm: null, qualitySessions: 2 });

/** 票面样例课包：LR 20 + T 6 + 普通 E + 间隔 E（四跑周）。 */
export const fourRunBag = (week: number) => ({ week, courses: [lrCourse(20), tCourse(6), eSlot("normal"), eSlot("interval")] });

export const generatorInput = (rows: ContentWeekRow[], overrides: Partial<ContentGeneratorInput> = {}): ContentGeneratorInput => ({
  rows,
  athlete: { weeklyRunDaysMax: 4, weekKm: 55, fitness: { ctl: 38, atl: 33, form: 5 } },
  race: RACE,
  planStartMonday: PLAN_START_MONDAY,
  ...overrides,
});

/** 按周内位手工搭落位（键=周一..周日的下标）。 */
export const placementOf = (byWeekday: Record<number, PlannedCourse[]>): PlannedCourse[][] =>
  Array.from({ length: 7 }, (_, weekday) => byWeekday[weekday] ?? []);

/** 可用度约束（缺省只声明可跑日）。 */
export const availabilityOf = (availableWeekdays: number[], extra: Partial<AvailabilityConstraints> = {}): AvailabilityConstraints => ({
  availableWeekdays,
  maxSessionDurationMin: null,
  allowsDoubleSessions: null,
  ...extra,
});

/** 排位上下文：票面样例缺省（4 跑、种子 33/38、赛事在批次外）。 */
export const scheduleCtxOf = (rows: ContentWeekRow[], overrides: Partial<ScheduleContext> = {}): ScheduleContext => ({
  rows,
  planStartMonday: PLAN_START_MONDAY,
  race: RACE,
  athlete: { weeklyRunDaysMax: 4 },
  pmcSeed: PMC_SEED,
  ...overrides,
});

/** 课的跑步时长（分钟，time 步直读）——E 时长上限核对用。 */
export const runMinutesOf = (workout: RunWorkout): number =>
  workout.blocks.reduce(
    (total, block) =>
      total + block.repeat * block.steps.reduce((sum, st) => sum + (st.step_kind === "work" && st.duration.kind === "time_s" ? st.duration.value / 60 : 0), 0),
    0,
  );

/** 固定课包当模型输出（零 LLM，走真实编排+排位+门禁）。 */
export const draftOf = (bags: WeekBag[]): ContentDraft =>
  ContentDraftSchema.parse({
    weeks: bags.map(({ week, courses }) => ({
      week_no: week,
      courses: courses.map((course) =>
        course.kind === "e-slot"
          ? { type: "E", band: course.band, strides: course.strides }
          : { name: course.name, type: course.type, purpose: course.purpose, note: course.note, blocks: course.blocks },
      ),
    })),
  });
export const modelOf = (bags: WeekBag[]): ContentModel => ({ invoke: async () => draftOf(bags) });

/** 周课的排位后课程校验（generate.ts 终检同口径）——对照日历的独立验证用。 */
export const cChecksOf = (row: ContentWeekRow, sessions: RunWorkout[], maxTrainingDays = 4) =>
  validateWeekContent({
    sessions: sessions.map((workout) => ({ workout })),
    row: { total_km: row.totalKm, long_run_km: row.longRunKm, quality_sessions: row.qualitySessions, role: row.role },
    zones: row.zones,
    maxTrainingDays,
    goalPaceSKm: RACE.goalPaceSKm,
    finalQuality: row.phase === "final_quality",
    ...(row.role === "race" ? { raceDate: RACE.date } : {}),
    ...(row.phase === "recovery" ? { regeneration: true } : {}),
  });

/**
 * 整批逐周贪心（不做分布比较）——原排法的独立构造（#1043 之前的排位形态）。
 * 周一锚取 PLAN_START_MONDAY；任一周不过门即抛（调用方只对可行的原排法做对照）。
 */
export function greedyBatch(bags: WeekBag[], ctx: Pick<ScheduleContext, "rows" | "race" | "athlete" | "pmcSeed">): WeekSchedule[] {
  const weeks: WeekSchedule[] = [];
  let pmc: PmcState = ctx.pmcSeed;
  for (const bag of bags) {
    const row = ctx.rows.find((candidate) => candidate.week === bag.week)!;
    const result = scheduleWeek(bag, row, { weekMonday: addDays(PLAN_START_MONDAY, (bag.week - 1) * 7), race: ctx.race, athlete: ctx.athlete }, pmc);
    if (!("schedule" in result)) throw new Error(`原排法不可行：${result.failures.join(";")}`);
    pmc = result.pmc;
    weeks.push(result.schedule);
  }
  return weeks;
}

/** 整批日历里某一周的完整跨周指标（前接上一周、后接下一周）。 */
export function completeMetricsOf(weeks: WeekSchedule[], index: number): DistributionMetrics {
  const facts = (at: number) => factsOfWeek(weeks[at]!, ZONES, null);
  return contextMetrics(index > 0 ? facts(index - 1) : [], facts(index), weeks[index + 1] == null ? null : facts(index + 1));
}
