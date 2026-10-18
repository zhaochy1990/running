import { z } from "zod/v4";
import { addDays, mondayOnOrBefore, weekFolder } from "../date.js";
import { normalizeRunWorkout, RunWorkoutLenientSchema, RunWorkoutSchema, StrengthWorkoutSchema } from "../workout/schema.js";

const DaySchema = z.iso.date();
const NullableNumberSchema = z.number().nullable();

const SessionFields = {
  schema: z.literal("plan-session/v1"),
  date: DaySchema,
  session_index: z.int().nonnegative(),
  summary: z.string().min(1),
  notes_md: z.string().nullable(),
  total_distance_m: NullableNumberSchema,
  total_duration_s: NullableNumberSchema,
  estimated_dose: NullableNumberSchema,
};

const PlannedSessionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...SessionFields,
    kind: z.literal("run"),
    spec: RunWorkoutSchema.nullable(),
  }),
  z.strictObject({
    ...SessionFields,
    kind: z.literal("strength"),
    spec: StrengthWorkoutSchema.nullable(),
  }),
  z.strictObject({ ...SessionFields, kind: z.literal("rest"), spec: z.null() }),
  z.strictObject({
    ...SessionFields,
    kind: z.literal("cross"),
    spec: z.null(),
  }),
  z.strictObject({ ...SessionFields, kind: z.literal("note"), spec: z.null() }),
]);

const MealSchema = z.strictObject({
  name: z.string().min(1),
  time_hint: z.string().nullable(),
  kcal: NullableNumberSchema,
  carbs_g: NullableNumberSchema,
  protein_g: NullableNumberSchema,
  fat_g: NullableNumberSchema,
  items_md: z.string().nullable(),
});

const PlannedNutritionSchema = z.strictObject({
  schema: z.literal("plan-nutrition/v1"),
  date: DaySchema,
  kcal_target: NullableNumberSchema,
  carbs_g: NullableNumberSchema,
  protein_g: NullableNumberSchema,
  fat_g: NullableNumberSchema,
  water_ml: NullableNumberSchema,
  meals: z.array(MealSchema),
  notes_md: z.string().nullable(),
});

/** LLM 直出容忍层：非 strict 剥噪声键，notes 可省，run spec 走宽松 run-workout 层；不带跨字段规则（留在 strict 层）。 */
const SessionLenientFields = { ...SessionFields, notes_md: z.string().nullish() };

const PlannedSessionLenientSchema = z.discriminatedUnion("kind", [
  z.object({ ...SessionLenientFields, kind: z.literal("run"), spec: RunWorkoutLenientSchema.nullable() }),
  z.object({ ...SessionLenientFields, kind: z.literal("strength"), spec: StrengthWorkoutSchema.nullable() }),
  z.object({ ...SessionLenientFields, kind: z.literal("rest"), spec: z.null() }),
  z.object({ ...SessionLenientFields, kind: z.literal("cross"), spec: z.null() }),
  z.object({ ...SessionLenientFields, kind: z.literal("note"), spec: z.null() }),
]);

export const WeeklyPlanLenientSchema = z.object({
  schema: z.literal("weekly-plan/v1"),
  week_name: z.string().min(1),
  sessions: z.array(PlannedSessionLenientSchema),
  nutrition: z.array(PlannedNutritionSchema).length(7),
  notes_md: z.string().nullish(),
  coach_notes: z.string().nullish(),
});

/** lenient → strict：补 notes 默认、run spec 经 normalizeRunWorkout 填默认（含丢弃 LLM 补的 rest:null），再过硬校验。 */
export function normalizeWeeklyPlan(input: unknown): WeeklyPlan {
  const lenient = WeeklyPlanLenientSchema.parse(input);
  return WeeklyPlanSchema.parse({
    schema: lenient.schema,
    week_name: lenient.week_name,
    sessions: lenient.sessions.map((session) =>
      session.kind === "run" && session.spec !== null ? { ...session, spec: normalizeRunWorkout(session.spec) } : session,
    ),
    nutrition: lenient.nutrition,
    notes_md: lenient.notes_md ?? null,
    coach_notes: lenient.coach_notes ?? null,
  });
}

