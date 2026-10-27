import { z } from "zod/v4";

/**
 * 「一次训练课」的唯一契约来源（weekly plan 与 master plan 共用）。
 *
 * 严格层（RunWorkoutSchema / StrengthWorkoutSchema）：内部生产者（TS 生成路径
 * normalize 之后）与已落库文档的 canonical 形状——duration/target 是判别联合，
 * 正数值与 null 严格互斥；step 的 note/hr_cap_bpm 必填（可为 null）。
 *
 * 宽松层（RunWorkoutLenientSchema + normalizeRunWorkout）：LLM 直出载荷——
 * 对象不 strict（剥掉模型多吐的噪声键）、note/hr_cap_bpm/schema 判别符可省略，
 * 经 normalizeRunWorkout() 补默认后必须能通过严格层。
 *
 * 版本策略：v1 内只追加可选字段（step.rest、target kind=power_w/cadence_spm、
 * workout type/purpose），不升 v2 —— 旧文档仍是合法 v1（见 docs/adr/0043）。
 */

const DaySchema = z.iso.date();

/** {kind: distance_m|time_s, value>0} | {kind: open, value: null} */
export const WorkoutDurationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["distance_m", "time_s"]), value: z.number().positive() }).strict(),
  z.object({ kind: z.literal("open"), value: z.null() }).strict(),
]);

/** {kind: pace_s_km|hr_bpm|power_w|cadence_spm, low>0, high>0} | {kind: open, low: null, high: null} */
export const WorkoutTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["pace_s_km", "hr_bpm", "power_w", "cadence_spm"]), low: z.number().positive(), high: z.number().positive() }).strict(),
  z.object({ kind: z.literal("open"), low: z.null(), high: z.null() }).strict(),
]);

/** 步后休息第一公民（COROS 借鉴）：time_s=固定秒数；hr_bpm=心率降到 value 以下继续；manual=手动结束（value=null）。 */
export const StepRestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["time_s", "hr_bpm"]), value: z.number().positive() }).strict(),
  z.object({ kind: z.literal("manual"), value: z.null() }).strict(),
]);

const StepKindSchema = z.enum(["warmup", "work", "recovery", "cooldown", "rest"]);

/**
 * 生成时声明的主刺激类型（devops#807，#796 拍板）：配速意义因人而异
 * （4:10/km 是高手有氧、另一个人的 M），意图显式供一致性校验与复盘消费；
 * LR=长跑位型课（E 配速为主，可嵌 work 尾段）。类型是意图声明而非合法性
 * 来源——合法性仍由谱内校验派生（配速/距离/时长事实）。
 */
export const RunWorkoutTypeSchema = z.enum(["E", "M", "T", "I", "R", "LR"]);
export type RunWorkoutType = z.infer<typeof RunWorkoutTypeSchema>;

const NO_REST_ON_REST_STEP = "a rest step must not carry a rest field";

/** 严格 step：note/hr_cap_bpm 必填可 null；rest 可选；step_kind='rest' 的步不得带 rest 字段。 */
export const WorkoutStepSchema = z
  .strictObject({
    step_kind: StepKindSchema,
    duration: WorkoutDurationSchema,
    target: WorkoutTargetSchema,
    note: z.string().nullable(),
    hr_cap_bpm: z.int().positive().nullable(),
    rest: StepRestSchema.optional(),
  })
  .superRefine((step, ctx) => {
    if (step.step_kind === "rest" && step.rest !== undefined) {
      ctx.addIssue({ code: "custom", path: ["rest"], message: NO_REST_ON_REST_STEP });
    }
  });

