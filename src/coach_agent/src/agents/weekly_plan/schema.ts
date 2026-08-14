import { z } from "zod/v4";

const DaySchema = z.iso.date();
const NullableNumberSchema = z.number().nullable();

const DurationSchema = z.object({
	kind: z.enum(["distance_m", "time_s", "open"]),
	value: NullableNumberSchema,
});

const TargetSchema = z.object({
	kind: z.enum(["pace_s_km", "hr_bpm", "power_w", "open"]),
	low: NullableNumberSchema,
	high: NullableNumberSchema,
});

const WorkoutStepSchema = z.object({
	step_kind: z.enum(["warmup", "work", "recovery", "cooldown", "rest"]),
	duration: DurationSchema,
	target: TargetSchema,
	note: z.string().nullable(),
	hr_cap_bpm: z.int().nullable(),
});

const RunWorkoutSchema = z.object({
	name: z.string().min(1),
	date: DaySchema,
	note: z.string().nullable(),
	blocks: z.array(
		z.object({
			repeat: z.int().positive(),
			steps: z.array(WorkoutStepSchema).min(1),
		}),
	),
});

const StrengthWorkoutSchema = z.object({
	name: z.string().min(1),
	date: DaySchema,
	note: z.string().nullable(),
	exercises: z.array(
		z.object({
			canonical_id: z.string().min(1),
			display_name: z.string().min(1),
			sets: z.int().positive(),
			target_kind: z.enum(["reps", "time_s"]),
			target_value: z.int().positive(),
			rest_seconds: z.int().nonnegative(),
			note: z.string().nullable(),
			provider_id: z.string().nullable(),
		}),
	),
});

const SessionFields = {
	date: DaySchema,
	session_index: z.int().nonnegative(),
	summary: z.string().min(1),
	notes_md: z.string().nullable(),
	total_distance_m: NullableNumberSchema,
	total_duration_s: NullableNumberSchema,
};

const PlannedSessionSchema = z.discriminatedUnion("kind", [
	z.object({
		...SessionFields,
		kind: z.literal("run"),
		spec: RunWorkoutSchema.nullable(),
	}),
	z.object({
		...SessionFields,
		kind: z.literal("strength"),
		spec: StrengthWorkoutSchema.nullable(),
	}),
	z.object({ ...SessionFields, kind: z.literal("rest"), spec: z.null() }),
	z.object({ ...SessionFields, kind: z.literal("cross"), spec: z.null() }),
	z.object({ ...SessionFields, kind: z.literal("note"), spec: z.null() }),
]);

const MealSchema = z.object({
	name: z.string().min(1),
	time_hint: z.string().nullable(),
	kcal: NullableNumberSchema,
	carbs_g: NullableNumberSchema,
	protein_g: NullableNumberSchema,
	fat_g: NullableNumberSchema,
	items_md: z.string().nullable(),
});

const PlannedNutritionSchema = z.object({
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
export const WeeklyPlanSchema = z.object({
	sessions: z.array(PlannedSessionSchema),
	nutrition: z.array(PlannedNutritionSchema),
	notes_md: z.string().nullable(),
	coach_notes: z.string().nullable(),
});

export type WeeklyPlan = z.infer<typeof WeeklyPlanSchema>;

export const WeeklyPlanDirectResponseSchema = z.object({
	disposition: z.literal("return_direct"),
	content: WeeklyPlanSchema,
});