/** Canonical content_version=2 contract for generated weekly plans. */
export const WeeklyPlanSchema = z
  .strictObject({
    schema: z.literal("weekly-plan/v1"),
    week_name: z.string().min(1),
    sessions: z.array(PlannedSessionSchema),
    nutrition: z.array(PlannedNutritionSchema).length(7),
    notes_md: z.string().nullable(),
    coach_notes: z.string().nullable(),
  })
  .superRefine((plan, context) => {
    const weekStart = plan.week_name.slice(0, 10);
    let expectedFolder: string;
    try {
      expectedFolder = weekFolder(weekStart);
    } catch {
      context.addIssue({
        code: "custom",
        path: ["week_name"],
        message: "invalid week folder start",
      });
      return;
    }
    if (plan.week_name !== expectedFolder) {
      context.addIssue({
        code: "custom",
        path: ["week_name"],
        message: `expected ${expectedFolder}`,
      });
    }
    const weekEnd = addDays(weekStart, 6);
    if (!plan.sessions.some((session) => session.kind === "run")) {
      context.addIssue({
        code: "custom",
        path: ["sessions"],
        message: "weekly plan must contain at least one run session",
      });
    }
    if (mondayOnOrBefore(weekStart) !== weekStart) {
      context.addIssue({
        code: "custom",
        path: ["week_name"],
        message: "week must start on Monday",
      });
    }
    const sessionKeys = new Set<string>();
    for (const [index, session] of plan.sessions.entries()) {
      if (session.date < weekStart || session.date > weekEnd) {
        context.addIssue({
          code: "custom",
          path: ["sessions", index, "date"],
          message: "date is outside target week",
        });
      }
      const key = `${session.date}:${session.session_index}`;
      if (sessionKeys.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["sessions", index],
          message: "duplicate date and session_index",
        });
      }
      sessionKeys.add(key);
      if (session.spec !== null && session.spec.date !== session.date) {
        context.addIssue({
          code: "custom",
          path: ["sessions", index, "spec", "date"],
          message: "workout date must match session date",
        });
      }
    }
    const nutritionDates = new Set<string>();
    for (const [index, nutrition] of plan.nutrition.entries()) {
      if (nutrition.date < weekStart || nutrition.date > weekEnd) {
        context.addIssue({
          code: "custom",
          path: ["nutrition", index, "date"],
          message: "date is outside target week",
        });
      }
      if (nutritionDates.has(nutrition.date)) {
        context.addIssue({
          code: "custom",
          path: ["nutrition", index, "date"],
          message: "duplicate nutrition date",
        });
      }
      nutritionDates.add(nutrition.date);
    }
    for (let offset = 0; offset < 7; offset += 1) {
      const day = addDays(weekStart, offset);
      if (!nutritionDates.has(day)) {
        context.addIssue({
          code: "custom",
          path: ["nutrition"],
          message: `missing nutrition for ${day}`,
        });
      }
    }
  });

export type WeeklyPlan = z.infer<typeof WeeklyPlanSchema>;

export const WeeklyPlanGenerationSchema = z
  .strictObject({
    success: z.boolean(),
    // LLM 边界信封带宽松层（#611）：生成侧 toJsonSchema 不强逼模型填 note/hr_cap_bpm，
    // 消费侧先 normalizeWeeklyPlan 归一再过硬校验。
    weeklyPlan: WeeklyPlanLenientSchema.nullable(),
    error: z.string(),
  })
  .superRefine((result, context) => {
    if (result.success) {
      if (result.weeklyPlan === null) {
        context.addIssue({
          code: "custom",
          path: ["weeklyPlan"],
          message: "weeklyPlan must be set when success is true",
        });
      }
      if (result.error !== "") {
        context.addIssue({
          code: "custom",
          path: ["error"],
          message: "error must be empty when success is true",
        });
      }
    } else {
      if (result.weeklyPlan !== null) {
        context.addIssue({
          code: "custom",
          path: ["weeklyPlan"],
          message: "weeklyPlan must be null when success is false",
        });
      }
      if (result.error.trim() === "") {
        // 建议加上 trim，防止AI输出空格字符串
        context.addIssue({
          code: "custom",
          path: ["error"],
          message: "error must be non‑empty when success is false",
        });
      }
    }
  });

export const WeeklyPlanDirectResponseSchema = z.strictObject({
  disposition: z.literal("return_direct"),
  content: WeeklyPlanSchema,
});
