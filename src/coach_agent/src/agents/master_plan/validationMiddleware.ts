import { HumanMessage } from "@langchain/core/messages";
import { MasterPlanDirectResponseSchema } from "@stride/contract";
import { createMiddleware } from "langchain";
import { z } from "zod/v4";

const MAX_VALIDATION_RETRIES = 2;

const ValidationStateSchema = z.object({
	_masterPlanValidationRetries: z.int().nonnegative().default(0),
});

/** Enforce Zod cross-field refinements that provider JSON Schema cannot express. */
export function createMasterPlanValidationMiddleware() {
	return createMiddleware({
		name: "MasterPlanValidationMiddleware",
		stateSchema: ValidationStateSchema,
		beforeAgent: () => ({ _masterPlanValidationRetries: 0 }),
		afterModel: {
			canJumpTo: ["model"],
			hook: (state) => {
				if (state.structuredResponse === undefined) return;
				const parsed = MasterPlanDirectResponseSchema.safeParse(
					state.structuredResponse,
				);
				if (parsed.success) return;

				const issues = formatIssues(parsed.error.issues);
				if (state._masterPlanValidationRetries >= MAX_VALIDATION_RETRIES)
					throw new Error(
						`Master plan failed canonical validation after ${MAX_VALIDATION_RETRIES + 1} attempts: ${issues}`,
					);

				return {
					_masterPlanValidationRetries: state._masterPlanValidationRetries + 1,
					messages: [
						new HumanMessage(
							`The proposed Master Plan failed canonical cross-field validation. Correct every issue and return the complete response again. Do not omit unchanged fields. Issues: ${issues}`,
						),
					],
					jumpTo: "model" as const,
				};
			},
		},
	});
}

function formatIssues(issues: z.core.$ZodIssue[]): string {
	return issues
		.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
		.join("; ");
}