export const RunWorkoutSchema = z.strictObject({
  schema: z.literal("run-workout/v1"),
  name: z.string().min(1),
  date: DaySchema,
  note: z.string().nullable(),
  /** 主刺激类型（可选可 null，旧文档仍是合法 v1）；E/M/T/I/R=对应带的主刺激，LR=长跑位型课。 */
  type: RunWorkoutTypeSchema.nullish(),
  /** 训练说明：练什么、为什么、本节课在本周/本阶段的位置（给用户看也给复盘看）；新生成的课必填，存量缺省视为 legacy。 */
  purpose: z.string().nullish(),
  blocks: z
    .array(
      z.strictObject({
        repeat: z.int().positive(),
        steps: z.array(WorkoutStepSchema).min(1),
      }),
    )
    .min(1),
});

export const StrengthWorkoutSchema = z.strictObject({
  schema: z.literal("strength-workout/v1"),
  name: z.string().min(1),
  date: DaySchema,
  note: z.string().nullable(),
  exercises: z
    .array(
      z.strictObject({
        canonical_id: z.string().min(1),
        display_name: z.string().min(1),
        sets: z.int().positive(),
        target_kind: z.enum(["reps", "time_s"]),
        target_value: z.int().positive(),
        rest_seconds: z.int().nonnegative(),
        note: z.string().nullable(),
        provider_id: z
          .string()
          .regex(/^T\d+$/, "expected COROS T-code")
          .nullable(),
      }),
    )
    .min(1),
});

export type RunWorkout = z.infer<typeof RunWorkoutSchema>;
export type WorkoutStep = z.infer<typeof WorkoutStepSchema>;
export type WorkoutDuration = z.infer<typeof WorkoutDurationSchema>;
export type WorkoutTarget = z.infer<typeof WorkoutTargetSchema>;
export type StepRest = z.infer<typeof StepRestSchema>;
export type StrengthWorkout = z.infer<typeof StrengthWorkoutSchema>;

/** 宽松 step：note/hr_cap_bpm/schema 判别符可省略、rest 可省或 null（LLM 爱给 optional 字段补 null），未知键剥除；硬校验保留。 */
const RunWorkoutLenientStepSchema = z
  .object({
    step_kind: StepKindSchema,
    duration: WorkoutDurationSchema,
    target: WorkoutTargetSchema,
    note: z.string().nullish(),
    hr_cap_bpm: z.int().positive().nullish(),
    rest: StepRestSchema.nullish(),
  })
  .superRefine((step, ctx) => {
    if (step.step_kind === "rest" && step.rest != null) {
      ctx.addIssue({ code: "custom", path: ["rest"], message: NO_REST_ON_REST_STEP });
    }
  });

/** LLM 直出容忍层：补默认后必须能过 normalizeRunWorkout → RunWorkoutSchema。 */
export const RunWorkoutLenientSchema = z.object({
  schema: z.literal("run-workout/v1").optional(),
  name: z.string().min(1),
  date: DaySchema,
  note: z.string().nullish(),
  type: RunWorkoutTypeSchema.nullish(),
  purpose: z.string().nullish(),
  blocks: z
    .array(
      z.object({
        repeat: z.int().positive(),
        steps: z.array(RunWorkoutLenientStepSchema).min(1),
      }),
    )
    .min(1),
});

/** lenient → strict：补 note/hr_cap_bpm:null 与 schema 判别符等默认，再过硬校验。 */
export function normalizeRunWorkout(input: unknown): RunWorkout {
  const lenient = RunWorkoutLenientSchema.parse(input);
  return RunWorkoutSchema.parse({
    schema: "run-workout/v1",
    name: lenient.name,
    date: lenient.date,
    note: lenient.note ?? null,
    type: lenient.type ?? null,
    purpose: lenient.purpose ?? null,
    blocks: lenient.blocks.map((block) => ({
      repeat: block.repeat,
      steps: block.steps.map((step) => ({
        step_kind: step.step_kind,
        duration: step.duration,
        target: step.target,
        note: step.note ?? null,
        hr_cap_bpm: step.hr_cap_bpm ?? null,
        ...(step.rest != null ? { rest: step.rest } : {}),
      })),
    })),
  });
}
