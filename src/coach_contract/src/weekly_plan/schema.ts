import { z } from "zod/v4";
import { addDays, mondayOnOrBefore, weekFolder } from "../date.js";

const DaySchema = z.iso.date();
const NullableNumberSchema = z.number().nullable();

const DurationSchema = z.strictObject({
  kind: z.enum(["distance_m", "time_s", "open"]),
  value: NullableNumberSchema,
});

const TargetSchema = z.strictObject({
  kind: z.enum(["pace_s_km", "hr_bpm", "power_w", "open"]),
  low: NullableNumberSchema,
  high: NullableNumberSchema,
});

const WorkoutStepSchema = z.strictObject({
  step_kind: z.enum(["warmup", "work", "recovery", "cooldown", "rest"]),
  duration: DurationSchema,
  target: TargetSchema,
  note: z.string().nullable(),
  hr_cap_bpm: z.int().nullable(),
});

const RunWorkoutSchema = z.strictObject({
  schema: z.literal("run-workout/v1"),
  name: z.string().min(1),
  date: DaySchema,
  note: z.string().nullable(),
  blocks: z
    .array(
      z.strictObject({
        repeat: z.int().positive(),
        steps: z.array(WorkoutStepSchema).min(1),
      }),
    )
    .min(1),
});

const StrengthWorkoutSchema = z.strictObject({
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
    weeklyPlan: WeeklyPlanSchema.nullable(),
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
      if (result.error.trim() === "") { // 建议加上 trim，防止AI输出空格字符串
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
