import { z } from "zod/v4";

const identifier = z.string().min(1);

export const WeeklyPlanGeneratorRequest = z
	.object({
		request_id: identifier,
		name: z.string().min(1).default("world"),
		requested_as_of: z.string().datetime({ offset: true }).optional(),
	})
	.strict();
export type WeeklyPlanGeneratorRequest = z.infer<
	typeof WeeklyPlanGeneratorRequest
>;

export const WeeklyPlanGeneratorContext = z
	.object({
		userId: identifier,
		generationId: identifier,
	})
	.strict();
export type WeeklyPlanGeneratorContext = z.infer<
	typeof WeeklyPlanGeneratorContext
>;

export const WeeklyPlanGeneratorOutcome = z.discriminatedUnion("decision", [
	z
		.object({
			decision: z.literal("completed"),
			request_id: identifier,
			generation_id: identifier,
			greeting: z.string().min(1),
			shouted: z.boolean(),
		})
		.strict(),
	z
		.object({
			decision: z.literal("infrastructure_failure"),
			request_id: identifier,
			generation_id: identifier,
			reason: z.literal("context_snapshot_unavailable"),
		})
		.strict(),
]);
export type WeeklyPlanGeneratorOutcome = z.infer<
	typeof WeeklyPlanGeneratorOutcome
>;
